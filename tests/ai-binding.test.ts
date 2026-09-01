import { describe, expect, it } from "vitest";
import { stripDuplicateDeltas } from "../src/ai-binding";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function pipe(chunks: string[]): Promise<string> {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    }
  });

  const reader = source.pipeThrough(stripDuplicateDeltas()).getReader();

  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

const firstEvent = (out: string) =>
  JSON.parse(out.split("\n")[0].slice("data:".length));

/** Shape captured verbatim from the Workers AI Llama 3.3 SSE stream. */
function workersAiChunk(text: string) {
  return {
    choices: [{ delta: { content: text }, finish_reason: null, index: 0 }],
    model: "@cf/meta/llama-3.3-70b-instruct-sd",
    object: "chat.completion.chunk",
    response: text,
    tool_calls: []
  };
}

/** Workers AI repeats a tool call in both the legacy and OpenAI-shaped fields. */
function toolCallChunk() {
  return {
    choices: [
      {
        delta: {
          tool_calls: [
            {
              id: "chatcmpl-tool-1",
              type: "function",
              function: {
                name: "startResearch",
                arguments: '{"question": "Cloudflare Workflows retries"}'
              }
            }
          ]
        },
        index: 0
      }
    ],
    tool_calls: [
      {
        name: "startResearch",
        arguments: { question: "Cloudflare Workflows retries" }
      }
    ]
  };
}

describe("stripDuplicateDeltas", () => {
  it("drops `response` when an OpenAI-style delta carries the same text", async () => {
    const out = await pipe([
      `data: ${JSON.stringify(workersAiChunk(" Cloudflare D"))}\n\n`
    ]);

    const event = firstEvent(out);
    expect(event.response).toBeUndefined();
    expect(event.choices[0].delta.content).toBe(" Cloudflare D");
  });

  it("drops the duplicate top-level tool call that corrupts argument JSON", async () => {
    const out = await pipe([`data: ${JSON.stringify(toolCallChunk())}\n\n`]);

    const event = firstEvent(out);
    expect(event.tool_calls).toBeUndefined();
    expect(event.choices[0].delta.tool_calls).toHaveLength(1);
    expect(event.choices[0].delta.tool_calls[0].function.arguments).toBe(
      '{"question": "Cloudflare Workflows retries"}'
    );
  });

  it("keeps `response` when the delta text differs rather than guessing", async () => {
    const chunk = {
      choices: [{ delta: { content: "abc" }, index: 0 }],
      response: "something else"
    };
    const out = await pipe([`data: ${JSON.stringify(chunk)}\n\n`]);
    expect(firstEvent(out).response).toBe("something else");
  });

  it("preserves `response` when there is no delta to duplicate it", async () => {
    const legacy = { response: "hello from a non-openai model" };
    const out = await pipe([`data: ${JSON.stringify(legacy)}\n\n`]);
    expect(firstEvent(out).response).toBe("hello from a non-openai model");
  });

  it("handles an event split across reads", async () => {
    const payload = JSON.stringify(workersAiChunk("urable Object is"));
    const half = Math.floor(payload.length / 2);

    const out = await pipe([
      `data: ${payload.slice(0, half)}`,
      `${payload.slice(half)}\n\n`
    ]);

    const event = firstEvent(out);
    expect(event.response).toBeUndefined();
    expect(event.choices[0].delta.content).toBe("urable Object is");
  });

  it("passes through [DONE] and non-data lines untouched", async () => {
    const out = await pipe(["data: [DONE]\n\n", ": keep-alive\n\n"]);
    expect(out).toContain("data: [DONE]");
    expect(out).toContain(": keep-alive");
  });

  it("leaves malformed JSON alone rather than dropping the line", async () => {
    const out = await pipe(["data: {not json\n\n"]);
    expect(out).toContain("data: {not json");
  });
});
