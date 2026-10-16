import "server-only";

/**
 * Fixed-purpose staged writer. argv contains only a path and correlation nonce;
 * source bytes arrive through bounded stdin frames. No credential is accepted.
 * The caller alone authorizes COMMIT after its PostgreSQL session recheck.
 *
 * Linux descriptor-relative replacement is atomic for this same-directory
 * stage. The sandbox control plane and operating system remain trusted: checks
 * cannot eliminate namespace races caused by another hostile sandbox process.
 * SIGKILL/provider loss cannot guarantee cleanup. Any error after COMMIT was
 * sent may mean replacement completed but acknowledgement/durability failed.
 */
export const PRIVATE_CLOUD_WRITE_PROGRAM = String.raw`
import base64,codecs,contextlib,hashlib,hmac,json,os,re,secrets,signal,stat,sys
MAX_WRITE=262144
MAX_PATH=4096
MAX_LINE=16512
CHUNK=12288
NONCE_RE=re.compile(r"[0-9a-f]{32}\Z")
HASH_RE=re.compile(r"[0-9a-f]{64}\Z")
COUNT_RE=re.compile(r"(?:0|[1-9][0-9]*)\Z")
STOP_SIGNALS=(signal.SIGALRM,signal.SIGTERM,signal.SIGHUP)
nonce="0"*32
fds=[]
created=[]
chain=[]
stage_name=None
stage_identity=None
directory=None
committed=False
cancelled=False
def stop(signum,frame):
    global cancelled
    already_cancelled=cancelled
    cancelled=True
    # A termination signal arriving while an exception is already unwinding
    # must not escape/interrupt the finally block before its signal mask runs.
    # Record cancellation even in internal exception handlers; frame()/commit
    # checks ensure a deferred signal cannot be lost and authorize a write.
    if not already_cancelled and sys.exc_info()[0] is None:
        raise TimeoutError()
def check_cancelled():
    if cancelled:
        raise TimeoutError()
def identity(info):
    return (info.st_dev,info.st_ino)
@contextlib.contextmanager
def tracked_change():
    previous=signal.pthread_sigmask(signal.SIG_BLOCK,STOP_SIGNALS)
    try:
        yield
    finally:
        signal.pthread_sigmask(signal.SIG_SETMASK,previous)
def destination_state(parent,name):
    try:
        info=os.stat(name,dir_fd=parent,follow_symlinks=False)
    except FileNotFoundError:
        return None
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise ValueError()
    return (info.st_dev,info.st_ino,info.st_nlink,info.st_size,info.st_mtime_ns,info.st_ctime_ns,info.st_mode)
def staged_digest(descriptor):
    os.lseek(descriptor,0,os.SEEK_SET)
    digest=hashlib.sha256()
    total=0
    while True:
        chunk=os.read(descriptor,CHUNK)
        if not chunk:
            break
        total+=len(chunk)
        if total>MAX_WRITE:
            raise ValueError()
        digest.update(chunk)
    if total!=size or not hmac.compare_digest(digest.hexdigest(),begin[2]):
        raise ValueError()
def emit(message):
    sys.stdout.write("CR8OR-WRITE/1 "+nonce+" "+message+"\n")
    sys.stdout.flush()
def frame():
    check_cancelled()
    line=sys.stdin.buffer.readline(MAX_LINE+1)
    if not line or len(line)>MAX_LINE or not line.endswith(b"\n"):
        raise ValueError()
    text=line[:-1].decode("ascii")
    prefix="#CR8OR-WRITE/1 "+nonce+" "
    if not text.startswith(prefix):
        raise ValueError()
    value=text[len(prefix):]
    if value == "ABORT":
        raise ValueError()
    return value
def check_chain(parts):
    checking=[]
    try:
        current=os.open("repo",os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
        checking.append(current)
        if identity(os.fstat(current)) != chain[0]:
            raise ValueError()
        for index,part in enumerate(parts,1):
            current=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=current)
            checking.append(current)
            if identity(os.fstat(current)) != chain[index]:
                raise ValueError()
    finally:
        for descriptor in reversed(checking):
            os.close(descriptor)
def disable_terminal_processing():
    if not os.isatty(0):
        return
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
    for event in STOP_SIGNALS:
        signal.signal(event,stop)
    signal.alarm(30)
    if len(sys.argv) != 2 or len(sys.argv[1])>33024:
        raise ValueError()
    request=json.loads(base64.b64decode(sys.argv[1],validate=True))
    if not isinstance(request,dict) or set(request)!={"path","nonce"}:
        raise ValueError()
    if not isinstance(request["nonce"],str) or NONCE_RE.fullmatch(request["nonce"]) is None:
        raise ValueError()
    nonce=request["nonce"]
    relative=request["path"]
    if not isinstance(relative,str) or not relative or len(relative.encode("utf-8"))>MAX_PATH:
        raise ValueError()
    if relative.startswith("/") or "\\" in relative or "\x00" in relative or re.match(r"[A-Za-z]:",relative):
        raise ValueError()
    parts=relative.split("/")
    if any(part in ("",".","..") for part in parts):
        raise ValueError()
    for part in parts:
        lowered=part.lower()
        if lowered==".git" or (lowered.startswith(".env") and lowered!=".env.example") or re.fullmatch(r"(?:secrets?|credentials?|id_rsa|id_ed25519|\.npmrc)",lowered) or lowered.endswith((".pem",".key")):
            raise ValueError()
    directory=os.open("repo",os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    fds.append(directory)
    chain.append(identity(os.fstat(directory)))
    for part in parts[:-1]:
        # Defer catchable cancellation until new filesystem resources have
        # their descriptor/identity recorded for the finally cleanup path.
        with tracked_change():
            made=False
            try:
                child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=directory)
            except FileNotFoundError:
                try:
                    os.mkdir(part,0o700,dir_fd=directory)
                    made=True
                except FileExistsError:
                    pass
                child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=directory)
            fds.append(child)
            child_identity=identity(os.fstat(child))
            if made:
                created.append((directory,part,child_identity))
            directory=child
            chain.append(child_identity)
    destination=destination_state(directory,parts[-1])
    disable_terminal_processing()
    emit("READY")
    begin=frame().split(" ")
    if len(begin)!=3 or begin[0]!="BEGIN" or COUNT_RE.fullmatch(begin[1]) is None or HASH_RE.fullmatch(begin[2]) is None:
        raise ValueError()
    if len(begin[1])>6:
        raise ValueError()
    size=int(begin[1])
    if size>MAX_WRITE:
        raise ValueError()
    stage_name=".cr8or-write-"+secrets.token_hex(24)
    with tracked_change():
        stage=os.open(stage_name,os.O_RDWR|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=directory)
        fds.append(stage)
        stage_identity=identity(os.fstat(stage))
    digest=hashlib.sha256()
    decoder=codecs.getincrementaldecoder("utf-8")("strict")
    received=0
    sequence=0
    while received<size:
        data=frame().split(" ")
        if len(data)!=3 or data[0]!="DATA" or data[1]!=str(sequence):
            raise ValueError()
        chunk=base64.b64decode(data[2],validate=True)
        if base64.b64encode(chunk).decode("ascii")!=data[2] or len(chunk)!=min(CHUNK,size-received):
            raise ValueError()
        decoder.decode(chunk,final=False)
        digest.update(chunk)
        offset=0
        while offset<len(chunk):
            written=os.write(stage,chunk[offset:])
            if written<=0:
                raise OSError()
            offset+=written
        received+=len(chunk)
        sequence+=1
    if frame()!="END":
        raise ValueError()
    decoder.decode(b"",final=True)
    if not hmac.compare_digest(digest.hexdigest(),begin[2]):
        raise ValueError()
    # Keep the stage private until COMMIT, even for broadly readable destinations.
    os.fsync(stage)
    staged_digest(stage)
    emit("STAGED "+str(received))
    if frame()!="COMMIT":
        raise ValueError()
    staged_digest(stage)
    check_chain(parts[:-1])
    if destination_state(directory,parts[-1])!=destination:
        raise ValueError()
    stage_info=os.stat(stage_name,dir_fd=directory,follow_symlinks=False)
    if identity(stage_info)!=stage_identity or not stat.S_ISREG(stage_info.st_mode) or stage_info.st_nlink!=1 or stage_info.st_size!=size:
        raise ValueError()
    if identity(os.fstat(stage))!=stage_identity:
        raise ValueError()
    os.fchmod(stage,(destination[-1]&0o777) if destination is not None else 0o600)
    os.fsync(stage)
    with tracked_change():
        check_cancelled()
        os.replace(stage_name,parts[-1],src_dir_fd=directory,dst_dir_fd=directory)
        committed=True
    os.fsync(directory)
    emit("COMMITTED "+str(received))
except Exception:
    try:
        emit("ERROR")
    except Exception:
        pass
    sys.exit(1)
finally:
    # Session deletion may send another termination signal while ABORT is
    # already cleaning up. Block catchable termination signals atomically so
    # they cannot interrupt the bounded unlink/close path. SIGKILL is excluded.
    signal.pthread_sigmask(signal.SIG_BLOCK,STOP_SIGNALS)
    signal.alarm(0)
    if stage_name is not None and directory is not None and not committed:
        try:
            if identity(os.stat(stage_name,dir_fd=directory,follow_symlinks=False))==stage_identity:
                os.unlink(stage_name,dir_fd=directory)
        except OSError:
            pass
    if not committed:
        for parent,name,expected in reversed(created):
            try:
                info=os.stat(name,dir_fd=parent,follow_symlinks=False)
                if identity(info)==expected and stat.S_ISDIR(info.st_mode):
                    os.rmdir(name,dir_fd=parent)
            except OSError:
                pass
    for descriptor in reversed(fds):
        try:
            os.close(descriptor)
        except OSError:
            pass
`;
