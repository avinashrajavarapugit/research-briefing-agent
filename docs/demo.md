# Two-minute demo script

Rehearse against the live URL, not localhost:
**https://research-briefing-agent.rajavarapu-avinash.workers.dev**

Before starting, click **Clear** so the agent begins from a clean state. Clear also resets any
in-flight workflow, so a previous run cannot block this one.

---

## 0:00 — Open the app (input)

Load the live URL. The header shows **Connected**, which means the browser has an open WebSocket
to the `BriefingAgent` Durable Object.

> "This is a research agent running entirely on Cloudflare. The browser is connected to a Durable
> Object over a WebSocket."

## 0:10 — Ask a research question (LLM)

Type exactly:

```
Research how the Raft consensus algorithm elects a leader.
```

Press Enter.

Llama 3.3 on Workers AI receives the message and calls the `startResearch` tool. The tool call
and its arguments appear inline in the transcript, and it returns immediately with a workflow
instance id rather than blocking the chat.

> "The model didn't answer from memory. It decided to start a workflow, and handed back a
> workflow id straight away."

## 0:30 — Watch the workflow run (coordination)

The panel above the composer moves through the pipeline as the workflow reports progress:

| Step | Panel shows |
|---|---|
| `plan-queries` | Researching, ~5% |
| `search-wikipedia` | Researching, ~20% |
| `search-hackernews` | Researching, ~35% |
| approval gate | Waiting for your approval, 50% |

> "Each of those is a separate durable step. The two searches hit real public APIs and retry with
> exponential backoff if they rate-limit — the workflow resumes from the last completed step
> rather than starting over."

## 0:55 — Approve the sources (human-in-the-loop)

Four sources are listed, balanced across both providers — Wikipedia's *Raft (algorithm)* and
*Consensus (computer science)*, plus Hacker News results including `raft.github.io`.

Click **Approve sources**.

> "The workflow is parked here on a durable wait. I could close this tab, come back tomorrow, and
> it would still be waiting — that's the part a single request can't do."

## 1:10 — Brief is synthesized

The panel advances through `summarize` (one model call per source) and then `synthesize-brief`.
The finished brief appears in the chat with an **Answer**, **Key points** with inline `[n]`
citations, and a **Sources** list. The panel reads **Brief ready — 100%**.

## 1:35 — Refresh the page (memory)

Press **Cmd/Ctrl-R**.

The conversation and the completed brief are still there. Nothing was in React state — the
messages and the `briefs` row were read back out of the agent's own SQLite database.

> "That's the memory requirement. The transcript and the brief came back from SQLite colocated
> with the Durable Object."

## 1:50 — Close

> "One message travelled through all four: chat input over WebSocket, Llama 3.3 on Workers AI, a
> durable multi-step Workflow with retries and a human approval gate, and per-instance SQLite
> that survived the refresh."

---

## Optional extras, if there is time

- **Voice input** — click the microphone next to the composer and dictate the question instead of
  typing. Chrome and Safari only; the button hides itself where `SpeechRecognition` is missing.
- **Memory across turns** — after the brief lands, ask `What did you find last time?` The model
  calls `recallBriefs`, which queries the stored briefs rather than re-researching.
- **Scheduled follow-up** — ask `Follow up on that in 2 minutes`. The agent uses `this.schedule`
  to re-run the research later and pushes a notification when it starts.

## If something goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| "Research failed" immediately | The question is too niche for Wikipedia, so every source was filtered as irrelevant | Use one of the suggested prompts; broad technical topics work best |
| Panel stuck at "Waiting for your approval" | Nobody clicked Approve | Click **Approve sources**, or **Clear** to reset |
| A new question does nothing | A previous run is still live | Click **Clear**, which terminates it and resets state |
