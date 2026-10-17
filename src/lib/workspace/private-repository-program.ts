import "server-only";

export const PRIVATE_REPOSITORY_LIMITS = Object.freeze({
  durationMs: 40_000, requestMs: 5_000, cleanupMs: 5_000, pollMs: 100, revalidateMs: 2_000,
  sdkCalls: 1000, cleanupPolls: 10, chunkBytes: 12_288, encodedBytes: 2 * 1024 * 1024, outputBytes: 4096,
});

/** Fixed-purpose, credential-free repository installation. Only a fresh sibling
 * staging directory is modified; Linux renameat2(RENAME_NOREPLACE) publishes it.
 * Same-UID hostile processes remain outside this helper's isolation guarantee.
 * SIGKILL/provider loss can leave staging data for separately authorized cleanup. */
export const PRIVATE_REPOSITORY_PROGRAM = String.raw`
import base64,ctypes,errno,hashlib,json,os,re,resource,selectors,signal,stat,subprocess,sys,time,uuid,zlib
PREFIX="CR8OR-REPOSITORY/1 "
ROOT="repo"
MAX_WIRE=2097152
MAX_OBJECT=262144
MAX_BYTES=1048576
MAX_OBJECTS=128
MAX_COMMITS=16
MAX_ENTRIES=512
TRUSTED_OWNER_UIDS=(0,)
deadline=time.monotonic()+35
stopped=False
parent=None
stage=None
stage_name=None
published=False
fds=[]
class Rejected(Exception): pass
class Limited(Exception): pass
class Cancelled(Exception): pass
def stop(signum,frame):
    global stopped
    stopped=True
def check():
    if stopped: raise Cancelled()
    if time.monotonic()>deadline: raise Limited()
def emit(text):
    sys.stdout.write(PREFIX+text+"\n")
    sys.stdout.flush()
def read_exact(length):
    selector=selectors.DefaultSelector()
    selector.register(0,selectors.EVENT_READ)
    data=bytearray()
    try:
        while len(data)<length:
            check()
            if not selector.select(.02): continue
            value=os.read(0,min(12288,length-len(data)))
            if not value: raise Cancelled()
            data.extend(value)
    finally: selector.close()
    return bytes(data)
def line(maximum):
    data=bytearray()
    while len(data)<=maximum:
        byte=read_exact(1)
        if byte==b"\n": return bytes(data)
        data.extend(byte)
    raise Limited()
def plain(value,maximum=4096):
    return isinstance(value,str) and 0<len(value.encode("utf-8"))<=maximum and not any(ord(c)<32 or ord(c)==127 for c in value)
def ident(value): return plain(value,128) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}",value)
def branch(value):
    return plain(value,200) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]*",value) and ".." not in value and "//" not in value and not value.endswith(".") and not value.startswith("refs/") and value!="HEAD" and all(p and not p.startswith(".") and not p.endswith(".lock") for p in value.split("/"))
def path_ok(value):
    if not plain(value) or value.startswith(("/","-")) or any(char in value for char in "\\:*?[]"): return False
    for part in value.split("/"):
        low=part.lower()
        if not part or part in (".","..") or len(part.encode())>255 or low.startswith((".git",".env")) or low in (".aws",".ssh",".config",".npmrc",".netrc","credentials","credential","secrets","secret","id_rsa","id_ed25519") or low.endswith((".pem",".key")): return False
    return True
def sha(value): return isinstance(value,str) and re.fullmatch(r"[0-9a-f]{40}",value)
def strict_json(data):
    def pairs(items):
        out={}
        for key,value in items:
            if key in out: raise Rejected()
            out[key]=value
        return out
    return json.loads(data.decode("utf-8"),object_pairs_hook=pairs)
def oid(kind,data): return hashlib.sha1((kind+" "+str(len(data))+"\0").encode()+data).hexdigest()
def graph(raw,meta):
    value=strict_json(raw)
    if set(value)!={"version","repositoryKey","branch","head","objects"} or value["version"]!=1 or any(value[k]!=meta[k] for k in ("repositoryKey","branch","head")): raise Rejected()
    if not isinstance(value["objects"],list) or not 2<=len(value["objects"])<=MAX_OBJECTS: raise Rejected()
    objects={}; total=0; entries=0
    for item in value["objects"]:
        check()
        if not isinstance(item,dict) or set(item)!={"oid","type","contentBase64"} or not sha(item["oid"]) or item["type"] not in ("commit","tree","blob") or item["oid"] in objects or not isinstance(item["contentBase64"],str): raise Rejected()
        if len(item["contentBase64"])>349528: raise Limited()
        body=base64.b64decode(item["contentBase64"],validate=True)
        if base64.b64encode(body).decode()!=item["contentBase64"] or len(body)>MAX_OBJECT: raise Rejected()
        total+=len(body)
        if total>MAX_BYTES or oid(item["type"],body)!=item["oid"]: raise Rejected()
        obj={"type":item["type"],"body":body}
        if item["type"]=="tree":
            items=[]; offset=0; previous=None; names=set()
            while offset<len(body):
                end=body.find(b"\0",offset)
                if end<0 or end+21>len(body): raise Rejected()
                header=body[offset:end].decode("utf-8")
                match=re.fullmatch(r"(100644|100755|40000) (.+)",header)
                if not match: raise Rejected()
                mode,name=match.groups()
                key=(name+("/" if mode=="40000" else "\0")).encode()
                if not path_ok(name) or "/" in name or name in names or (previous is not None and previous>=key): raise Rejected()
                previous=key; names.add(name)
                items.append((mode,name,body[end+1:end+21].hex()))
                offset=end+21; entries+=1
                if entries>MAX_ENTRIES: raise Limited()
            obj["entries"]=items
        elif item["type"]=="commit":
            text=body.decode("utf-8")
            match=re.fullmatch(r"tree ([0-9a-f]{40})\n(?:parent ([0-9a-f]{40})\n)?author ([^\n]+)\ncommitter ([^\n]+)\n\n([^\x00]*)",text)
            if not match: raise Rejected()
            for person in (match[3],match[4]):
                identity=re.fullmatch(r"([^<>\x00-\x1f\x7f]+) <([^<>\s\x00-\x1f\x7f]+)> ([1-9][0-9]{0,11}) \+0000",person)
                if not identity or identity[1]!=identity[1].strip() or len(identity[1].encode())>256 or len(identity[2].encode())>254 or not re.fullmatch(r"[\x21-\x7e]+@[\x21-\x7e]+",identity[2]) or int(identity[3])>253402300799: raise Rejected()
            obj["tree"]=match[1]; obj["parent"]=match[2]
        objects[item["oid"]]=obj
    visited=set(); expanded=0; workbytes=0; files={}
    def tree(tree_id,prefix,depth,head):
        nonlocal expanded,workbytes
        if depth>32 or tree_id not in objects or objects[tree_id]["type"]!="tree": raise Rejected()
        visited.add(tree_id)
        for mode,name,child in objects[tree_id]["entries"]:
            expanded+=1
            path=prefix+name
            if expanded>MAX_ENTRIES or not path_ok(path) or child not in objects or objects[child]["type"]!=("tree" if mode=="40000" else "blob"): raise Rejected()
            visited.add(child)
            if mode=="40000": tree(child,path+"/",depth+1,head)
            elif head:
                workbytes+=len(objects[child]["body"])
                if workbytes>MAX_BYTES: raise Limited()
                files[path]=(mode,objects[child]["body"])
    current=meta["head"]; commits=[]
    while current is not None:
        if current not in objects or objects[current]["type"]!="commit" or current in visited or len(commits)>=MAX_COMMITS: raise Rejected()
        visited.add(current); commits.append(current)
        tree(objects[current]["tree"],"",0,current==meta["head"])
        current=objects[current]["parent"]
    if len(visited)!=len(objects): raise Rejected()
    return objects,files,commits

def names(fd):
    with os.scandir(fd) as entries:
        count=0
        for entry in entries:
            count+=1
            if count>2048: raise Limited()
            yield entry.name
def directory(fd,name,create=False,track=True):
    if create:
        try: os.mkdir(name,0o700,dir_fd=fd)
        except FileExistsError: pass
    out=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
    if track: fds.append(out)
    return out
def regular(fd,name,data,mode=0o600):
    out=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,mode,dir_fd=fd)
    try:
        view=memoryview(data)
        while view:
            check(); count=os.write(out,view)
            if not count: raise Rejected()
            view=view[count:]
        os.fsync(out)
    finally: os.close(out)
def write_path(fd,path,data,mode=0o600):
    parts=path.split("/"); opened=[]
    try:
        for part in parts[:-1]:
            fd=directory(fd,part,True,False); opened.append(fd)
        regular(fd,parts[-1],data,mode)
    finally:
        for descriptor in reversed(opened): os.close(descriptor)
def read_file(fd,path,maximum=MAX_OBJECT+1024):
    parts=path.split("/"); opened=[]; out=None
    try:
        for part in parts[:-1]:
            fd=directory(fd,part,False,False); opened.append(fd)
        out=os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
        state=os.fstat(out)
        if not stat.S_ISREG(state.st_mode) or state.st_nlink!=1 or state.st_size>maximum: raise Rejected()
        data=bytearray()
        while True:
            check(); chunk=os.read(out,min(16384,maximum+1-len(data)))
            if not chunk: break
            data.extend(chunk)
            if len(data)>maximum: raise Limited()
        return bytes(data),state
    finally:
        if out is not None: os.close(out)
        for descriptor in reversed(opened): os.close(descriptor)
def marker(meta):
    return json.dumps({k:meta[k] for k in ("operationId","projectId","workspaceRecordId","providerWorkspaceId","repositoryKey","branch","head")},sort_keys=True,separators=(",",":")).encode()+b"\n"
def configuration(meta):
    return ("[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = false\n[remote \"origin\"]\n\turl = https://github.com/"+meta["repositoryKey"]+".git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n").encode()
def git(fd,args):
    check()
    exe="/usr/bin/git"
    info=os.lstat(exe)
    if not stat.S_ISREG(info.st_mode) or info.st_uid not in TRUSTED_OWNER_UIDS or info.st_mode & 0o022: raise Rejected()
    current=os.path.dirname(exe)
    while True:
        info=os.lstat(current)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid not in TRUSTED_OWNER_UIDS or info.st_mode & 0o022: raise Rejected()
        if current=="/": break
        current=os.path.dirname(current)
    env={"PATH":"/usr/bin:/bin","HOME":"/nonexistent","LANG":"C.UTF-8","LC_ALL":"C.UTF-8","TZ":"UTC","GIT_CONFIG_NOSYSTEM":"1","GIT_CONFIG_GLOBAL":"/dev/null","GIT_TERMINAL_PROMPT":"0","GIT_NO_REPLACE_OBJECTS":"1","GIT_OPTIONAL_LOCKS":"0"}
    fixed=[exe,"--no-optional-locks","-c","core.hooksPath=/dev/null","-c","core.fsmonitor=false","-c","protocol.allow=never","-c","core.attributesFile=/dev/null","-c","credential.helper=","-c","gc.auto=0"]
    def limits():
        resource.setrlimit(resource.RLIMIT_AS,(268435456,268435456))
        resource.setrlimit(resource.RLIMIT_FSIZE,(2097152,2097152))
        resource.setrlimit(resource.RLIMIT_CPU,(10,10))
    child=subprocess.Popen(fixed+args,cwd="/proc/self/fd/"+str(fd),env=env,pass_fds=(fd,),stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True,preexec_fn=limits)
    selector=selectors.DefaultSelector(); selector.register(child.stdout,selectors.EVENT_READ); selector.register(child.stderr,selectors.EVENT_READ)
    output=bytearray(); errors=bytearray()
    try:
        while selector.get_map():
            check()
            for key,_ in selector.select(.02):
                data=os.read(key.fileobj.fileno(),4096)
                if not data: selector.unregister(key.fileobj); continue
                target=output if key.fileobj==child.stdout else errors
                target.extend(data)
                if len(output)+len(errors)>65536: raise Limited()
        if child.wait(timeout=max(.01,deadline-time.monotonic()))!=0: raise Rejected()
        return bytes(output)
    finally:
        selector.close()
        if child.poll() is None:
            try: os.killpg(child.pid,signal.SIGKILL)
            except ProcessLookupError: pass
            child.wait(timeout=1)
        child.stdout.close(); child.stderr.close()
def verify(fd,meta,objects,files,commits):
    # Exact metadata and complete byte comparison precede all Git subprocesses.
    expected={".git/config":configuration(meta),".git/HEAD":("ref: refs/heads/"+meta["branch"]+"\n").encode(),".git/refs/heads/"+meta["branch"]:(meta["head"]+"\n").encode(),".git/cr8or-initialization.json":marker(meta)}
    for key,value in expected.items():
        if read_file(fd,key,8192)[0]!=value: raise Rejected()
    read_file(fd,".git/index",2097152)
    expected_files=set(expected)|{".git/index"}
    for object_id,obj in objects.items():
        name=".git/objects/"+object_id[:2]+"/"+object_id[2:]
        compressed=read_file(fd,name,MAX_OBJECT+1024)[0]
        decoder=zlib.decompressobj(); raw=decoder.decompress(compressed,MAX_OBJECT+128)
        wanted=(obj["type"]+" "+str(len(obj["body"]))+"\0").encode()+obj["body"]
        if raw!=wanted or not decoder.eof or decoder.unused_data or decoder.unconsumed_tail: raise Rejected()
        expected_files.add(name)
    for name,(mode,data) in files.items():
        current,info=read_file(fd,name)
        if current!=data or bool(info.st_mode & 0o111)!=(mode=="100755"): raise Rejected()
        expected_files.add(name)
    expected_dirs=set()
    for name in expected_files:
        parts=name.split("/")
        for count in range(1,len(parts)): expected_dirs.add("/".join(parts[:count]))
    actual=set(); actual_dirs=set(); count=0
    def scan(current,prefix=""):
        nonlocal count
        for name in names(current):
            check(); count+=1
            if count>2048: raise Limited()
            path=prefix+name; info=os.stat(name,dir_fd=current,follow_symlinks=False)
            if stat.S_ISDIR(info.st_mode):
                actual_dirs.add(path)
                child=directory(current,name,False,False)
                try: scan(child,path+"/")
                finally: os.close(child)
            elif stat.S_ISREG(info.st_mode) and info.st_nlink==1: actual.add(path)
            else: raise Rejected()
    scan(fd)
    # Empty mandatory Git directories are permitted, no hooks or arbitrary config.
    if actual!=expected_files or actual_dirs-expected_dirs-{".git/refs",".git/refs/heads",".git/objects"}: raise Rejected()
    if git(fd,["rev-parse","--verify","HEAD"]).strip().decode()!=meta["head"]: raise Rejected()
    if git(fd,["symbolic-ref","HEAD"]).strip().decode()!="refs/heads/"+meta["branch"]: raise Rejected()
    if git(fd,["rev-list","HEAD"]).decode().splitlines()!=commits: raise Rejected()
    git(fd,["fsck","--full","--strict","--no-reflogs"])
    if git(fd,["status","--porcelain=v1","--untracked-files=all"]): raise Rejected()
def remove_tree(fd):
    count=0; cleanup_deadline=time.monotonic()+2
    def recurse(current):
        nonlocal count
        for name in names(current):
            count+=1
            if count>2048 or time.monotonic()>cleanup_deadline: raise Limited()
            info=os.stat(name,dir_fd=current,follow_symlinks=False)
            if stat.S_ISDIR(info.st_mode):
                child=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=current)
                try: recurse(child)
                finally: os.close(child)
                os.rmdir(name,dir_fd=current)
            else: os.unlink(name,dir_fd=current)
    recurse(fd)
def result(state,meta):
    return {"state":state,"head":meta["head"] if state=="READY" else None,"branch":meta["branch"] if state=="READY" else None}
try:
    signal.signal(signal.SIGTERM,stop); signal.signal(signal.SIGINT,stop)
    os.umask(0o077)
    resource.setrlimit(resource.RLIMIT_AS,(268435456,268435456))
    resource.setrlimit(resource.RLIMIT_FSIZE,(2097152,2097152))
    resource.setrlimit(resource.RLIMIT_CPU,(15,15))
    meta=strict_json(line(8192))
    keys={"operationId","projectId","workspaceRecordId","providerWorkspaceId","repositoryKey","branch","head","mode","payloadBytes"}
    if not isinstance(meta,dict) or set(meta)!=keys or any(not ident(meta[k]) for k in ("operationId","projectId","workspaceRecordId","providerWorkspaceId")) or not branch(meta["branch"]) or not sha(meta["head"]) or meta["mode"] not in ("initialize","inspect") or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,38}/[a-z0-9_.-]{1,100}",meta["repositoryKey"]) or meta["repositoryKey"].split("/")[-1] in (".","..") or meta["repositoryKey"].endswith(".git") or type(meta["payloadBytes"])!=int or not 1<=meta["payloadBytes"]<=MAX_WIRE: raise Rejected()
    parent=os.open(".",os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    emit("READY")
    objects,files,commits=graph(read_exact(meta["payloadBytes"]),meta)
    if meta["mode"]=="inspect":
        try: root=directory(parent,ROOT)
        except FileNotFoundError:
            state="INCOMPLETE" if any(name.startswith(".cr8or-init-") for name in names(parent)) else "ABSENT"
        except OSError: state="UNEXPECTED"
        else:
            try: verify(root,meta,objects,files,commits); state="READY"
            except Exception: state="UNEXPECTED"
        emit("RESULT "+json.dumps({"ok":True,"data":result(state,meta)},separators=(",",":")))
    else:
        try: os.stat(ROOT,dir_fd=parent,follow_symlinks=False)
        except FileNotFoundError: pass
        else: raise Rejected()
        if any(name.startswith(".cr8or-init-") for name in names(parent)): raise Rejected()
        stage_name=".cr8or-init-"+uuid.uuid4().hex
        os.mkdir(stage_name,0o700,dir_fd=parent); stage=directory(parent,stage_name)
        gitdir=directory(stage,".git",True)
        directory(gitdir,"objects",True); directory(directory(gitdir,"refs",True),"heads",True)
        regular(gitdir,"config",configuration(meta))
        regular(gitdir,"HEAD",("ref: refs/heads/"+meta["branch"]+"\n").encode())
        write_path(gitdir,"refs/heads/"+meta["branch"],(meta["head"]+"\n").encode())
        regular(gitdir,"cr8or-initialization.json",marker(meta))
        for object_id,obj in objects.items():
            write_path(gitdir,"objects/"+object_id[:2]+"/"+object_id[2:],zlib.compress((obj["type"]+" "+str(len(obj["body"]))+"\0").encode()+obj["body"]))
        for name,(mode,data) in files.items(): write_path(stage,name,data,0o700 if mode=="100755" else 0o600)
        git(stage,["read-tree","HEAD"])
        verify(stage,meta,objects,files,commits)
        emit("STAGED")
        if line(16)!=b"COMMIT": raise Cancelled()
        check()
        # Recheck every byte and inode kind immediately before publication.
        verify(stage,meta,objects,files,commits)
        libc=ctypes.CDLL(None,use_errno=True)
        rename=getattr(libc,"renameat2",None)
        if rename is None: raise Rejected()
        rename.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint]
        rename.restype=ctypes.c_int
        if rename(parent,stage_name.encode(),parent,ROOT.encode(),1)!=0: raise Rejected()
        published=True
        os.fsync(parent)
        root=directory(parent,ROOT)
        if (os.fstat(root).st_dev,os.fstat(root).st_ino)!=(os.fstat(stage).st_dev,os.fstat(stage).st_ino): raise Rejected()
        verify(root,meta,objects,files,commits)
        emit("RESULT "+json.dumps({"ok":True,"data":result("READY",meta)},separators=(",",":")))
except BaseException:
    emit("RESULT "+json.dumps({"ok":False,"error":"UNCERTAIN" if published else "REJECTED"},separators=(",",":")))
    sys.exitcode=1
finally:
    if stage is not None and not published:
        try:
            current=os.stat(stage_name,dir_fd=parent,follow_symlinks=False)
            original=os.fstat(stage)
            if (current.st_dev,current.st_ino)==(original.st_dev,original.st_ino):
                remove_tree(stage); os.rmdir(stage_name,dir_fd=parent)
        except Exception: pass
    for fd in reversed(fds):
        try: os.close(fd)
        except OSError: pass
    if parent is not None: os.close(parent)
sys.exit(getattr(sys,"exitcode",0))
`;
