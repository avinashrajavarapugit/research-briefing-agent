import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";

const instance = (name: string) => getAgentByName(env.BriefingAgent, name);

describe("fault injection budget", () => {
  it("drains once per attempt and then stops failing", async () => {
    const agent = await instance("fault-1");
    await agent.armFaultInjection(2);

    expect(await agent.consumeFault()).toBe(true);
    expect(await agent.consumeFault()).toBe(true);
    expect(await agent.consumeFault()).toBe(false);
  });

  it("is durable across stubs, so a retried step still sees the budget", async () => {
    const armed = await instance("fault-2");
    await armed.armFaultInjection(1);

    // A workflow retry reaches the agent through a fresh stub.
    const retry = await instance("fault-2");
    expect(await retry.faultBudget()).toBe(1);
    expect(await retry.consumeFault()).toBe(true);
    expect(await retry.faultBudget()).toBe(0);
  });

  it("does not fail when unarmed", async () => {
    const agent = await instance("fault-3");
    expect(await agent.consumeFault()).toBe(false);
  });

  it("treats a negative budget as disarmed", async () => {
    const agent = await instance("fault-4");
    await agent.armFaultInjection(-5);
    expect(await agent.faultBudget()).toBe(0);
    expect(await agent.consumeFault()).toBe(false);
  });
});
