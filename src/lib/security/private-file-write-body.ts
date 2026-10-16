import "server-only";

/** Includes JSON escaping and metadata; individual runtimes may impose smaller file limits. */
export const PRIVATE_FILE_WRITE_BODY_LIMITS = Object.freeze({ bytes: 2 * 1024 * 1024, timeoutMs: 10_000 });

export class PrivateFileWriteBodyError extends Error {
  constructor(readonly status: 400 | 413) {
    super(status === 413 ? "File request exceeds the allowed size." : "Invalid file request.");
    this.name = "PrivateFileWriteBodyError";
  }
}

/** Read only after the central authentication/origin checks have succeeded. */
export async function readPrivateFileWriteBody(request: Request): Promise<unknown> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared))) throw new PrivateFileWriteBodyError(400);
    if (Number(declared) > PRIVATE_FILE_WRITE_BODY_LIMITS.bytes) throw new PrivateFileWriteBodyError(413);
  }
  if (!request.body || request.signal.aborted) throw new PrivateFileWriteBodyError(400);

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  let stopped = false;
  try {
    const bodyReader = request.body.getReader();
    reader = bodyReader;
    const deadline = performance.now() + PRIVATE_FILE_WRITE_BODY_LIMITS.timeoutMs;
    const interrupted = new Promise<never>((_, reject) => {
      abort = () => { stopped = true; reject(new PrivateFileWriteBodyError(400)); };
      timer = setTimeout(abort, PRIVATE_FILE_WRITE_BODY_LIMITS.timeoutMs);
      request.signal.addEventListener("abort", abort, { once: true });
      if (request.signal.aborted) abort();
    });
    const checkReading = () => {
      // Also bound immediately fulfilled or empty chunks, which can otherwise
      // starve the timer while continuously scheduling promise microtasks.
      if (stopped || request.signal.aborted || performance.now() >= deadline) throw new PrivateFileWriteBodyError(400);
    };
    const consume = async () => {
      // A fixed buffer prevents tiny chunks from accumulating array/string
      // overhead beyond the byte limit. Decode only the bytes actually read.
      const buffer = new Uint8Array(PRIVATE_FILE_WRITE_BODY_LIMITS.bytes);
      let bytes = 0;
      while (true) {
        checkReading();
        const chunk = await bodyReader.read();
        checkReading();
        if (chunk.done) break;
        if (chunk.value.byteLength > buffer.length - bytes) throw new PrivateFileWriteBodyError(413);
        buffer.set(chunk.value, bytes);
        bytes += chunk.value.byteLength;
      }
      if (declared !== null && Number(declared) !== bytes) throw new PrivateFileWriteBodyError(400);
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, bytes));
    };
    // One race for the entire read avoids retaining an interruption-promise
    // reaction for every chunk until the request completes or is cancelled.
    const body = await Promise.race([consume(), interrupted]);
    checkReading();
    return JSON.parse(body) as unknown;
  } catch (error) {
    stopped = true;
    // Do not wait for an untrusted stream's cancellation callback to settle.
    if (reader) void reader.cancel().catch(() => undefined);
    if (error instanceof PrivateFileWriteBodyError) throw error;
    // JSON, decoding, and transport errors can contain submitted source text.
    throw new PrivateFileWriteBodyError(400);
  } finally {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (abort) request.signal.removeEventListener("abort", abort);
    try { reader?.releaseLock(); } catch { /* A cancelled pending read may still own its lock. */ }
  }
}
