import "server-only";

import { GIT_PROJECT_CODES } from "@/lib/security/git-project-naming";

export const PRIVATE_GIT_OBJECT_LIMITS = Object.freeze({
  commits: 16, objects: 128, totalBytes: 1024 * 1024, objectBytes: 256 * 1024,
  outputBytes: 2 * 1024 * 1024, treeEntries: 512, depth: 32, pathBytes: 4096,
  processMemoryBytes: 256 * 1024 * 1024,
});

export const PRIVATE_GIT_LIMITS = Object.freeze({
  seconds: 30,
  outputBytes: 256 * 1024,
  requestBytes: 32 * 1024,
  pathBytes: 4096,
  paths: 64,
  scannedEntries: 50_000,
  historyCommits: 1000,
});

/**
 * Fixed Git helper for an isolated registered sandbox. A bounded JSON metadata
 * frame arrives on stdin; argv never contains credentials or source contents.
 * Git is invoked using fixed argv, a fresh environment and no shell. This is
 * deliberately restrictive: worktrees with links, attributes, submodules,
 * alternate object stores, extensions or unsupported config fail closed.
 *
 * This helper is NOT a sandbox. A hostile same-UID process can race filesystem
 * checks or interfere with Git. Provider isolation and the separate hardcoded
 * private Git release restriction are still required. SIGKILL or provider loss
 * can leave an ambiguous mutation outcome; never retry automatically.
 */
