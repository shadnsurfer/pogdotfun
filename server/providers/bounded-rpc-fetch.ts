/** Solana's HTTP transport otherwise leaves both fetch and response.text() unbounded. */
export function boundedRpcFetch(
  options: {
    timeoutMs?: number;
    maximumResponseBytes?: number;
    fetch?: typeof fetch;
  } = {},
): typeof fetch {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maximumResponseBytes = options.maximumResponseBytes ?? 8 * 1024 * 1024;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000)
    throw new Error('RPC timeout must be between 1 and 30000 milliseconds.');
  if (
    !Number.isSafeInteger(maximumResponseBytes) ||
    maximumResponseBytes < 1 ||
    maximumResponseBytes > 16 * 1024 * 1024
  )
    throw new Error('RPC response size limit is invalid.');
  const fetcher = options.fetch ?? fetch;
  return async (input, init) => {
    const controller = new AbortController();
    const caller = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const cancelBody = () => {
      void reader?.cancel().catch(() => {});
    };
    const abortCaller = () => controller.abort(new Error('Solana RPC request aborted.'));
    let abort!: () => void;
    const deadline = new Promise<never>((_resolve, reject) => {
      abort = () => {
        cancelBody();
        reject(controller.signal.reason);
      };
      controller.signal.addEventListener('abort', abort, { once: true });
    });
    caller?.addEventListener('abort', abortCaller, { once: true });
    if (caller?.aborted) abortCaller();
    const timer = setTimeout(
      () => controller.abort(new Error('Solana RPC request timed out.')),
      timeoutMs,
    );
    const work = async () => {
      controller.signal.throwIfAborted();
      const response = await fetcher(input, {
        ...init,
        redirect: 'error',
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        void response.body?.cancel().catch(() => {});
        controller.signal.throwIfAborted();
      }
      const contentLength = response.headers.get('content-length');
      if (
        contentLength &&
        /^\d+$/.test(contentLength) &&
        Number(contentLength) > maximumResponseBytes
      ) {
        void response.body?.cancel().catch(() => {});
        throw new Error('Solana RPC response exceeds the size limit.');
      }
      const chunks: Uint8Array[] = [];
      let length = 0;
      reader = response.body?.getReader();
      while (reader) {
        const part = await reader.read();
        controller.signal.throwIfAborted();
        if (part.done) break;
        length += part.value.byteLength;
        if (length > maximumResponseBytes)
          throw new Error('Solana RPC response exceeds the size limit.');
        chunks.push(part.value);
      }
      controller.signal.throwIfAborted();
      // Buffer before returning: web3's subsequent text()/JSON parse cannot wait
      // on a network body after the request deadline has been cleared.
      return new Response(response.body ? Buffer.concat(chunks, length) : null, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    };
    try {
      // A custom transport which ignores AbortSignal must also release its caller.
      return await Promise.race([work(), deadline]);
    } catch (error) {
      controller.abort();
      cancelBody();
      throw error;
    } finally {
      clearTimeout(timer);
      caller?.removeEventListener('abort', abortCaller);
      controller.signal.removeEventListener('abort', abort);
    }
  };
}
