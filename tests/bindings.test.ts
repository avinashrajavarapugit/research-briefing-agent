import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import worker from "../src/server";

describe("phase 0 — bindings and routing", () => {
  it("exposes the AI and agent bindings", () => {
    expect(env.AI).toBeDefined();
    expect(env.BriefingAgent).toBeDefined();
  });

  it("resolves a named agent instance", async () => {
    const agent = await getAgentByName(env.BriefingAgent, "test-phase-0");
    expect(agent).toBeDefined();
  });

  it("404s an unrouted path", async () => {
    const res = await worker.fetch(new Request("http://example.com/nope"), env);
    expect(res.status).toBe(404);
  });
});
