import "server-only";

import { findDevelopmentCommand } from "@/lib/security/command-catalogue";
import { ExecutionAuthorizationError } from "@/lib/security/execution-context";
import { shellQuote } from "@/lib/workspace/cloud-path";

export const PRIVATE_CLOUD_COMMAND_LIMITS = Object.freeze({
  commandSeconds: 60,
  handshakeSeconds: 10,
  outputBytes: 64 * 1024,
  responseBytes: 512 * 1024,
  fileBytes: 16 * 1024 * 1024,
  childProcesses: 64,
});

/**
 * Fixed supervisor, never an unrestricted terminal. START is authorized by the
 * server after READY; CANCEL/EOF interrupts the process group. Only this helper
 * writes protocol output; child stdout/stderr is bounded before JSON encoding.
 *
 * These are resource controls, NOT an isolation boundary against hostile npm
 * scripts. A same-UID process can access other sandbox files/network, attack its
 * supervisor or escape the process group. RLIMIT_NPROC is per UID, not per job.
 * Provider-enforced sandbox/identity/credential/network isolation and reliable
 * cancellation must be verified before the separate release restriction moves.
 */
export const PRIVATE_CLOUD_COMMAND_PROGRAM = String.raw`
import json,os,resource,selectors,shutil,signal,stat,subprocess,sys,tempfile,time
ROOT="/workspace"
REPOSITORY="repo"
NODE_CANDIDATES=("/usr/local/bin/node","/usr/bin/node")
NPM_CANDIDATES=("/usr/local/bin/npm","/usr/bin/npm")
INSTALL_ROOTS=("/usr/local/","/usr/")
REQUIRE_UNPRIVILEGED=True
TRUSTED_OWNER_UIDS=(0,)
MAX_SECONDS=60
HANDSHAKE_SECONDS=10
MAX_OUTPUT=65536
MAX_FILE=16777216
MAX_PROCESSES=64
MAX_FRAME=16
COMMANDS={"npm run typecheck":["run","typecheck"],"npm run lint":["run","lint"],"npm test":["test"],"npm run test:unit":["run","test:unit"],"npm run test:integration":["run","test:integration"]}
PREFIX="CR8OR-COMMAND/1 "
child=None
home=None
root_fd=None
repo_fd=None
stopping=False
status="failed"
code=None
confirmed=False
out=bytearray()
err=bytearray()
selector=selectors.DefaultSelector()
def stop(signum,frame):
    global stopping
    stopping=True
def emit(value):
    sys.stdout.write(PREFIX+value+"\n")
    sys.stdout.flush()
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
def trusted_binary(candidates,executable):
    for candidate in candidates:
        try:
            resolved=os.path.realpath(candidate,strict=True)
            if not any(resolved.startswith(prefix) for prefix in INSTALL_ROOTS): continue
            info=os.stat(resolved,follow_symlinks=False)
            if not stat.S_ISREG(info.st_mode) or info.st_uid not in TRUSTED_OWNER_UIDS or info.st_mode&0o022: continue
            if executable and not info.st_mode&0o111: continue
            current=os.path.dirname(resolved)
            while True:
                parent=os.stat(current,follow_symlinks=False)
                if not stat.S_ISDIR(parent.st_mode) or parent.st_uid not in TRUSTED_OWNER_UIDS or parent.st_mode&0o022: raise ValueError()
                if current=="/": break
                current=os.path.dirname(current)
            return resolved
        except (OSError,ValueError):
            continue
    raise ValueError()
def limits():
    os.umask(0o077)
    resource.setrlimit(resource.RLIMIT_CORE,(0,0))
    resource.setrlimit(resource.RLIMIT_CPU,(MAX_SECONDS,MAX_SECONDS))
    resource.setrlimit(resource.RLIMIT_FSIZE,(MAX_FILE,MAX_FILE))
    resource.setrlimit(resource.RLIMIT_NOFILE,(128,128))
    resource.setrlimit(resource.RLIMIT_NPROC,(MAX_PROCESSES,MAX_PROCESSES))
def group_exists():
    if child is None: return False
    child.poll()
    try:
        os.killpg(child.pid,0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
def cancel_group():
    if child is None: return True
    for event,grace in ((signal.SIGTERM,0.5),(signal.SIGKILL,0.5)):
        try: os.killpg(child.pid,event)
        except ProcessLookupError: pass
        except OSError: return False
        deadline=time.monotonic()+grace
        while time.monotonic()<deadline:
            if not group_exists(): return True
            time.sleep(0.02)
    return not group_exists()
def root_matches():
    current=os.open(REPOSITORY,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=root_fd)
    try:
        expected=os.fstat(repo_fd)
        actual=os.fstat(current)
        if (expected.st_dev,expected.st_ino)!=(actual.st_dev,actual.st_ino): raise ValueError()
    finally:
        os.close(current)
def read_control(buffer):
    data=os.read(0,MAX_FRAME+1)
    if not data: return buffer,"EOF"
    buffer+=data
    if len(buffer)>MAX_FRAME: raise ValueError()
    if b"\n" not in buffer: return buffer,None
    line,remaining=buffer.split(b"\n",1)
    # Pipelining START and another instruction is not part of the protocol.
    if remaining: raise ValueError()
    return b"",line
try:
    for event in (signal.SIGTERM,signal.SIGHUP,signal.SIGINT): signal.signal(event,stop)
    if len(sys.argv)!=2 or sys.argv[1] not in COMMANDS: raise ValueError()
    if REQUIRE_UNPRIVILEGED and os.geteuid()==0: raise ValueError()
    node=trusted_binary(NODE_CANDIDATES,True)
    npm=trusted_binary(NPM_CANDIDATES,False)
    # Open every component rather than following an absolute-path symlink.
    current=os.open("/",os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    for part in ROOT.strip("/").split("/"):
        following=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=current)
        os.close(current)
        current=following
    root_fd=current
    repo_fd=os.open(REPOSITORY,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=root_fd)
    disable_echo()
    os.set_blocking(0,False)
    selector.register(0,selectors.EVENT_READ,"control")
    emit("READY")
    buffer=b""
    deadline=time.monotonic()+HANDSHAKE_SECONDS
    started=False
    while not started:
        if stopping:
            status="cancelled"
            break
        if time.monotonic()>=deadline:
            status="timed_out"
            break
        if not selector.select(min(0.05,max(0,deadline-time.monotonic()))): continue
        buffer,line=read_control(buffer)
        if line in (b"CANCEL","EOF"):
            status="cancelled"
            break
        if line is None: continue
        if line!=b"START": raise ValueError()
        root_matches()
        os.fchdir(repo_fd)
        home=tempfile.mkdtemp(prefix="cr8or-command-",dir="/tmp")
        os.chmod(home,0o700)
        for name in ("user.npmrc","global.npmrc"):
            config=os.open(home+"/"+name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
            os.close(config)
        environment={"PATH":"/usr/local/bin:/usr/bin:/bin","HOME":home,"TMPDIR":home,"LANG":"C.UTF-8","LC_ALL":"C.UTF-8","CI":"true","NO_COLOR":"1","NPM_CONFIG_USERCONFIG":home+"/user.npmrc","NPM_CONFIG_GLOBALCONFIG":home+"/global.npmrc","NPM_CONFIG_CACHE":home+"/cache","NPM_CONFIG_UPDATE_NOTIFIER":"false","NPM_CONFIG_FUND":"false","NPM_CONFIG_AUDIT":"false"}
        child=subprocess.Popen([node,npm]+COMMANDS[sys.argv[1]],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=environment,close_fds=True,start_new_session=True,preexec_fn=limits)
        for stream,name in ((child.stdout,"stdout"),(child.stderr,"stderr")):
            os.set_blocking(stream.fileno(),False)
            selector.register(stream,selectors.EVENT_READ,name)
        started=True
    if started:
        deadline=time.monotonic()+MAX_SECONDS
        open_streams=2
        while True:
            if stopping:
                status="cancelled"
                break
            if time.monotonic()>=deadline:
                status="timed_out"
                break
            if child.poll() is not None and open_streams==0:
                code=child.returncode
                status="succeeded" if code==0 else "failed"
                if group_exists(): status="failed"
                break
            events=selector.select(min(0.05,max(0,deadline-time.monotonic())))
            for key,_ in events:
                if key.data=="control":
                    buffer,line=read_control(buffer)
                    if line in (b"CANCEL","EOF"):
                        stopping=True
                        break
                    if line is not None: raise ValueError()
                else:
                    data=os.read(key.fd,8192)
                    if not data:
                        selector.unregister(key.fileobj)
                        open_streams-=1
                        continue
                    if len(out)+len(err)+len(data)>MAX_OUTPUT:
                        status="output_limit"
                        break
                    (out if key.data=="stdout" else err).extend(data)
            if status=="output_limit": break
    confirmed=cancel_group()
    if child is not None: code=child.poll()
except Exception:
    status="failed"
    confirmed=cancel_group()
    if child is not None: code=child.poll()
finally:
    # The supervisor emits no exception text, filesystem paths or environment.
    # Group disappearance only confirms the observed group, never escaped jobs.
    if child is not None:
        confirmed=cancel_group() and confirmed
        for stream in (child.stdout,child.stderr):
            if stream is not None: stream.close()
    selector.close()
    for descriptor in (repo_fd,root_fd):
        if descriptor is not None:
            try: os.close(descriptor)
            except OSError: pass
    if home is not None:
        try: shutil.rmtree(home)
        except OSError:
            if status=="succeeded": status="failed"
    if status in ("timed_out","cancelled","output_limit"):
        # Partial output is never presented as a complete successful result.
        out.clear()
        err.clear()
    decoded_out=out.decode("utf-8","replace")
    decoded_err=err.decode("utf-8","replace")
    if len(decoded_out.encode("utf-8"))+len(decoded_err.encode("utf-8"))>MAX_OUTPUT:
        status="output_limit"
        decoded_out=""
        decoded_err=""
    emit("RESULT "+json.dumps({"status":status,"exitCode":code,"stdout":decoded_out,"stderr":decoded_err,"cancellationConfirmed":confirmed},ensure_ascii=True,separators=(",",":")))
`;

export function buildPrivateCloudCommand(commandKey: string): string {
  const entry = findDevelopmentCommand(commandKey);
  if (!entry) throw new ExecutionAuthorizationError(403, "The development command is not permitted.");
  return `/usr/bin/python3 -I -S -u -c ${shellQuote(PRIVATE_CLOUD_COMMAND_PROGRAM)} ${shellQuote(entry.key)}`;
}
