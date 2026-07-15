export interface CollectCfSseOptions {
  onDelta?: (delta: string) => void | Promise<void>;
  signal?: AbortSignal;
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

/** Collect Workers-compatible `data: {"response":"..."}` SSE while exposing
 * decoded model deltas to a temporary downstream draft. */
export async function collectCfSseText(
  stream: ReadableStream<Uint8Array>,
  options: CollectCfSseOptions = {}
): Promise<string> {
  if (options.signal?.aborted) throw abortError();

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let output = "";
  let providerDone = false;

  const consumeEvent = async (eventText: string): Promise<void> => {
    const data = eventText
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!data) return;
    if (providerDone) throw new Error("Provider stream produced an event after DONE");
    if (data === "[DONE]") {
      providerDone = true;
      return;
    }
    const parsed = JSON.parse(data) as {
      response?: unknown;
      error?: string | { message?: string; code?: string | number };
    };
    if (parsed.error) {
      const message = typeof parsed.error === "string"
        ? parsed.error
        : parsed.error.message || `Provider stream error${parsed.error.code ? ` (${parsed.error.code})` : ""}`;
      throw new Error(message);
    }
    if (typeof parsed.response !== "string") return;
    output += parsed.response;
    await options.onDelta?.(parsed.response);
  };

  const drain = async (allowRemainder: boolean): Promise<void> => {
    let match: RegExpMatchArray | null;
    while ((match = buffer.match(/\r?\n\r?\n/))) {
      const end = match.index ?? 0;
      await consumeEvent(buffer.slice(0, end));
      buffer = buffer.slice(end + match[0].length);
    }
    if (allowRemainder && buffer.trim()) {
      await consumeEvent(buffer);
      buffer = "";
    }
  };

  const cancelReader = () => {
    void reader.cancel(options.signal?.reason).catch(() => undefined);
  };
  options.signal?.addEventListener("abort", cancelReader, { once: true });

  try {
    while (!providerDone) {
      if (options.signal?.aborted) throw abortError();
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      await drain(false);
    }
    if (options.signal?.aborted) throw abortError();
    buffer += decoder.decode();
    await drain(true);
    if (!providerDone) throw new Error("Provider stream ended before DONE");
    return output;
  } finally {
    options.signal?.removeEventListener("abort", cancelReader);
    reader.releaseLock();
  }
}
