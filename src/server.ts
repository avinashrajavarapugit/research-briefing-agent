import { createWorkersAI } from "workers-ai-provider";
import { callable, routeAgentRequest, type Schedule } from "agents";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  convertToModelMessages,
  generateObject,
  generateText,
  pruneMessages,
  stepCountIs,
  streamText,
  tool
} from "ai";
import { z } from "zod";
import { withDedupedTextDeltas } from "./ai-binding";
import type { Source } from "./sources";

export { ResearchWorkflow } from "./workflows/research";

/** Assignment requirement: the LLM is Llama 3.3 on Workers AI. */
const MODEL_ID = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const SYSTEM_PROMPT = `You are a research briefing assistant.

You help the user investigate a question and produce a short, well-sourced brief.
Be concise and concrete. Prefer specifics over generalities. If you are unsure about
a fact, say so plainly rather than inventing detail.

You remember every brief you have produced for this user. When the user refers to
earlier work ("what did you find about X", "the last brief"), call recallBriefs
before answering instead of guessing.

Format answers as short markdown. Do not pad with filler or restate the question.`;

export type BriefStatus = "researching" | "complete" | "error";

export type BriefRow = {
  id: string;
  question: string;
  brief_md: string;
  sources_json: string;
  status: BriefStatus;
  created_at: number;
};

export type BriefingState = {
  status: "idle" | "researching" | "awaiting-approval" | "complete" | "error";
  activeInstanceId: string | null;
  currentStep: string | null;
  percent: number;
  briefCount: number;
  lastBriefId: string | null;
};

export class BriefingAgent extends AIChatAgent<Env, BriefingState> {
  maxPersistedMessages = 100;
  chatRecovery = true;
  // Wait for MCP connections to be re-established after hibernation before
  // processing a message, so MCP tools aren't intermittently missing.
  waitForMcpConnections = true;

  // Kept deliberately small: every setState broadcasts to all connected clients.
  // Brief bodies live in SQL, not here.
  initialState: BriefingState = {
    status: "idle",
    activeInstanceId: null,
    currentStep: null,
    percent: 0,
    briefCount: 0,
    lastBriefId: null
  };

  onStart() {
    this.sql`CREATE TABLE IF NOT EXISTS briefs (
      id TEXT PRIMARY KEY,
      question TEXT NOT NULL,
      brief_md TEXT NOT NULL,
      sources_json TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`;

    // Configure OAuth popup behavior for MCP servers that require authentication
    this.mcp.configureOAuthCallback({
      customHandler: (result) => {
        if (result.authSuccess) {
          return new Response("<script>window.close();</script>", {
            headers: { "content-type": "text/html" },
            status: 200
          });
        }
        return new Response(
          `Authentication Failed: ${result.authError || "Unknown error"}`,
          { headers: { "content-type": "text/plain" }, status: 400 }
        );
      }
    });
  }

