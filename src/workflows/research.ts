import { AgentWorkflow } from "agents/workflows";
import type { AgentWorkflowEvent, AgentWorkflowStep } from "agents/workflows";
import type { WorkflowStepConfig } from "cloudflare:workers";
import { searchHackerNews, searchWikipedia, type Source } from "../sources";
import { cachedSearch, type CacheStats } from "../cache";
// Type-only: keeps the class re-export in server.ts from forming an import cycle.
import type { BriefingAgent } from "../server";

export type ResearchParams = {
  briefId: string;
  question: string;
};

const MAX_SOURCES = 4;

/** Network steps retry; the model steps fail differently and retry less. */
const NETWORK_STEP: WorkflowStepConfig = {
  retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
  timeout: "30 seconds"
};

const MODEL_STEP: WorkflowStepConfig = {
  retries: { limit: 2, delay: "2 seconds", backoff: "exponential" },
  timeout: "2 minutes"
};

export class ResearchWorkflow extends AgentWorkflow<
  BriefingAgent,
  ResearchParams
> {
  async run(
    event: AgentWorkflowEvent<ResearchParams>,
    step: AgentWorkflowStep
  ) {
    const { briefId, question } = event.payload;

    await step.mergeAgentState({
      status: "researching",
      currentStep: "plan",
      percent: 0.05
    });

    // Step 1 — model. Fails on model errors or a schema violation.
    const queries = await step.do("plan-queries", MODEL_STEP, async () =>
      this.agent.planQueries(question)
    );

    await this.reportProgress({
      step: "search-wikipedia",
      status: "running",
      percent: 0.2,
      message: `Searching ${queries.length} queries on Wikipedia`
    });

    // Steps 2 and 3 — network. Fail on rate limits, timeouts and 5xx.
    const wikipedia = await step.do(
      "search-wikipedia",
      NETWORK_STEP,
      async () => {
        // Budget lives on the agent: step bodies re-run on retry, so a counter
        // held here would never drain and the step could never recover.
        if (await this.agent.consumeFault()) {
          throw new Error("injected fault: simulated upstream failure");
        }
        return gather(
          queries,
          "wikipedia",
          searchWikipedia,
          this.env.SOURCE_CACHE
        );
      }
    );

    await this.reportProgress({
      step: "search-hackernews",
      status: "running",
      percent: 0.35,
      message: "Searching Hacker News"
    });

    const hackernews = await step.do(
      "search-hackernews",
      NETWORK_STEP,
      async () =>
        gather(queries, "hackernews", searchHackerNews, this.env.SOURCE_CACHE)
    );

    const cache = {
      hits: wikipedia.cache.hits + hackernews.cache.hits,
      misses: wikipedia.cache.misses + hackernews.cache.misses
    };

    const sources = selectSources(
      question,
      wikipedia.sources,
      hackernews.sources
    );

    if (sources.length === 0) {
      const message = `No relevant sources found for: ${question}`;
      await step.mergeAgentState({ status: "error", currentStep: null });
      await step.reportError(message);
      throw new Error(message);
    }

    // Human-in-the-loop gate: durable, so it survives eviction and a page refresh.
    await step.mergeAgentState({
      status: "awaiting-approval",
      currentStep: "approval",
      percent: 0.5
    });
    await this.reportProgress({
      step: "approval",
      status: "pending",
      percent: 0.5,
      message: `Approve ${sources.length} sources before synthesis (${cache.hits} cached, ${cache.misses} fetched)`,
      sources
    });

    await this.waitForApproval(step, { timeout: "1 hour" });

    await step.mergeAgentState({
      status: "researching",
      currentStep: "summarize"
    });

    // Step 4..n — one model call per source, so a single bad source retries alone.
    const summaries: string[] = [];
    for (const [i, source] of sources.entries()) {
      const summary = await step.do(`summarize-${i}`, MODEL_STEP, async () =>
        this.agent.summarizeSource(question, source)
      );
      summaries.push(summary);

      await this.reportProgress({
        step: "summarize",
        status: "running",
        percent: 0.55 + ((i + 1) / sources.length) * 0.3,
        message: `Summarized ${i + 1} of ${sources.length} sources`
      });
    }

    const briefMd = await step.do("synthesize-brief", MODEL_STEP, async () =>
      this.agent.synthesizeBrief(question, sources, summaries)
    );

    await step.do("persist-brief", async () =>
      this.agent.saveBrief({
        id: briefId,
        question,
        briefMd,
        sources,
        status: "complete"
      })
    );

    await step.mergeAgentState({
      status: "complete",
      currentStep: null,
      percent: 1
    });
    await step.reportComplete({ briefId, question, briefMd, sources, cache });

    return { briefId };
  }
}

/** Runs one search per query and tolerates individual query failures. */
async function gather(
  queries: string[],
  provider: string,
  search: (q: string) => Promise<Source[]>,
  kv?: KVNamespace
): Promise<{ sources: Source[]; cache: CacheStats }> {
  const cache: CacheStats = { hits: 0, misses: 0 };

  const results = await Promise.allSettled(
    queries.map((q) => cachedSearch(kv, provider, q, search, cache))
  );

  // Every query failing means the provider is down — surface it so the step retries.
  if (results.length > 0 && results.every((r) => r.status === "rejected")) {
    const [first] = results as PromiseRejectedResult[];
    throw first.reason instanceof Error
      ? first.reason
      : new Error(String(first.reason));
  }

  return {
    sources: results.flatMap((r) => (r.status === "fulfilled" ? r.value : [])),
    cache
  };
}

function dedupe(sources: Source[]): Source[] {
  const seen = new Set<string>();
  return sources.filter((s) => !seen.has(s.url) && seen.add(s.url));
}

/**
 * Keyword search happily returns "Email" for "Cloudflare Workflows retries",
 * so drop anything sharing no meaningful term with the question, then take
 * from each provider in turn — concatenating lets one provider crowd out the
 * other entirely.
 */
export function selectSources(
  question: string,
  wikipedia: Source[],
  hackernews: Source[],
  max = MAX_SOURCES
): Source[] {
  const terms = question.toLowerCase().match(/[a-z0-9]{4,}/g) ?? [];

  const relevant = (list: Source[]) =>
    dedupe(list).filter((s) => {
      const haystack = `${s.title} ${s.extract}`.toLowerCase();
      return terms.some((t) => haystack.includes(t));
    });

  const wiki = relevant(wikipedia);
  const hn = relevant(hackernews);

  const picked: Source[] = [];
  for (
    let i = 0;
    picked.length < max && (i < wiki.length || i < hn.length);
    i++
  ) {
    if (wiki[i]) picked.push(wiki[i]);
    if (hn[i] && picked.length < max) picked.push(hn[i]);
  }
  return picked;
}
