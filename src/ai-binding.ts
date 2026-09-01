/**
 * Workaround for workers-ai-provider@3.3.1 (newest release peered to ai@6).
 *
 * Its stream mapper reads each SSE chunk twice: once from the legacy top-level
 * fields and again from the OpenAI-compatible `choices[0].delta`. Workers AI
 * populates both, so everything arrives doubled.
 *
 *   text       -> "A Cloud A Cloudflare Durableflare Durable Object is a..."
 *   tool calls -> args accumulate into one slot as '{"q":"x"}{"q":"x"}', which
 *                 is invalid JSON, so the tool runs with {} and fails validation
 *
 * Fixed at the source by dropping the redundant top-level copy before the
 * provider parses it. Upstream fix landed in v4, which requires ai@7.
 */

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function rewriteSseLine(line: string): string {
  if (!line.startsWith("data:")) return line;

  const payload = line.slice("data:".length).trim();
  if (!payload || payload === "[DONE]") return line;

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(payload);
  } catch {
    return line;
  }

  const delta = (
    event?.choices as Array<{ delta?: Record<string, unknown> }> | undefined
  )?.[0]?.delta;
  if (!delta) return line;

  let changed = false;

  // Drop only an exact duplicate, so a model that reports text solely via
  // `response` keeps streaming.
  if (
    typeof delta.content === "string" &&
    delta.content.length > 0 &&
    event.response === delta.content
  ) {
    delete event.response;
    changed = true;
  }

  if (
    Array.isArray(delta.tool_calls) &&
    delta.tool_calls.length > 0 &&
    Array.isArray(event.tool_calls) &&
    event.tool_calls.length > 0
  ) {
    delete event.tool_calls;
    changed = true;
  }

  return changed ? `data: ${JSON.stringify(event)}` : line;
}

export function stripDuplicateDeltas(): TransformStream<
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
          ? result.pipeThrough(stripDuplicateDeltas())
          : result;
      };
    }
  });
}