  /** Called over RPC by ResearchWorkflow once a brief is synthesized. */
  saveBrief(brief: {
    id: string;
    question: string;
    briefMd: string;
    sources: unknown[];
    status: BriefStatus;
  }) {
    this.sql`INSERT OR REPLACE INTO briefs
      (id, question, brief_md, sources_json, status, created_at)
      VALUES (${brief.id}, ${brief.question}, ${brief.briefMd},
              ${JSON.stringify(brief.sources)}, ${brief.status}, ${Date.now()})`;

    const [{ n }] = this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM briefs`;

    this.setState({
      ...this.state,
      briefCount: n,
      lastBriefId: brief.id
    });

    return brief.id;
  }

  @callable()
  listBriefs(limit = 20) {
    return this.sql<BriefRow>`SELECT * FROM briefs
      ORDER BY created_at DESC LIMIT ${limit}`;
  }

  getBrief(id: string): BriefRow | undefined {
    return this.sql<BriefRow>`SELECT * FROM briefs WHERE id = ${id}`[0];
  }

  searchBriefs(query: string, limit = 5) {
    const like = `%${query}%`;
    return this.sql<BriefRow>`SELECT * FROM briefs
      WHERE question LIKE ${like} OR brief_md LIKE ${like}
      ORDER BY created_at DESC LIMIT ${limit}`;
  }

  private model() {
    const workersai = createWorkersAI({
      binding: withDedupedTextDeltas(this.env.AI)
    });
    return workersai(MODEL_ID);
  }

  // ---- Called over RPC by ResearchWorkflow ----

  async planQueries(question: string): Promise<string[]> {
    try {
      const { object } = await generateObject({
        model: this.model(),
        schema: z.object({
          queries: z
            .array(z.string())
            .min(1)
            .max(3)
            .describe("Short keyword search queries, 2-6 words each")
        }),
        prompt: `Break this research question into up to 3 short keyword search queries suitable for an encyclopedia and a tech news site. Return keywords only, no punctuation.\n\nQuestion: ${question}`
      });
      return object.queries.slice(0, 3);
    } catch {
      // Small models drop the schema often enough that failing the run here
      // would be worse than searching the question verbatim.
      return [question];
    }
  }

  async summarizeSource(question: string, source: Source): Promise<string> {
    const { text } = await generateText({
      model: this.model(),
      maxOutputTokens: 320,
      prompt: `Question: ${question}

Source: ${source.title} (${source.url})
${source.extract}

In at most three sentences, state only what this source contributes to answering the question. If it contributes nothing, reply exactly: Not relevant.`
    });
    return text.trim();
  }

  async synthesizeBrief(
    question: string,
    sources: Source[],
    summaries: string[]
  ): Promise<string> {
    const findings = sources
      .map((s, i) => `[${i + 1}] ${s.title} — ${s.url}\n${summaries[i] ?? ""}`)
      .join("\n\n");

    const { text } = await generateText({
      model: this.model(),
      system: SYSTEM_PROMPT,
      maxOutputTokens: 900,
      prompt: `Write a research brief answering: ${question}

Use only the findings below and cite them inline as [1], [2]. Do not invent sources.

${findings}

Use exactly this structure:
## Answer
Two to four sentences.

## Key points
- Bullets, each ending with a citation.

## Sources
- [n] Title — URL`
    });

    return text.trim();
  }

  // ---- Workflow lifecycle ----

  async onWorkflowProgress(
    _workflowName: string,
    instanceId: string,
    progress: unknown
  ) {
    this.broadcast(
      JSON.stringify({ type: "workflow-progress", instanceId, progress })
    );
  }

  async onWorkflowComplete(
    _workflowName: string,
    _instanceId: string,
    result?: unknown
  ) {
    const brief = result as { briefMd?: string } | undefined;

    if (brief?.briefMd) {
      // The chat turn may still be persisting; appending to a stale
      // this.messages duplicates the assistant message.
      await this.waitUntilStable({ timeout: 30_000 });

      // persistMessages, not saveMessages: the brief is the final answer and
      // must not trigger another model turn.
      await this.persistMessages([
        ...this.messages,
        {
          id: crypto.randomUUID(),
          role: "assistant" as const,
          parts: [{ type: "text" as const, text: brief.briefMd }]
        }
      ]);
    }

    this.setState({
      ...this.state,
      status: "complete",
      activeInstanceId: null,
      currentStep: null,
      percent: 1
    });
  }

  async onWorkflowError(
    _workflowName: string,
    instanceId: string,
    error: string
  ) {
    this.setState({
      ...this.state,
      status: "error",
      activeInstanceId: null,
      currentStep: null
    });
    this.broadcast(
      JSON.stringify({ type: "workflow-error", instanceId, error })
    );
  }

  @callable()
  async approveResearch(instanceId: string) {
    await this.approveWorkflow(instanceId, { reason: "Approved in chat UI" });
    this.setState({ ...this.state, status: "researching" });
  }

  @callable()
  async rejectResearch(instanceId: string, reason = "Rejected in chat UI") {
    await this.rejectWorkflow(instanceId, { reason });
  }

  /**
   * A run left parked at the approval gate would otherwise block every later
   * question, so confirm the tracked instance is really still alive.
   */
  private async hasLiveResearch(): Promise<boolean> {
    const active = this.state.activeInstanceId;
    if (!active) return false;

    const tracked = this.getWorkflow(active);
    const live =
      tracked &&
      ["queued", "running", "paused", "waiting"].includes(
        String(tracked.status)
      );

    if (!live) {
      this.setState({
        ...this.state,
        status: "idle",
        activeInstanceId: null,
        currentStep: null,
        percent: 0
      });
      return false;
    }
    return true;
  }

  /** Wired to the UI's Clear button so a fresh demo is not blocked by an old run. */
  @callable()
  async resetResearch() {
    const active = this.state.activeInstanceId;
    if (active) {
      // Unsupported under `wrangler dev`; state is reset either way.
      await this.terminateWorkflow(active).catch(() => undefined);
    }
    this.setState({ ...this.initialState, briefCount: this.state.briefCount });
  }

  @callable()
  async addServer(name: string, url: string) {
    return await this.addMcpServer(name, url);
  }

  @callable()
  async removeServer(serverId: string) {
    await this.removeMcpServer(serverId);
  }

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const mcpTools = this.mcp.getAITools();
    const workersai = createWorkersAI({
      binding: withDedupedTextDeltas(this.env.AI)
    });

    const result = streamText({
      model: workersai(MODEL_ID),
      system: SYSTEM_PROMPT,
      // Prune old tool calls and reasoning to save tokens on long conversations
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages",
        reasoning: "before-last-message"
      }),
      // Llama 3.3 defaults to 256 output tokens, which truncates a brief mid-sentence.
      maxOutputTokens: 2048,
      tools: {
        ...mcpTools,

        startResearch: tool({
          description:
            "Start the multi-step research workflow for a question that needs " +
            "external sources. Returns immediately; results arrive separately.",
          inputSchema: z.object({
            question: z
              .string()
              .describe("The research question to investigate")
          }),
          execute: async ({ question }) => {
            // Llama 3.3 re-calls this tool instead of replying, which would
            // spawn a workflow per step. One research run at a time.
            if (await this.hasLiveResearch()) {
              return {
                instanceId: this.state.activeInstanceId,
                alreadyRunning: true,
                note: "Research is already running. Reply in plain text that it is in progress and the user will be asked to approve sources."
              };
            }

            const briefId = crypto.randomUUID();
            const instanceId = await this.runWorkflow(
              "RESEARCH_WORKFLOW",
              { briefId, question },
              { metadata: { question } }
            );

            this.setState({
              ...this.state,
              status: "researching",
              activeInstanceId: instanceId,
              currentStep: "plan",
              percent: 0.05
            });

            return {
              briefId,
              instanceId,
              note: "Research started. Tell the user it is running and that they will be asked to approve sources. Do not attempt to answer the question yourself."
            };
          }
        }),

        scheduleFollowUp: tool({
          description:
            "Schedule a re-run of research on a question at a later time, " +
            "so the user gets a refreshed brief.",
          inputSchema: z.object({
            question: z.string().describe("The question to revisit"),
            delayMinutes: z
              .number()
              .min(1)
              .max(1440)
              .describe("How many minutes from now to re-run the research")
          }),
          execute: async ({ question, delayMinutes }) => {
            const task = await this.schedule(
              delayMinutes * 60,
              "runFollowUp",
              { question },
              { idempotent: true }
            );
            return { scheduledId: task.id, runsInMinutes: delayMinutes };
          }
        }),

        recallBriefs: tool({
          description:
            "Search briefs already produced for this user. Use before answering " +
            "any question that refers to earlier research.",
          inputSchema: z.object({
            query: z
              .string()
              .describe("Keywords to match against past questions and briefs")
          }),
          execute: async ({ query }) => {
            const rows = query.trim()
              ? this.searchBriefs(query)
              : this.listBriefs(5);

            return rows.map((r) => ({
              id: r.id,
              question: r.question,
              status: r.status,
              createdAt: new Date(r.created_at).toISOString(),
              // Truncated so recall cannot blow the 24k-token context window.
              excerpt: r.brief_md.slice(0, 600)
            }));
          }
        })
      },
      stopWhen: stepCountIs(4),
      // Llama 3.3 keeps re-calling a tool instead of answering. One tool call
      // per turn, then it must produce text.
      prepareStep: async ({ stepNumber }) =>
        stepNumber > 0 ? { activeTools: [] } : {},
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
  }

  /** Scheduled callback: re-runs research on a question the user asked about earlier. */
  async runFollowUp(payload: { question: string }, _task: Schedule<unknown>) {
    if (await this.hasLiveResearch()) return;

    const briefId = crypto.randomUUID();
    const instanceId = await this.runWorkflow(
      "RESEARCH_WORKFLOW",
      { briefId, question: payload.question },
      { metadata: { question: payload.question, followUp: true } }
    );

    this.setState({
      ...this.state,
      status: "researching",
      activeInstanceId: instanceId,
      currentStep: "plan",
      percent: 0.05
    });

    this.broadcast(
      JSON.stringify({
        type: "follow-up-started",
        question: payload.question,
        timestamp: new Date().toISOString()
      })
    );
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
