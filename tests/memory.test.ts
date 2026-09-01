import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";

const instance = (name: string) => getAgentByName(env.BriefingAgent, name);

describe("phase 3 — memory", () => {
  it("persists briefs across separate agent lookups", async () => {
    const first = await instance("memory-1");
    await first.saveBrief({
      id: "brief-a",
      question: "How are Durable Objects billed?",
      briefMd: "Billing is per request and per GB-second of active duration.",
      sources: [{ title: "Pricing", url: "https://example.invalid/pricing" }],
      status: "complete"
    });

    // A fresh stub for the same name must see the write.
    const second = await instance("memory-1");
    const rows = await second.listBriefs();

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("brief-a");
    expect(rows[0].question).toBe("How are Durable Objects billed?");
  });

  it("updates broadcast state alongside the SQL write", async () => {
    const agent = await instance("memory-2");
    await agent.saveBrief({
      id: "brief-b",
      question: "What is Workers AI?",
      briefMd: "Serverless inference on Cloudflare's edge network.",
      sources: [],
      status: "complete"
    });

    const state = await agent.state;
    expect(state.briefCount).toBe(1);
    expect(state.lastBriefId).toBe("brief-b");
  });

  it("keeps instances isolated from each other", async () => {
    const other = await instance("memory-3");
    expect(await other.listBriefs()).toHaveLength(0);
  });

  it("searches stored briefs by question and body", async () => {
    const agent = await instance("memory-4");
    await agent.saveBrief({
      id: "brief-c",
      question: "How do Cloudflare Workflows retry?",
      briefMd: "Steps retry with configurable exponential backoff.",
      sources: [],
      status: "complete"
    });
    await agent.saveBrief({
      id: "brief-d",
      question: "What is Vectorize?",
      briefMd: "A vector database for embeddings.",
      sources: [],
      status: "complete"
    });

    expect(await agent.searchBriefs("Workflows")).toHaveLength(1);
    expect(await agent.searchBriefs("exponential")).toHaveLength(1);
    expect(await agent.searchBriefs("nothing-matches-this")).toHaveLength(0);
  });
});
