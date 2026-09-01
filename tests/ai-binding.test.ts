import { describe, expect, it } from "vitest";
import { stripRedundantResponseField } from "../src/ai-binding";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function pipe(chunks: string[]): Promise<string> {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    }
  });

  const reader = source
    .pipeThrough(stripRedundantResponseField())
    .getReader();

  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

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

describe("stripRedundantResponseField", () => {
  it("drops `response` when an OpenAI-style delta carries the same text", async () => {
    const out = await pipe([
      `data: ${JSON.stringify(workersAiChunk(" Cloudflare D"))}\n\n`
    ]);

    const event = JSON.parse(out.split("\n")[0].slice("data:".length));
    expect(event.response).toBeUndefined();
    expect(event.choices[0].delta.content).toBe(" Cloudflare D");
  });

  it("preserves `response` when there is no delta to duplicate it", async () => {
    const legacy = { response: "hello from a non-openai model" };
    const out = await pipe([`data: ${JSON.stringify(legacy)}\n\n`]);

    const event = JSON.parse(out.split("\n")[0].slice("data:".length));
    expect(event.response).toBe("hello from a non-openai model");
  });

  it("handles an event split across reads", async () => {
    const payload = JSON.stringify(workersAiChunk("urable Object is"));
    const half = Math.floor(payload.length / 2);

    const out = await pipe([
      `data: ${payload.slice(0, half)}`,
      `${payload.slice(half)}\n\n`
    ]);

    const event = JSON.parse(out.split("\n")[0].slice("data:".length));
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
