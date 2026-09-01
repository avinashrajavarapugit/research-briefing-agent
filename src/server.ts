import { createWorkersAI } from "workers-ai-provider";
import { callable, routeAgentRequest, type Schedule } from "agents";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  streamText,
  tool
} from "ai";
import { z } from "zod";
import { withDedupedTextDeltas } from "./ai-binding";

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
      stopWhen: stepCountIs(20),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
  }

  async executeTask(description: string, _task: Schedule<string>) {
    // Do the actual work here (send email, call API, etc.)
    console.log(`Executing scheduled task: ${description}`);

    // Notify connected clients via a broadcast event.
    // We use broadcast() instead of saveMessages() to avoid injecting
    // into chat history — that would cause the AI to see the notification
    // as new context and potentially loop.
    this.broadcast(
      JSON.stringify({
        type: "scheduled-task",
        description,
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