export const PRIVATE_GIT_PROGRAM = String.raw`
import base64,fcntl,hashlib,json,os,re,resource,selectors,shutil,signal,stat,subprocess,sys,tempfile,time
MAX_SECONDS=30
MAX_OUTPUT=262144
MAX_REQUEST=32768
MAX_PATH=4096
MAX_PATHS=64
MAX_ENTRIES=50000
MAX_HISTORY_COMMITS=1000
MAX_EXPORT_COMMITS=16
MAX_EXPORT_OBJECTS=128
MAX_EXPORT_TOTAL=1048576
MAX_EXPORT_OBJECT=262144
MAX_EXPORT_OUTPUT=2097152
MAX_EXPORT_ENTRIES=512
MAX_EXPORT_DEPTH=32
MAX_EXPORT_PROCESS_MEMORY=268435456
PROJECT_CODES=${JSON.stringify(GIT_PROJECT_CODES)}
ROOT="repo"
PREFIX="CR8OR-GIT/1 "
TRUSTED_OWNER_UIDS=(0,)
HASH_RE=re.compile(r"(?:[0-9a-f]{40}|[0-9a-f]{64})\Z")
INDEX_RE=re.compile(r"[0-9a-f]{64}\Z")
REPOSITORY_RE=re.compile(r"https://github\.com/([A-Za-z0-9][A-Za-z0-9-]{0,38})/([A-Za-z0-9_.-]{1,100})(?:\.git)?\Z",re.I)
CATEGORIES={"General maintenance","Code improvements","Documentation updates","Test improvements","Configuration updates"}
READS={"status","branch","changes","diff","log","remote"}
WRITES={"stage","unstage","commit"}
child=None
root_fd=None
parent_fd=None
git_fd=None
lock_fd=None
temporary=None
stopped=False
mutating=False
termination_uncertain=False
deadline=time.monotonic()+MAX_SECONDS
class Rejected(Exception): pass
class Limited(Exception): pass
class Conflict(Exception): pass
class Cancelled(Exception): pass
class Busy(Exception): pass
def stop(signum,frame):
    global stopped
    stopped=True
def check_time():
    if stopped: raise Cancelled()
    if time.monotonic()>=deadline: raise Limited()
def emit(value):
    sys.stdout.write(PREFIX+value+"\n")
    sys.stdout.flush()
def read_frame(maximum):
    selector=selectors.DefaultSelector()
    selector.register(0,selectors.EVENT_READ)
    wire=bytearray()
    try:
        while b"\n" not in wire:
            check_time()
            if not selector.select(0.02): continue
            chunk=os.read(0,min(4096,maximum+1-len(wire)))
            if not chunk: raise Cancelled()
            wire.extend(chunk)
            if len(wire)>maximum: raise Limited()
    finally: selector.close()
    if wire.count(b"\n")!=1 or not wire.endswith(b"\n"): raise Rejected()
    return bytes(wire[:-1])
def plain(value,maximum=4096):
    return isinstance(value,str) and len(value.encode("utf-8"))<=maximum and not any(ord(c)<32 or ord(c)==127 for c in value)
def valid_ref(value):
    return plain(value,255) and bool(value) and not value.startswith(("-","/",".")) and not value.endswith(("/",".",".lock")) and not any(t in value for t in ("..","@{","//","\\"," ","~","^",":","?","*","[")) and all(p and not p.startswith(".") and not p.endswith(".lock") for p in value.split("/")) and value!="@"
def safe_path(value):
    if not plain(value,MAX_PATH) or not value or value.startswith(("/","-",":")) or "\\" in value: raise Rejected()
    parts=value.split("/")
    for part in parts:
        lowered=part.lower()
        if part in ("",".","..") or len(part.encode("utf-8"))>255 or lowered in (".git",".gitmodules",".gitattributes",".npmrc",".netrc",".ssh","credentials","credential","secrets","secret","id_rsa","id_ed25519") or (lowered.startswith(".env") and lowered!=".env.example") or lowered.endswith((".pem",".key")):
            raise Rejected()
    return value
def canonical_repository(value):
    if not plain(value,256): raise Rejected()
    match=REPOSITORY_RE.fullmatch(value)
    if match is None: raise Rejected()
    owner,name=match.groups()
    if name.endswith(".git"): name=name[:-4]
    if not name or name in (".",".."): raise Rejected()
    return "https://github.com/"+owner.lower()+"/"+name.lower()+".git"
def safe_regular(parent,name,maximum=None):
    descriptor=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=parent)
    try:
        info=os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or (maximum is not None and info.st_size>maximum): raise Rejected()
        if maximum is None: return None
        content=os.read(descriptor,maximum+1)
        if len(content)>maximum: raise Limited()
        return content
    finally:
        os.close(descriptor)
def scan_directory(descriptor,metadata=False,prefix="",counter=None):
    if counter is None: counter=[0]
    with os.scandir(descriptor) as entries:
        for entry in entries:
            check_time()
            counter[0]+=1
            if counter[0]>MAX_ENTRIES: raise Limited()
            name=entry.name
            relative=prefix+name
            if not metadata and not prefix and name==".git": continue
            if not plain(name,255) or "/" in name: raise Rejected()
            info=entry.stat(follow_symlinks=False)
            if stat.S_ISLNK(info.st_mode) or (stat.S_ISREG(info.st_mode) and info.st_nlink!=1): raise Rejected()
            if not stat.S_ISDIR(info.st_mode) and not stat.S_ISREG(info.st_mode): raise Rejected()
            if metadata and (relative in ("objects/info/alternates","objects/info/http-alternates","info/grafts","config.worktree","commondir","gitdir","shallow","info/attributes") or relative.startswith("refs/replace")): raise Rejected()
            if not metadata and name.lower() in (".git",".gitattributes",".gitmodules"): raise Rejected()
            if stat.S_ISDIR(info.st_mode):
                child_fd=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=descriptor)
                try: scan_directory(child_fd,metadata,relative+"/",counter)
                finally: os.close(child_fd)
def config_repository(expected):
    content=safe_regular(git_fd,"config",65536).decode("utf-8")
    section=None
    seen=set()
    repository=None
    for raw in content.splitlines():
        line=raw.strip()
        if not line or line.startswith(("#",";")): continue
        if line.startswith("["):
            if line=="[core]": section=("core",None)
            elif line=='[remote "origin"]': section=("remote",None)
            else:
                match=re.fullmatch(r'\[branch "([^"]+)"\]',line)
                if match is None or not valid_ref(match.group(1)): raise Rejected()
                section=("branch",match.group(1))
            continue
        match=re.fullmatch(r"([a-zA-Z][a-zA-Z0-9]*)\s*=\s*([^\x00-\x1f]*)",line)
        if section is None or match is None: raise Rejected()
        key,value=match.group(1).lower(),match.group(2).strip()
        identity=(section,key)
        if identity in seen: raise Rejected()
        seen.add(identity)
        if section[0]=="core":
            if key=="repositoryformatversion":
                if value!="0": raise Rejected()
            elif key=="bare":
                if value.lower()!="false": raise Rejected()
            elif key in ("filemode","logallrefupdates","ignorecase","precomposeunicode"):
                if value.lower() not in ("true","false"): raise Rejected()
            else: raise Rejected()
        elif section[0]=="remote":
            if key=="url": repository=canonical_repository(value)
            elif key=="fetch":
                if value!="+refs/heads/*:refs/remotes/origin/*": raise Rejected()
            else: raise Rejected()
        elif key=="remote":
            if value!="origin": raise Rejected()
        elif key=="merge":
            if not value.startswith("refs/heads/") or not valid_ref(value[11:]): raise Rejected()
        else: raise Rejected()
    if repository is None or repository!=expected: raise Rejected()
    return repository
def trusted_git():
    for candidate in ("/usr/bin/git","/usr/local/bin/git"):
        try:
            resolved=os.path.realpath(candidate,strict=True)
            if not resolved.startswith(("/usr/","/usr/local/")): continue
            current=resolved
            while True:
                info=os.stat(current,follow_symlinks=False)
                if info.st_uid not in TRUSTED_OWNER_UIDS or info.st_mode&0o022: raise Rejected()
                if current==resolved and (not stat.S_ISREG(info.st_mode) or not info.st_mode&0o111): raise Rejected()
                if current=="/": return resolved
                current=os.path.dirname(current)
        except (OSError,Rejected): continue
    raise Rejected()
def check_repository_identity():
    for parent,name,descriptor in ((parent_fd,ROOT,root_fd),(root_fd,".git",git_fd)):
        current=os.stat(name,dir_fd=parent,follow_symlinks=False)
        original=os.fstat(descriptor)
        if not stat.S_ISDIR(current.st_mode) or (current.st_dev,current.st_ino)!=(original.st_dev,original.st_ino): raise Conflict()
def limits():
    os.umask(0o077)
    resource.setrlimit(resource.RLIMIT_CORE,(0,0))
    resource.setrlimit(resource.RLIMIT_CPU,(MAX_SECONDS,MAX_SECONDS))
    resource.setrlimit(resource.RLIMIT_FSIZE,(67108864,67108864))
    resource.setrlimit(resource.RLIMIT_NOFILE,(128,128))
    if operation=="export-objects":
        resource.setrlimit(resource.RLIMIT_AS,(MAX_EXPORT_PROCESS_MEMORY,MAX_EXPORT_PROCESS_MEMORY))
def kill_child():
    global termination_uncertain
    if child is None: return True
    def gone():
        child.poll()
        try: os.killpg(child.pid,0)
        except ProcessLookupError: return child.returncode is not None
        except OSError: return False
        return False
    if gone(): return True
    for event,grace in ((signal.SIGTERM,0.2),(signal.SIGKILL,0.2)):
        try: os.killpg(child.pid,event)
        except ProcessLookupError: pass
        except OSError: break
        stopping_deadline=time.monotonic()+grace
        while time.monotonic()<stopping_deadline:
            if gone(): return True
            time.sleep(0.01)
    if gone(): return True
    # A leader's exit does not prove its process group has stopped. Do not
    # release a successful receipt or a reusable coordination slot when the
    # provider/OS cannot positively confirm termination of the original group.
    termination_uncertain=True
    return False
def git(arguments,allowed=(0,),input_bytes=None):
    global child
    check_time()
    check_repository_identity()
    config_repository(expected_repository)
    # Git itself reads only this environment. No provider/application variables.
    # Future helper-created commits use a reproducible UTC identity even when
    # the sandbox default timezone differs; historical objects are never rewritten.
    environment={"PATH":"/usr/bin:/bin","HOME":temporary,"TMPDIR":temporary,"LANG":"C.UTF-8","LC_ALL":"C.UTF-8","TZ":"UTC","GIT_CONFIG_NOSYSTEM":"1","GIT_CONFIG_GLOBAL":"/dev/null","GIT_CONFIG_SYSTEM":"/dev/null","GIT_ATTR_NOSYSTEM":"1","GIT_TERMINAL_PROMPT":"0","GIT_OPTIONAL_LOCKS":"0","GIT_NO_REPLACE_OBJECTS":"1","GIT_CEILING_DIRECTORIES":os.path.dirname(os.getcwd()),"GIT_ALLOW_PROTOCOL":"","GIT_PAGER":"cat","PAGER":"cat"}
    args=[binary,"--no-pager","--literal-pathspecs","-c","core.hooksPath=/dev/null","-c","core.fsmonitor=false","-c","core.untrackedCache=false","-c","core.attributesFile=/dev/null","-c","core.excludesFile=/dev/null","-c","core.quotePath=true","-c","commit.gpgSign=false","-c","tag.gpgSign=false","-c","credential.helper=","-c","protocol.allow=never","-c","diff.external=","-c","maintenance.auto=false","-c","gc.auto=0","-c","user.name=Cr8or Studio","-c","user.email=owner@cr8or.invalid"]+arguments
    child=subprocess.Popen(args,stdin=subprocess.PIPE if input_bytes is not None else subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=environment,close_fds=True,start_new_session=True,preexec_fn=limits)
    if input_bytes is not None:
        child.stdin.write(input_bytes)
        child.stdin.close()
    output=bytearray()
    errors=bytearray()
    selector=selectors.DefaultSelector()
    try:
        for stream,buffer in ((child.stdout,output),(child.stderr,errors)):
            os.set_blocking(stream.fileno(),False)
            selector.register(stream,selectors.EVENT_READ,buffer)
        selector.register(0,selectors.EVENT_READ,None)
        while len(selector.get_map())>1:
            check_time()
            for key,_ in selector.select(0.02):
                if key.data is None:
                    control=os.read(0,17)
                    if not control or control==b"CANCEL\n": raise Cancelled()
                    raise Rejected()
                data=os.read(key.fileobj.fileno(),8192)
                if not data: selector.unregister(key.fileobj)
                else:
                    key.data.extend(data)
                    if len(output)+len(errors)>MAX_OUTPUT: raise Limited()
        result=child.wait(timeout=max(0.001,deadline-time.monotonic()))
        if result not in allowed: raise Rejected()
        return bytes(output),result
    finally:
        selector.close()
        terminated=kill_child()
        child.stdout.close()
        child.stderr.close()
        child=None
        if not terminated: raise Rejected()
def head():
    raw,code=git(["rev-parse","--verify","HEAD"],(0,128))
    if code==128: return None
    value=raw.decode("ascii").strip()
    if HASH_RE.fullmatch(value) is None: raise Rejected()
    return value
def branch():
    raw,code=git(["symbolic-ref","--quiet","--short","HEAD"],(0,1))
    if code==1: return None
    value=raw.decode("utf-8").strip()
    if not valid_ref(value): raise Rejected()
    return value
def index_digest():
    try: content=safe_regular(git_fd,"index",16777216)
    except FileNotFoundError: content=b""
    return hashlib.sha256(content).hexdigest()
def changes():
    raw,_=git(["status","--porcelain=v1","-z","--untracked-files=all","--no-renames","--ignore-submodules=all"])
    result=[]
    for item in raw.split(b"\0"):
        if not item: continue
        value=item.decode("utf-8")
        if len(value)<4 or value[2]!=" ": raise Rejected()
        safe_path(value[3:])
        result.append({"status":value[:2],"path":value[3:]})
        if len(result)>1000: raise Limited()
    return result
def validate_index_entries():
    raw,_=git(["ls-files","--stage","-z"])
    for entry in raw.split(b"\0"):
        if not entry: continue
        fields=entry.split(b"\t",1)
        if len(fields)!=2: raise Rejected()
        metadata=fields[0].split(b" ")
        if len(metadata)!=3 or metadata[0] not in (b"100644",b"100755") or metadata[2]!=b"0": raise Rejected()
        if HASH_RE.fullmatch(metadata[1].decode("ascii")) is None: raise Rejected()
        safe_path(fields[1].decode("utf-8"))
def paths_exist_safely(paths):
    for relative in paths:
        directory=os.dup(root_fd)
        try:
            parts=relative.split("/")
            for part in parts[:-1]:
                following=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=directory)
                os.close(directory)
                directory=following
            try: info=os.stat(parts[-1],dir_fd=directory,follow_symlinks=False)
            except FileNotFoundError: continue
            if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1: raise Rejected()
        finally: os.close(directory)
def validate_expected(request,actual_head,actual_branch,actual_index):
    if request.get("expectedHead")!=actual_head or request.get("branch")!=actual_branch or request.get("expectedIndex")!=actual_index: raise Conflict()
    if actual_branch is None: raise Conflict()
def export_objects(request):
    # Only exact SHA-1 objects are supported. The verified remote base is an
    # ancestry boundary, not a new object to upload or an arbitrary revision.
    strict_hash=re.compile(r"[0-9a-f]{40}\Z")
    target=request["targetCommit"]
    base=request["expectedRemoteHead"]
    if strict_hash.fullmatch(target) is None or strict_hash.fullmatch(base) is None or target==base: raise Rejected()
    if head()!=target or branch()!=request["branch"]: raise Conflict()
    records={}
    total=[0]
    entries=[0]
    def object_bytes(oid,kind,record=True):
        if strict_hash.fullmatch(oid) is None or kind not in ("commit","tree","blob"): raise Rejected()
        if oid in records:
            existing=records[oid]
            if existing["type"]!=kind: raise Rejected()
            return base64.b64decode(existing["contentBase64"],validate=True)
        actual,_=git(["cat-file","-t",oid])
        size,_=git(["cat-file","-s",oid])
        if actual!=kind.encode("ascii")+b"\n" or re.fullmatch(rb"(?:0|[1-9][0-9]*)\n",size) is None: raise Rejected()
        length=int(size)
        if length>MAX_EXPORT_OBJECT: raise Limited()
        content,_=git(["cat-file",kind,oid])
        if len(content)!=length or hashlib.sha1(kind.encode("ascii")+b" "+str(length).encode("ascii")+b"\0"+content).hexdigest()!=oid: raise Rejected()
        if record:
            if len(records)>=MAX_EXPORT_OBJECTS or total[0]+length>MAX_EXPORT_TOTAL: raise Limited()
            total[0]+=length
            records[oid]={"oid":oid,"type":kind,"contentBase64":base64.b64encode(content).decode("ascii")}
        return content
    # Verify that the expected boundary exists as a real immutable commit.
    object_bytes(base,"commit",False)
    def commit_fields(content):
        text=content.decode("utf-8")
        if "\0" in text or "\r" in text or not text.endswith("\n"): raise Rejected()
        header,separator,message=text.partition("\n\n")
        fields=header.split("\n")
        if not separator or not message or len(fields)!=4: raise Rejected()
        if not fields[0].startswith("tree ") or not fields[1].startswith("parent "): raise Rejected()
        tree=fields[0][5:]
        parent=fields[1][7:]
        if strict_hash.fullmatch(tree) is None or strict_hash.fullmatch(parent) is None: raise Rejected()
        for field,label in ((fields[2],"author"),(fields[3],"committer")):
            # The GitHub API cannot faithfully reproduce arbitrary headers,
            # non-UTC offsets, signatures or encodings. Reject those formats.
            match=re.fullmatch(label+r" ([^<>\x00-\x1f\x7f]{1,128}) <([^<>\s\x00-\x1f\x7f]{1,254})> ([1-9][0-9]{0,9}) \+0000",field)
            if match is None or not 1<=int(match.group(3))<=253402300799: raise Rejected()
        return tree,parent
    def export_tree(oid,prefix="",depth=0):
        if depth>MAX_EXPORT_DEPTH: raise Limited()
        raw=object_bytes(oid,"tree")
        offset=0
        seen=set()
        prior=None
        while offset<len(raw):
            check_time()
            space=raw.find(b" ",offset)
            nul=raw.find(b"\0",space+1)
            if space<0 or nul<0 or nul+21>len(raw): raise Rejected()
            mode=raw[offset:space]
            name=raw[space+1:nul].decode("utf-8")
            child_oid=raw[nul+1:nul+21].hex()
            offset=nul+21
            if mode not in (b"40000",b"100644",b"100755") or "/" in name or not name or name in seen: raise Rejected()
            seen.add(name)
            relative=prefix+name
            safe_path(relative)
            if any(character in relative for character in ":*?[]"): raise Rejected()
            if any(part.lower().startswith((".git",".env")) or part.lower()==".aws" for part in relative.split("/")): raise Rejected()
            key=name.encode("utf-8")+(b"/" if mode==b"40000" else b"")
            if prior is not None and key<=prior: raise Rejected()
            prior=key
            entries[0]+=1
            if entries[0]>MAX_EXPORT_ENTRIES: raise Limited()
            if mode==b"40000": export_tree(child_oid,relative+"/",depth+1)
            else: object_bytes(child_oid,"blob")
    current=target
    seen_commits=set()
    while current!=base:
        check_time()
        if current in seen_commits: raise Rejected()
        if len(seen_commits)>=MAX_EXPORT_COMMITS: raise Limited()
        seen_commits.add(current)
        tree,current=commit_fields(object_bytes(current,"commit"))
        export_tree(tree)
    # No mutation is performed. Verify HEAD/configuration once more so an
    # in-flight branch replacement cannot release a mismatched object graph.
    check_repository_identity()
    config_repository(expected_repository)
    if head()!=target or branch()!=request["branch"]: raise Conflict()
    return {"version":1,"repositoryKey":expected_repository[len("https://github.com/"):-4],
        "branch":request["branch"],"head":target,"base":base,"objects":list(records.values())}
def disable_echo():
    if not os.isatty(0): return
    import termios
    settings=termios.tcgetattr(0)
    settings[0] &= ~(termios.BRKINT|termios.ICRNL|termios.INLCR|termios.IGNCR|termios.ISTRIP|termios.IXON|termios.IXOFF|termios.PARMRK)
    settings[1] &= ~termios.OPOST
    settings[2] &= ~(termios.CSIZE|termios.PARENB)
    settings[2] |= termios.CS8
    settings[3] &= ~(termios.ECHO|termios.ECHONL|termios.ICANON|termios.ISIG|termios.IEXTEN)
    settings[6][termios.VMIN]=1
    settings[6][termios.VTIME]=0
    termios.tcsetattr(0,termios.TCSANOW,settings)
try:
    for event in (signal.SIGTERM,signal.SIGHUP,signal.SIGINT): signal.signal(event,stop)
    if len(sys.argv)!=1: raise Rejected()
    disable_echo()
    wire=read_frame(MAX_REQUEST)
    request=json.loads(wire.decode("utf-8"))
    if not isinstance(request,dict): raise Rejected()
    operation=request.get("operation")
    if operation not in READS|WRITES|{"export-objects"}: raise Rejected()
    if operation=="export-objects": MAX_OUTPUT=MAX_EXPORT_OUTPUT
    keys={"operation","expectedRepository","branch"}
    if operation in ("stage","unstage","commit"): keys|={"branch","expectedHead","expectedIndex"}
    if operation in ("stage","unstage","diff"): keys.add("paths")
    if operation=="commit": keys|={"commitPrefix","category"}
    if operation=="export-objects": keys|={"targetCommit","expectedRemoteHead"}
    if set(request)!=keys: raise Rejected()
    expected_repository=canonical_repository(request["expectedRepository"])
    if not valid_ref(request["branch"]): raise Rejected()
    if operation=="export-objects":
        if any(not isinstance(request.get(key),str) or re.fullmatch(r"[0-9a-f]{40}",request[key]) is None for key in ("targetCommit","expectedRemoteHead")): raise Rejected()
    if operation in WRITES:
        if request["expectedHead"] is not None and (not isinstance(request["expectedHead"],str) or HASH_RE.fullmatch(request["expectedHead"]) is None): raise Rejected()
        if not isinstance(request["expectedIndex"],str) or INDEX_RE.fullmatch(request["expectedIndex"]) is None: raise Rejected()
    paths=[]
    if "paths" in request:
        if not isinstance(request["paths"],list) or not 1<=len(request["paths"])<=MAX_PATHS: raise Rejected()
        paths=[safe_path(value) for value in request["paths"]]
        if len(set(paths))!=len(paths): raise Rejected()
    if operation=="commit":
        # The registry is embedded by trusted server code, never selected from
        # model arguments, repository history or sandbox environment variables.
        repository_key=expected_repository[len("https://github.com/"):-4]
        approved_prefix=PROJECT_CODES.get(repository_key)
        if approved_prefix is None or request["commitPrefix"]!=approved_prefix or request["category"] not in CATEGORIES: raise Rejected()
    parent_fd=os.open(".",os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    root_fd=os.open(ROOT,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent_fd)
    git_fd=os.open(".git",os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=root_fd)
    lock_fd=os.open("cr8or-operation.lock",os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW|os.O_NONBLOCK,0o600,dir_fd=git_fd)
    info=os.fstat(lock_fd)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1: raise Rejected()
    try: fcntl.flock(lock_fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError: raise Busy()
    scan_directory(git_fd,True)
    scan_directory(root_fd)
    repository=config_repository(expected_repository)
    binary=trusted_git()
    temporary=tempfile.mkdtemp(prefix="cr8or-git-")
    os.fchdir(root_fd)
    initial_head=head()
    initial_branch=branch()
    if initial_branch!=request["branch"]: raise Conflict()
    initial_index=None if operation=="export-objects" else index_digest()
    if operation in WRITES: validate_expected(request,initial_head,initial_branch,initial_index)
    paths_exist_safely(paths)
    emit("READY")
    control=read_frame(16)
    if control==b"CANCEL": raise Cancelled()
    if control!=b"START": raise Rejected()
    check_time()
    if termination_uncertain: raise Rejected()
    # Revalidate the filesystem/configuration after the server's authorization
    # round trip; READY does not freeze an untrusted sandbox's namespace.
    check_repository_identity()
    scan_directory(git_fd,True)
    scan_directory(root_fd)
    config_repository(expected_repository)
    if branch()!=request["branch"]: raise Conflict()
    if operation in ("status","changes"):
        data={"head":initial_head,"branch":initial_branch,"index":initial_index,"changes":changes()}
    elif operation=="branch": data={"head":initial_head,"branch":initial_branch,"index":initial_index}
    elif operation=="remote": data={"name":"origin","url":repository}
    elif operation=="log":
        if initial_head is None: data={"commits":[]}
        else:
            raw,_=git(["log","-20","--no-show-signature","--format=%H%x00%ct%x00%s%x00"])
            items=raw.split(b"\0\n")
            commits=[]
            for item in items:
                if not item: continue
                fields=item.split(b"\0")
                if len(fields)!=3: raise Rejected()
                oid,timestamp,subject=[field.decode("utf-8") for field in fields]
                if HASH_RE.fullmatch(oid) is None or not timestamp.isdigit() or not plain(subject,512): raise Rejected()
                # Commit subjects can contain arbitrary secrets authored outside
                # this helper; expose only neutral convention-matching titles.
                if re.fullmatch(r"[A-Z][A-Z0-9]{1,11}-[0-9]{3,9}: (?:General maintenance|Code improvements|Documentation updates|Test improvements|Configuration updates)",subject) is None:
                    subject="Commit"
                commits.append({"sha":oid,"timestamp":int(timestamp),"title":subject})
            data={"commits":commits}
    elif operation=="export-objects": data=export_objects(request)
    elif operation=="diff":
        raw,_=git(["diff","--no-ext-diff","--no-textconv","--no-renames","--no-color","--",*paths])
        staged,_=git(["diff","--cached","--no-ext-diff","--no-textconv","--no-renames","--no-color","--",*paths])
        if len(raw)+len(staged)>MAX_OUTPUT: raise Limited()
        data={"unstaged":raw.decode("utf-8"),"staged":staged.decode("utf-8")}
    else:
        check_time()
        # Recheck the expected repository state immediately before the fixed
        # mutation. Database coordination remains the cross-instance authority.
        config_repository(expected_repository)
        validate_expected(request,head(),branch(),index_digest())
        if operation=="stage":
            mutating=True
            git(["add","--",*paths])
        elif operation=="unstage":
            mutating=True
            if initial_head is None: git(["rm","--cached","--ignore-unmatch","--",*paths])
            else: git(["restore","--staged","--source=HEAD","--",*paths])
        else:
            validate_index_entries()
            staged,_=git(["diff","--cached","--name-only","-z","--no-renames"])
            staged_paths=[value.decode("utf-8") for value in staged.split(b"\0") if value]
            if not staged_paths or len(staged_paths)>1000: raise Rejected()
            for value in staged_paths: safe_path(value)
            paths_exist_safely(staged_paths)
            prefix=request["commitPrefix"]
            last=0
            if initial_head is not None:
                refs,_=git(["for-each-ref","--format=%(refname)%00%(objectname)"])
                history,_=git(["log","--all","--no-show-signature","--max-count="+str(MAX_HISTORY_COMMITS+1),"--format=%H%x00%s%x00"])
                commits=[record for record in history.split(b"\0\n") if record]
                if len(commits)>MAX_HISTORY_COMMITS: raise Limited()
                seen={}
                for record in commits:
                    fields=record.split(b"\0")
                    if len(fields)!=2: raise Rejected()
                    oid,subject=[field.decode("utf-8") for field in fields]
                    if HASH_RE.fullmatch(oid) is None: raise Rejected()
                    # Legacy PROJECT identifiers remain unchanged and reserve
                    # their numeric floor. Other project prefixes cannot select
                    # this repository's trusted code or affect its allocation.
                    for namespace in {prefix,"PROJECT"}:
                        if not subject.startswith(namespace+"-"): continue
                        match=re.fullmatch(re.escape(namespace)+r"-([0-9]{3,9}): .+",subject)
                        if match is None: raise Rejected()
                        number=int(match.group(1))
                        if number<1 or number>999999999 or str(number).zfill(3)!=match.group(1): raise Rejected()
                        identity=(namespace,number)
                        if identity in seen and seen[identity]!=oid: raise Conflict()
                        seen[identity]=oid
                        last=max(last,number)
                current_refs,_=git(["for-each-ref","--format=%(refname)%00%(objectname)"])
                if refs!=current_refs: raise Conflict()
            if last>=999999999: raise Limited()
            title=prefix+"-"+str(last+1).zfill(3)+": "+request["category"]
            validate_expected(request,head(),branch(),index_digest())
            mutating=True
            git(["commit","--no-gpg-sign","--no-verify","--cleanup=verbatim","-F","-"],input_bytes=(title+"\n").encode("utf-8"))
        data={"head":head(),"branch":branch(),"index":index_digest(),"operation":operation}
        if operation=="commit":
            if data["head"]==initial_head: raise Conflict()
            data["title"]=title
        mutating=False
    check_time()
    if termination_uncertain: raise Rejected()
    result=json.dumps({"ok":True,"data":data},ensure_ascii=True,separators=(",",":"))
    if len(result.encode("utf-8"))+1>MAX_OUTPUT: raise Limited()
    emit("RESULT "+result)
except Exception as error:
    # Provider errors, subprocess stderr, config and source data never escape.
    if mutating or termination_uncertain: code="UNCERTAIN"
    elif isinstance(error,Conflict): code="CONFLICT"
    elif isinstance(error,Busy): code="BUSY"
    elif isinstance(error,Cancelled): code="CANCELLED"
    elif isinstance(error,(Limited,subprocess.TimeoutExpired)): code="LIMIT"
    else: code="REJECTED"
    emit("RESULT "+json.dumps({"ok":False,"error":code},separators=(",",":")))
    sys.exit(1)
finally:
    kill_child()
    if temporary is not None: shutil.rmtree(temporary,ignore_errors=True)
    for descriptor in (lock_fd,git_fd,root_fd,parent_fd):
        if descriptor is not None:
            try: os.close(descriptor)
            except OSError: pass
`;
