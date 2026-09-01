/**
 * Workaround for workers-ai-provider@3.3.1 (newest release peered to ai@6).
 *
 * Its stream mapper emits a text delta for the top-level `response` field AND
 * another for `choices[0].delta.content`. Workers AI populates both with the
 * same text, so every streamed token arrives twice:
 *   "A Cloud A Cloudflare Durableflare Durable Object is a Object is a server..."
 *
 * Fixed at the source by dropping the redundant `response` field before the
 * provider parses it. Upstream fix landed in v4, which requires ai@7.
 */

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function rewriteSseLine(line: string): string {
  if (!line.startsWith("data:")) return line;

  const payload = line.slice("data:".length).trim();
  if (!payload || payload === "[DONE]") return line;

  try {
    const event = JSON.parse(payload);
    // Only drop the duplicate. Models that report text solely via `response`,
    // with no OpenAI-style delta, must keep streaming.
    if (event?.choices?.[0]?.delta && "response" in event) {
      delete event.response;
      return `data: ${JSON.stringify(event)}`;
    }
  } catch {
    return line;
  }
  return line;
}

export function stripRedundantResponseField(): TransformStream<
  Uint8Array,
  Uint8Array
> {
  let buffered = "";

  return new TransformStream({
    transform(chunk, controller) {
      buffered += decoder.decode(chunk, { stream: true });
      // An SSE event can span reads; only forward whole lines.
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        controller.enqueue(encoder.encode(`${rewriteSseLine(line)}\n`));
      }
    },
    flush(controller) {
      if (buffered) {
        controller.enqueue(encoder.encode(rewriteSseLine(buffered)));
      }
    }
  });
}

/** Wraps an AI binding so streamed responses carry each token exactly once. */
export function withDedupedTextDeltas(ai: Ai): Ai {
  return new Proxy(ai, {
    get(target, prop, receiver) {
      if (prop !== "run") return Reflect.get(target, prop, receiver);

      return async (...args: unknown[]) => {
        const run = Reflect.get(target, "run", receiver) as (
          ...a: unknown[]
        ) => Promise<unknown>;
        const result = await run.apply(target, args);

        return result instanceof ReadableStream
          ? result.pipeThrough(stripRedundantResponseField())
          : result;
      };
    }
  });
}
