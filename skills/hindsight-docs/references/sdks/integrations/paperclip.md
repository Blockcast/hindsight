
# Paperclip

Persistent memory for [Paperclip AI](https://github.com/paperclipai/paperclip) agents using [Hindsight](https://hindsight.vectorize.io).

Install the `@vectorize-io/hindsight-paperclip` plugin once. Every agent in your Paperclip instance automatically gets long-term memory that persists across runs, companies, and restarts — no code changes required.

[View Changelog →](../../changelog/integrations/paperclip.md)

## Installation

```bash
pnpm paperclipai plugin install @vectorize-io/hindsight-paperclip
```

Then configure in **Settings → Plugins → Hindsight Memory**.

## Prerequisites

Requires Paperclip **2026.720.0 or newer**. Upgrading from an older plugin version? Open the plugin settings and pick the API key secret again: older versions saved the secret's name, and Paperclip now accepts only a reference chosen with the secret picker.

> **💡 Hindsight Cloud (recommended)**
>
[Sign up free](https://ui.hindsight.vectorize.io) — no infrastructure to run. Skip straight to Configuration below.
**Self-hosting alternative** — run Hindsight locally:

```bash
pip install hindsight-all
export HINDSIGHT_API_LLM_API_KEY=your-openai-key
hindsight-api
```

## How It Works

```
agent.run.started
  └─ fetch issue via ctx.issues.get
       └─ recall(issueTitle + description) → cached in plugin state for this run

agent running…
  ├─ hindsight_recall(query) → cached context if query matches run start, otherwise live recall
  └─ hindsight_retain(content) → stores immediately

issue.comment.created
  └─ retain(full comment body via ctx.issues.listComments)
       └─ bank attribution: agent comment author when present; otherwise issue assignee

agent.run.finished
  └─ no-op (subscription kept for future use when payload carries output)
```

A run start with the same company, server, bank, budget and query as one in the last 10 minutes reuses that recall, so the memories cached at run start can lag what was retained by up to 10 minutes.

The bundled plugin manifest declares the `issues.read` and `issue.comments.read` capabilities needed by the new SDK calls, so Paperclip may prompt for these on first install or upgrade.

Memory is keyed to `companyId` + `agentId` — never to the run ID — so it accumulates across every run.

## Configuration

| Field | Default | Description |
|-------|---------|-------------|
| `hindsightApiUrl` | `https://api.hindsight.vectorize.io` | Hindsight server URL (Cloud default; use `http://localhost:8888` for self-hosted) |
| `hindsightApiKeyRef` | — | Paperclip secret holding your Hindsight Cloud API key, chosen with the secret picker. Leave empty for self-hosted |
| `dynamicBankId` | `true` | When `true`, bank ID is derived from `bankGranularity`. Set `false` and provide `bankId` to share one static memory bank across agents |
| `bankId` | — | Static bank ID used when `dynamicBankId` is `false`. All agents sharing this value read/write the same memory bank |
| `bankGranularity` | `["company", "agent"]` | Memory isolation when `dynamicBankId` is `true`: per company+agent, per company, or per agent. Add `"user"` for per-user memory isolation (useful for GDPR compliance) |
| `recallBudget` | `mid` | `low` = fastest, `mid` = balanced, `high` = most thorough |
| `recallTimeoutMs` | `45000` | Timeout for recall (run start and the `hindsight_recall` tool) |
| `retainTimeoutMs` | `30000` | Timeout for retain (auto-retained comments and the `hindsight_retain` tool) |
| `requestTimeoutMs` | — | Legacy single timeout. When set it replaces both defaults above; `recallTimeoutMs` and `retainTimeoutMs` still win over it |
| `autoRetain` | `true` | Automatically retain run output after every run |

If `requestTimeoutMs` is already set, recall keeps that value until `recallTimeoutMs` is set, and retain keeps it until `retainTimeoutMs` is set. Each timeout accepts 1000 to 120000 ms. Saving the plugin settings form fills `recallTimeoutMs` and `retainTimeoutMs` with their defaults, which then override `requestTimeoutMs`. The `hindsight_recall` tool also runs inside the host's plugin RPC timeout (120 s on current Paperclip), so keep `recallTimeoutMs` below it.

## Bank ID Format

```
paperclip::{companyId}::{agentId}                  ← default (company + agent granularity)
paperclip::{companyId}                             ← company granularity (shared across agents)
paperclip::{agentId}                               ← agent granularity (agent memory across companies)
paperclip::{companyId}::{agentId}::user::{userId}  ← user granularity (per-user isolation, GDPR-friendly)
{bankId}                                           ← static shared bank (dynamicBankId = false)
```

## Agent Tools

Agents can call these tools directly during a run:

**`hindsight_recall(query)`** — search memory for relevant context. Called automatically at run start; agents can also call it mid-run for targeted queries. The run-start result is reused only when the agent asks the same query; any other query triggers a live recall.

**`hindsight_retain(content)`** — store a fact or decision immediately, without waiting for run end.

## Adapter Compatibility

Works with all Paperclip adapter types via the event system:

| Adapter | Supported |
|---------|-----------|
| Claude | ✓ |
| Codex | ✓ |
| Cursor | ✓ |
| HTTP | ✓ |
| Process | ✓ |
