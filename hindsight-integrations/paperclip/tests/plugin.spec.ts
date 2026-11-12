/**
 * Tests for paperclip-plugin-hindsight.
 *
 * Uses @paperclipai/plugin-sdk's createTestHarness to simulate the Paperclip
 * host environment without requiring a running Paperclip instance.
 *
 * Hindsight API calls are intercepted via global fetch mocking.
 */

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import plugin, { buildRecallQuery, DEFAULT_MAX_RECALL_QUERY_BYTES } from "../src/worker.js";
import {
  DEFAULT_RECALL_TIMEOUT_MS,
  DEFAULT_RETAIN_TIMEOUT_MS,
  HindsightClient,
  type TimeoutConfig,
} from "../src/client.js";

// ---------------------------------------------------------------------------
// Fetch mock helpers
// ---------------------------------------------------------------------------

function mockFetch(responses: Array<{ url: string | RegExp; body: unknown; status?: number }>) {
  return vi.fn(async (url: string) => {
    const match = responses.find((r) =>
      typeof r.url === "string" ? url.includes(r.url) : r.url.test(url)
    );
    if (!match) {
      return new Response(JSON.stringify({ error: "unmatched url" }), { status: 404 });
    }
    return new Response(JSON.stringify(match.body), {
      status: match.status ?? 200,
    });
  });
}

/** fetch that never settles until its AbortSignal fires. */
function hangingFetch() {
  return vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError"))
        );
      })
  );
}

// ---------------------------------------------------------------------------
// Harness setup
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG = {
  hindsightApiUrl: "http://localhost:8888",
  bankGranularity: ["company", "agent"],
  recallBudget: "mid",
  autoRetain: true,
};

function buildHarness(config: Record<string, unknown> = DEFAULT_CONFIG) {
  return createTestHarness({
    manifest,
    config,
    capabilities: [...manifest.capabilities, "issues.create", "issue.comments.create"],
  });
}

async function setupPlugin(harness: ReturnType<typeof buildHarness>) {
  await plugin.definition.setup(harness.ctx);
}

async function seedIssue(
  harness: ReturnType<typeof buildHarness>,
  opts: { companyId: string; title: string; description?: string; assigneeAgentId?: string }
) {
  return harness.ctx.issues.create({
    companyId: opts.companyId,
    title: opts.title,
    description: opts.description,
    assigneeAgentId: opts.assigneeAgentId,
  });
}

// ---------------------------------------------------------------------------
// Bank ID derivation
// ---------------------------------------------------------------------------

describe("bank ID derivation", () => {
  it("default: company + agent", async () => {
    const { deriveBankId } = await import("../src/bank.js");
    expect(
      deriveBankId(
        { companyId: "co-1", agentId: "ag-1" },
        { bankGranularity: ["company", "agent"] }
      )
    ).toBe("paperclip::co-1::ag-1");
  });

  it("company only", async () => {
    const { deriveBankId } = await import("../src/bank.js");
    expect(
      deriveBankId({ companyId: "co-1", agentId: "ag-1" }, { bankGranularity: ["company"] })
    ).toBe("paperclip::co-1");
  });

  it("agent only", async () => {
    const { deriveBankId } = await import("../src/bank.js");
    expect(
      deriveBankId({ companyId: "co-1", agentId: "ag-1" }, { bankGranularity: ["agent"] })
    ).toBe("paperclip::ag-1");
  });

  it("company + agent + user", async () => {
    const { deriveBankId } = await import("../src/bank.js");
    expect(
      deriveBankId(
        { companyId: "co-1", agentId: "ag-1", userId: "alice@acme.com" },
        { bankGranularity: ["company", "agent", "user"] }
      )
    ).toBe("paperclip::co-1::ag-1::user::alice@acme.com");
  });

  it("user granularity without userId falls back to company+agent", async () => {
    const { deriveBankId } = await import("../src/bank.js");
    expect(
      deriveBankId(
        { companyId: "co-1", agentId: "ag-1" },
        { bankGranularity: ["company", "agent", "user"] }
      )
    ).toBe("paperclip::co-1::ag-1");
  });

  it("static bankId overrides derivation when dynamicBankId is not true", async () => {
    const { deriveBankId } = await import("../src/bank.js");
    expect(
      deriveBankId(
        { companyId: "co-1", agentId: "ag-1" },
        { bankId: "spool-farm", bankGranularity: ["company", "agent"] }
      )
    ).toBe("spool-farm");
  });

  it("static bankId is trimmed", async () => {
    const { deriveBankId } = await import("../src/bank.js");
    expect(
      deriveBankId({ companyId: "co-1", agentId: "ag-1" }, { bankId: "  shared-bank  " })
    ).toBe("shared-bank");
  });

  it("empty/whitespace bankId falls through to dynamic derivation", async () => {
    const { deriveBankId } = await import("../src/bank.js");
    expect(
      deriveBankId(
        { companyId: "co-1", agentId: "ag-1" },
        { bankId: "   ", bankGranularity: ["company", "agent"] }
      )
    ).toBe("paperclip::co-1::ag-1");
  });

  it("dynamicBankId=true ignores static bankId", async () => {
    const { deriveBankId } = await import("../src/bank.js");
    expect(
      deriveBankId(
        { companyId: "co-1", agentId: "ag-1" },
        { bankId: "spool-farm", dynamicBankId: true, bankGranularity: ["company", "agent"] }
      )
    ).toBe("paperclip::co-1::ag-1");
  });
});

// ---------------------------------------------------------------------------
// extractUserFromIssue
// ---------------------------------------------------------------------------

describe("extractUserFromIssue", () => {
  it("extracts email from originId", async () => {
    const { extractUserFromIssue } = await import("../src/bank.js");
    expect(extractUserFromIssue({ originId: "slack::alice@acme.com" })).toBe("alice@acme.com");
  });

  it("prefers creatorEmail over originId", async () => {
    const { extractUserFromIssue } = await import("../src/bank.js");
    expect(
      extractUserFromIssue({
        creatorEmail: "bob@acme.com",
        originId: "slack::alice@acme.com",
      })
    ).toBe("bob@acme.com");
  });

  it("returns undefined when no email found", async () => {
    const { extractUserFromIssue } = await import("../src/bank.js");
    expect(extractUserFromIssue({ originId: "slack::channel-123" })).toBeUndefined();
  });

  it("returns undefined when issue has no originId or creatorEmail", async () => {
    const { extractUserFromIssue } = await import("../src/bank.js");
    expect(extractUserFromIssue({})).toBeUndefined();
  });

  it("handles multi-segment originId", async () => {
    const { extractUserFromIssue } = await import("../src/bank.js");
    expect(extractUserFromIssue({ originId: "zendesk::org-42::ticket-7::user@corp.io" })).toBe(
      "user@corp.io"
    );
  });
});

// ---------------------------------------------------------------------------
// agent.run.started — recall
// ---------------------------------------------------------------------------

describe("agent.run.started", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = mockFetch([
      { url: /recall/, body: { results: [{ text: "User prefers TypeScript" }] } },
    ]);
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches the issue, calls recall, and caches memories in plugin state", async () => {
    const harness = buildHarness();
    await setupPlugin(harness);
    const issue = await seedIssue(harness, {
      companyId: "co-1",
      title: "Refactor auth module",
      description: "Migrate to JWT",
    });

    await harness.emit(
      "agent.run.started",
      { agentId: "ag-1", runId: "run-1", issueId: issue.id },
      { companyId: "co-1" }
    );

    const recallCall = fetchMock.mock.calls.find(([url]: [string]) => url.includes("recall"));
    expect(recallCall).toBeDefined();
    expect(recallCall?.[0]).toContain("paperclip%3A%3Aco-1%3A%3Aag-1");
    expect(recallCall?.[1]?.headers["User-Agent"]).toMatch(/^hindsight-paperclip\/\d+\.\d+\.\d+$/);

    const recallBody = JSON.parse(recallCall?.[1]?.body as string) as { query: string };
    expect(recallBody.query).toContain("Refactor auth module");
    expect(recallBody.query).toContain("Migrate to JWT");

    const state = harness.getState({
      scopeKind: "run",
      scopeId: "run-1",
      stateKey: "recalled-memories",
    });
    expect(state).toContain("TypeScript");
  });

  it("uses user-scoped bank ID when bankGranularity includes 'user'", async () => {
    const harness = buildHarness({
      ...DEFAULT_CONFIG,
      bankGranularity: ["company", "agent", "user"],
    });
    await setupPlugin(harness);
    const issue = await seedIssue(harness, {
      companyId: "co-1",
      title: "Fix user-specific bug",
      description: "Details here",
    });
    // Simulate originId with user email (set via harness internals)
    (issue as Record<string, unknown>).originId = "slack::alice@acme.com";

    await harness.emit(
      "agent.run.started",
      { agentId: "ag-1", runId: "run-user-1", issueId: issue.id },
      { companyId: "co-1" }
    );

    const recallCall = fetchMock.mock.calls.find(([url]: [string]) => url.includes("recall"));
    expect(recallCall).toBeDefined();
    // Bank ID should include user segment
    expect(recallCall?.[0]).toContain(
      encodeURIComponent("paperclip::co-1::ag-1::user::alice@acme.com")
    );

    // Verify userId was cached in state for tool calls
    const cachedUserId = harness.getState({
      scopeKind: "run",
      scopeId: "run-user-1",
      stateKey: "user-id",
    });
    expect(cachedUserId).toBe("alice@acme.com");
  });

  it("routes recall to static bankId when dynamicBankId is not true", async () => {
    const harness = buildHarness({
      ...DEFAULT_CONFIG,
      bankId: "spool-farm",
      dynamicBankId: false,
    });
    await setupPlugin(harness);
    const issue = await seedIssue(harness, {
      companyId: "co-1",
      title: "Shared project context",
    });

    await harness.emit(
      "agent.run.started",
      { agentId: "ag-1", runId: "run-static-1", issueId: issue.id },
      { companyId: "co-1" }
    );

    const recallCall = fetchMock.mock.calls.find(([url]: [string]) => url.includes("recall"));
    expect(recallCall).toBeDefined();
    expect(recallCall?.[0]).toContain(encodeURIComponent("spool-farm"));
    // Should NOT contain the dynamic derivation prefix
    expect(recallCall?.[0]).not.toContain(encodeURIComponent("paperclip::"));
  });

  it("bounds the run-start recall query before calling Hindsight", async () => {
    const harness = buildHarness();
    await setupPlugin(harness);
    const issue = await seedIssue(harness, {
      companyId: "co-1",
      title: "Investigate preview deployment failures",
      description: "Long issue body. ".repeat(500),
    });

    await harness.emit(
      "agent.run.started",
      { agentId: "ag-1", runId: "run-long", issueId: issue.id },
      { companyId: "co-1" }
    );

    const recallCall = fetchMock.mock.calls.find(([url]: [string]) => url.includes("recall"));
    expect(recallCall).toBeDefined();
    const recallBody = JSON.parse(recallCall?.[1]?.body as string) as { query: string };
    expect(Buffer.byteLength(recallBody.query, "utf8")).toBeLessThanOrEqual(
      DEFAULT_MAX_RECALL_QUERY_BYTES
    );
    expect(recallBody.query).toContain("Investigate preview deployment failures");
  });

  it("builds a compact recall query from long issue text", () => {
    const query = buildRecallQuery({
      title: "Fix stuck reviewer runs",
      description: "Detailed reproduction with logs and stack traces. ".repeat(500),
    });

    expect(Buffer.byteLength(query, "utf8")).toBeLessThanOrEqual(DEFAULT_MAX_RECALL_QUERY_BYTES);
    expect(query).toContain("Fix stuck reviewer runs");
  });

  it("bounds multibyte issue text by UTF-8 bytes without splitting characters", () => {
    for (const unit of ["€", "😀", "漢字", "e\u0301"]) {
      const query = buildRecallQuery({ title: "T", description: unit.repeat(2000) });
      expect(Buffer.byteLength(query, "utf8")).toBeLessThanOrEqual(DEFAULT_MAX_RECALL_QUERY_BYTES);
      expect(query).not.toMatch(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
      );
    }
  });

  it("honors recallTimeoutMs on the run-start path and does not cache the timeout", async () => {
    const hanging = hangingFetch();
    vi.stubGlobal("fetch", hanging);
    const harness = buildHarness({
      ...DEFAULT_CONFIG,
      requestTimeoutMs: 60_000,
      recallTimeoutMs: 50,
    });
    await setupPlugin(harness);
    const issue = await seedIssue(harness, { companyId: "co-1", title: "Slow server" });

    await harness.emit(
      "agent.run.started",
      { agentId: "ag-1", runId: "run-slow-1", issueId: issue.id },
      { companyId: "co-1" }
    );
    const warn = harness.logs.find((l) => l.message === "Failed to recall memories on run start");
    expect(String(warn?.meta?.error)).toMatch(/memories\/recall timed out after 50ms/);

    await harness.emit(
      "agent.run.started",
      { agentId: "ag-1", runId: "run-slow-2", issueId: issue.id },
      { companyId: "co-1" }
    );
    expect(hanging).toHaveBeenCalledTimes(2);
  });

  it("skips recall when no issueId is provided", async () => {
    const harness = buildHarness();
    await setupPlugin(harness);

    await harness.emit(
      "agent.run.started",
      { agentId: "ag-1", runId: "run-2" },
      { companyId: "co-1" }
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips recall when the issue has no title or description", async () => {
    const harness = buildHarness();
    await setupPlugin(harness);
    const issue = await seedIssue(harness, { companyId: "co-1", title: "" });

    await harness.emit(
      "agent.run.started",
      { agentId: "ag-1", runId: "run-2b", issueId: issue.id },
      { companyId: "co-1" }
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not throw when Hindsight is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 503 }))
    );
    const harness = buildHarness();
    await setupPlugin(harness);
    const issue = await seedIssue(harness, { companyId: "co-1", title: "Fix bug" });

    await expect(
      harness.emit(
        "agent.run.started",
        { agentId: "ag-1", runId: "run-3", issueId: issue.id },
        { companyId: "co-1" }
      )
    ).resolves.not.toThrow();
  });

  describe("recall dedupe", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    const recallCalls = () =>
      fetchMock.mock.calls.filter(([url]: [string]) => url.includes("recall")).length;

    async function startRun(
      harness: ReturnType<typeof buildHarness>,
      runId: string,
      issueId: string,
      { agentId = "ag-1", companyId = "co-1" } = {}
    ) {
      await harness.emit("agent.run.started", { agentId, runId, issueId }, { companyId });
      return {
        memories: harness.getState({
          scopeKind: "run",
          scopeId: runId,
          stateKey: "recalled-memories",
        }),
        query: harness.getState({ scopeKind: "run", scopeId: runId, stateKey: "recalled-query" }),
      };
    }

    it("reuses a recall for the same bank and query within the TTL", async () => {
      const harness = buildHarness();
      await setupPlugin(harness);
      const issue = await seedIssue(harness, { companyId: "co-1", title: "Dedupe me" });

      const first = await startRun(harness, "run-d1", issue.id);
      const second = await startRun(harness, "run-d2", issue.id);

      expect(recallCalls()).toBe(1);
      expect(second.memories).toBe(first.memories);
      expect(second.memories).toContain("TypeScript");
      expect(second.query).toBe("Dedupe me");
    });

    it("recalls again once the TTL has passed", async () => {
      const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
      const harness = buildHarness();
      await setupPlugin(harness);
      const issue = await seedIssue(harness, { companyId: "co-1", title: "Dedupe me" });

      await startRun(harness, "run-t1", issue.id);
      now.mockReturnValue(1_000_000 + 10 * 60_000 - 1);
      await startRun(harness, "run-t2", issue.id);
      expect(recallCalls()).toBe(1);

      now.mockReturnValue(1_000_000 + 10 * 60_000);
      await startRun(harness, "run-t3", issue.id);
      expect(recallCalls()).toBe(2);
    });

    it("does not cache a failed recall", async () => {
      fetchMock.mockResolvedValueOnce(new Response("", { status: 503 }));
      const harness = buildHarness();
      await setupPlugin(harness);
      const issue = await seedIssue(harness, { companyId: "co-1", title: "Dedupe me" });

      const failed = await startRun(harness, "run-f1", issue.id);
      expect(failed.memories).toBeUndefined();

      const retried = await startRun(harness, "run-f2", issue.id);
      expect(recallCalls()).toBe(2);
      expect(retried.memories).toContain("TypeScript");
    });

    it("recalls once per run when a deferred run starts again", async () => {
      const harness = buildHarness();
      await setupPlugin(harness);
      const issue = await seedIssue(harness, { companyId: "co-1", title: "Dedupe me" });

      const first = await startRun(harness, "run-r1", issue.id);
      const again = await startRun(harness, "run-r1", issue.id);

      expect(recallCalls()).toBe(1);
      expect(again.memories).toBe(first.memories);
    });

    it("does not retry a failed recall when the same run starts again", async () => {
      fetchMock.mockResolvedValueOnce(new Response("", { status: 503 }));
      const harness = buildHarness();
      await setupPlugin(harness);
      const issue = await seedIssue(harness, { companyId: "co-1", title: "Dedupe me" });

      await startRun(harness, "run-rf", issue.id);
      const again = await startRun(harness, "run-rf", issue.id);

      expect(recallCalls()).toBe(1);
      expect(again.memories).toBeUndefined();
    });

    it("recalls again for a run once the per-run window has passed", async () => {
      const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
      fetchMock.mockResolvedValueOnce(new Response("", { status: 503 }));
      const harness = buildHarness();
      await setupPlugin(harness);
      const issue = await seedIssue(harness, { companyId: "co-1", title: "Dedupe me" });

      await startRun(harness, "run-rw", issue.id);
      now.mockReturnValue(1_000_000 + 60 * 60_000);
      const later = await startRun(harness, "run-rw", issue.id);

      expect(recallCalls()).toBe(2);
      expect(later.memories).toContain("TypeScript");
    });

    it("does not cache a malformed 2xx recall response", async () => {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));
      const harness = buildHarness();
      await setupPlugin(harness);
      const issue = await seedIssue(harness, { companyId: "co-1", title: "Dedupe me" });

      const malformed = await startRun(harness, "run-m1", issue.id);
      expect(malformed.memories).toBeUndefined();
      const warn = harness.logs.find((l) => l.message === "Failed to recall memories on run start");
      expect(String(warn?.meta?.error)).toContain("Malformed recall response");

      const retried = await startRun(harness, "run-m2", issue.id);
      expect(recallCalls()).toBe(2);
      expect(retried.memories).toContain("TypeScript");
    });

    it("does not share a recall across agents", async () => {
      const harness = buildHarness();
      await setupPlugin(harness);
      const issue = await seedIssue(harness, { companyId: "co-1", title: "Dedupe me" });

      await startRun(harness, "run-a1", issue.id, { agentId: "ag-1" });
      await startRun(harness, "run-a2", issue.id, { agentId: "ag-2" });

      const banks = fetchMock.mock.calls.map(([url]: [string]) => url);
      expect(recallCalls()).toBe(2);
      expect(banks[1]).toContain("paperclip%3A%3Aco-1%3A%3Aag-2");
    });

    it("does not share a recall across issues with different text", async () => {
      const harness = buildHarness();
      await setupPlugin(harness);
      const first = await seedIssue(harness, { companyId: "co-1", title: "Dedupe me" });
      const second = await seedIssue(harness, { companyId: "co-1", title: "Something else" });

      await startRun(harness, "run-i1", first.id);
      const other = await startRun(harness, "run-i2", second.id);

      expect(recallCalls()).toBe(2);
      expect(other.query).toBe("Something else");
    });

    it("does not share a recall across companies on the same static bank", async () => {
      const harness = buildHarness({ ...DEFAULT_CONFIG, bankId: "shared", dynamicBankId: false });
      await setupPlugin(harness);
      const a = await seedIssue(harness, { companyId: "co-1", title: "Dedupe me" });
      const b = await seedIssue(harness, { companyId: "co-2", title: "Dedupe me" });

      await startRun(harness, "run-c1", a.id, { companyId: "co-1" });
      const second = await startRun(harness, "run-c2", b.id, { companyId: "co-2" });

      expect(recallCalls()).toBe(2);
      expect(second.memories).toContain("TypeScript");
    });

    it("does not share a recall across Hindsight servers or budgets", async () => {
      const harness = buildHarness();
      await setupPlugin(harness);
      const issue = await seedIssue(harness, { companyId: "co-1", title: "Dedupe me" });

      await startRun(harness, "run-s1", issue.id);
      harness.setConfig({ ...DEFAULT_CONFIG, hindsightApiUrl: "http://other:8888" });
      await startRun(harness, "run-s2", issue.id);
      harness.setConfig({ ...DEFAULT_CONFIG, recallBudget: "high" });
      await startRun(harness, "run-s3", issue.id);

      expect(recallCalls()).toBe(3);
      expect(fetchMock.mock.calls[1]?.[0]).toMatch(/^http:\/\/other:8888\//);
      expect(JSON.parse(fetchMock.mock.calls[2]?.[1]?.body as string).budget).toBe("high");
    });

    it("keys on the bounded query, so issues that differ past the cap share a recall", async () => {
      const harness = buildHarness();
      await setupPlugin(harness);
      const body = "Same long body. ".repeat(200);
      const a = await seedIssue(harness, {
        companyId: "co-1",
        title: "Long",
        description: body + "A",
      });
      const b = await seedIssue(harness, {
        companyId: "co-1",
        title: "Long",
        description: body + "B",
      });

      const first = await startRun(harness, "run-q1", a.id);
      const second = await startRun(harness, "run-q2", b.id);

      expect(recallCalls()).toBe(1);
      expect(second.query).toBe(first.query);
    });

    it("coalesces run starts that overlap an in-flight recall", async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      fetchMock.mockImplementationOnce(async () => {
        await gate;
        return new Response(JSON.stringify({ results: [{ text: "Shared answer" }] }));
      });
      const harness = buildHarness();
      await setupPlugin(harness);
      const issue = await seedIssue(harness, { companyId: "co-1", title: "Dedupe me" });

      const both = Promise.all([
        startRun(harness, "run-o1", issue.id),
        startRun(harness, "run-o2", issue.id),
      ]);
      await vi.waitFor(() => expect(recallCalls()).toBe(1));
      release();
      const [first, second] = await both;

      expect(recallCalls()).toBe(1);
      expect(first.memories).toContain("Shared answer");
      expect(second.memories).toContain("Shared answer");
    });

    it("evicts the oldest entry once more than 500 recalls are cached", async () => {
      const harness = buildHarness();
      await setupPlugin(harness);
      const ids: string[] = [];
      for (let i = 0; i <= 500; i++) {
        ids.push((await seedIssue(harness, { companyId: "co-1", title: `Issue ${i}` })).id);
        await startRun(harness, `run-e${i}`, ids[i]!);
      }
      expect(recallCalls()).toBe(501);

      await startRun(harness, "run-e1-again", ids[1]!);
      expect(recallCalls()).toBe(501);
      await startRun(harness, "run-e0-again", ids[0]!);
      expect(recallCalls()).toBe(502);
    });
  });
});

// ---------------------------------------------------------------------------
// issue.comment.created — auto-retain
// ---------------------------------------------------------------------------

describe("issue.comment.created", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = mockFetch([{ url: /memories$/, body: { success: true } }]);
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("retains the full comment body with the commentId as document ID", async () => {
    const harness = buildHarness();
    await setupPlugin(harness);
    const issue = await seedIssue(harness, {
      companyId: "co-1",
      title: "Refactor auth",
      assigneeAgentId: "ag-1",
    });
    const comment = await harness.ctx.issues.createComment(
      issue.id,
      "Refactored auth. Migrated to JWT with 24h expiry.",
      "co-1",
      { authorAgentId: "ag-1" }
    );

    await harness.emit(
      "issue.comment.created",
      { commentId: comment.id, agentId: "ag-1", runId: "run-1" },
      { companyId: "co-1", entityId: issue.id }
    );

    const retainCall = fetchMock.mock.calls.find(([url]: [string]) => /memories$/.test(url));
    expect(retainCall).toBeDefined();
    const body = JSON.parse(retainCall?.[1]?.body as string) as {
      items: Array<{ content: string; document_id?: string }>;
    };
    expect(body.items[0]?.content).toContain("JWT");
    expect(body.items[0]?.document_id).toBe(comment.id);
  });

  it("skips retain when comment has no agent author and issue has no assignee", async () => {
    const harness = buildHarness();
    await setupPlugin(harness);
    const issue = await seedIssue(harness, { companyId: "co-1", title: "x" });
    const comment = await harness.ctx.issues.createComment(issue.id, "User message", "co-1");

    await harness.emit(
      "issue.comment.created",
      { commentId: comment.id, agentId: null },
      { companyId: "co-1", entityId: issue.id }
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips retain when autoRetain is false", async () => {
    const harness = buildHarness({ ...DEFAULT_CONFIG, autoRetain: false });
    await setupPlugin(harness);
    const issue = await seedIssue(harness, {
      companyId: "co-1",
      title: "x",
      assigneeAgentId: "ag-1",
    });
    const comment = await harness.ctx.issues.createComment(issue.id, "Some output", "co-1", {
      authorAgentId: "ag-1",
    });

    await harness.emit(
      "issue.comment.created",
      { commentId: comment.id, agentId: "ag-1" },
      { companyId: "co-1", entityId: issue.id }
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips retain when commentId is missing", async () => {
    const harness = buildHarness();
    await setupPlugin(harness);
    const issue = await seedIssue(harness, { companyId: "co-1", title: "x" });

    await harness.emit("issue.comment.created", {}, { companyId: "co-1", entityId: issue.id });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to the issue assignee for bank attribution when comment has no agent author", async () => {
    const harness = buildHarness();
    await setupPlugin(harness);
    const issue = await seedIssue(harness, {
      companyId: "co-1",
      title: "x",
      assigneeAgentId: "ag-assignee",
    });
    const comment = await harness.ctx.issues.createComment(
      issue.id,
      "User says: please do X",
      "co-1"
    );

    await harness.emit(
      "issue.comment.created",
      { commentId: comment.id, agentId: null },
      { companyId: "co-1", entityId: issue.id }
    );

    const retainCall = fetchMock.mock.calls.find(([url]: [string]) => /memories$/.test(url));
    expect(retainCall).toBeDefined();
    expect(retainCall?.[0]).toContain("paperclip%3A%3Aco-1%3A%3Aag-assignee");
  });
});

// ---------------------------------------------------------------------------
// hindsight_recall tool
// ---------------------------------------------------------------------------

describe("hindsight_recall tool", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns cached memories from run start without additional API call for the same query", async () => {
    const harness = buildHarness();
    await setupPlugin(harness);
    const issue = await seedIssue(harness, {
      companyId: "co-1",
      title: "Update UI",
    });

    vi.stubGlobal(
      "fetch",
      mockFetch([{ url: /recall/, body: { results: [{ text: "User prefers dark mode" }] } }])
    );
    await harness.emit(
      "agent.run.started",
      { agentId: "ag-1", runId: "run-1", issueId: issue.id },
      { companyId: "co-1" }
    );

    const callsBefore = (vi.mocked(fetch) as ReturnType<typeof vi.fn>).mock.calls.length;
    const result = await harness.executeTool(
      "hindsight_recall",
      { query: "Update UI" },
      { agentId: "ag-1", runId: "run-1", companyId: "co-1", projectId: "proj-1" }
    );

    expect((result as { content: string }).content).toContain("dark mode");
    const callsAfter = (vi.mocked(fetch) as ReturnType<typeof vi.fn>).mock.calls.length;
    // No new recall call — returned from cache
    expect(callsAfter).toBe(callsBefore);
  });

  it("performs a live recall when the query differs from the run-start query", async () => {
    const harness = buildHarness();
    await setupPlugin(harness);
    const issue = await seedIssue(harness, {
      companyId: "co-1",
      title: "Update UI",
    });

    vi.stubGlobal(
      "fetch",
      mockFetch([{ url: /recall/, body: { results: [{ text: "User prefers dark mode" }] } }])
    );
    await harness.emit(
      "agent.run.started",
      { agentId: "ag-1", runId: "run-1", issueId: issue.id },
      { companyId: "co-1" }
    );

    const liveFetch = mockFetch([
      { url: /recall/, body: { results: [{ text: "Hosting decision is still open" }] } },
    ]);
    vi.stubGlobal("fetch", liveFetch);

    const result = await harness.executeTool(
      "hindsight_recall",
      { query: "hosting decision" },
      { agentId: "ag-1", runId: "run-1", companyId: "co-1", projectId: "proj-1" }
    );

    expect((result as { content: string }).content).toContain("Hosting decision");
    expect((result as { content: string }).content).not.toContain("dark mode");
    const recallCall = liveFetch.mock.calls.find(([url]: [string]) => url.includes("recall"));
    const body = JSON.parse(recallCall?.[1]?.body as string) as { query: string };
    expect(body.query).toBe("hosting decision");
  });

  it("falls back to live recall when no cached state", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch([{ url: /recall/, body: { results: [{ text: "Agent is a Python specialist" }] } }])
    );
    const harness = buildHarness();
    await setupPlugin(harness);

    const result = await harness.executeTool(
      "hindsight_recall",
      { query: "specialization" },
      { agentId: "ag-1", runId: "run-2", companyId: "co-1", projectId: "proj-1" }
    );

    expect((result as { content: string }).content).toContain("Python specialist");
  });

  it("aborts the request after requestTimeoutMs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError"))
            );
          })
      )
    );
    const harness = buildHarness({ ...DEFAULT_CONFIG, requestTimeoutMs: 50 });
    await setupPlugin(harness);

    const result = await harness.executeTool(
      "hindsight_recall",
      { query: "anything" },
      { agentId: "ag-1", runId: "run-3", companyId: "co-1", projectId: "proj-1" }
    );

    expect((result as { content: string }).content).toContain("Memory recall failed");
    expect((result as { content: string }).content).toMatch(
      /POST \/v1\/default\/banks\/[^ ]+\/memories\/recall timed out after 50ms/
    );
  });
});

describe("HindsightClient timeout", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function timeoutUsed(op: "recall" | "retain", t?: TimeoutConfig): Promise<unknown> {
    vi.stubGlobal("fetch", mockFetch([{ url: /./, body: { results: [] } }]));
    const spy = vi.spyOn(globalThis, "setTimeout");
    spy.mockClear();
    const client = new HindsightClient("http://localhost:8888", undefined, t);
    await (op === "recall" ? client.recall("b", "q") : client.retain("b", "c"));
    return spy.mock.calls[0]?.[1];
  }

  it("defaults to 45s for recall and 30s for retain", async () => {
    expect(DEFAULT_RECALL_TIMEOUT_MS).toBe(45_000);
    expect(DEFAULT_RETAIN_TIMEOUT_MS).toBe(30_000);
    expect(await timeoutUsed("recall")).toBe(45_000);
    expect(await timeoutUsed("retain")).toBe(30_000);
  });

  it("per-op keys beat requestTimeoutMs, which beats the defaults", async () => {
    expect(await timeoutUsed("recall", { requestTimeoutMs: 20_000 })).toBe(20_000);
    expect(await timeoutUsed("retain", { requestTimeoutMs: 20_000 })).toBe(20_000);
    expect(await timeoutUsed("recall", { requestTimeoutMs: 20_000, recallTimeoutMs: 60_000 })).toBe(
      60_000
    );
    expect(await timeoutUsed("retain", { retainTimeoutMs: 5_000 })).toBe(5_000);
  });

  it("ignores invalid timeouts", async () => {
    expect(await timeoutUsed("recall", { recallTimeoutMs: 0 })).toBe(45_000);
    expect(await timeoutUsed("retain", { retainTimeoutMs: Number.NaN })).toBe(30_000);
    // Above 2^31-1 ms, setTimeout would fire at once.
    expect(await timeoutUsed("recall", { recallTimeoutMs: 2 ** 31 })).toBe(45_000);
    expect(await timeoutUsed("retain", { requestTimeoutMs: 2 ** 31 })).toBe(30_000);
  });

  it("keeps the AbortError as the cause of a timeout", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    const client = new HindsightClient("http://localhost:8888", undefined, { recallTimeoutMs: 20 });
    const err = (await client.recall("b", "q").catch((e: unknown) => e)) as Error;
    expect(err.message).toBe("POST /v1/default/banks/b/memories/recall timed out after 20ms");
    expect((err.cause as DOMException).name).toBe("AbortError");
  });

  it("clears its timer on success, HTTP errors and timeouts", async () => {
    const setSpy = vi.spyOn(globalThis, "setTimeout");
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    const client = new HindsightClient("http://localhost:8888", undefined, { recallTimeoutMs: 20 });
    const fetches = [
      mockFetch([{ url: /./, body: { results: [] } }]),
      mockFetch([{ url: /./, body: "down", status: 503 }]),
      hangingFetch(),
    ];
    for (const f of fetches) {
      vi.stubGlobal("fetch", f);
      setSpy.mockClear();
      clearSpy.mockClear();
      await client.recall("b", "q").catch(() => undefined);
      const idx = setSpy.mock.calls.findIndex((c) => c[1] === 20);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(clearSpy).toHaveBeenCalledWith(setSpy.mock.results[idx]?.value);
    }
  });

  it("rejects a 2xx recall response without a results array", async () => {
    vi.stubGlobal("fetch", mockFetch([{ url: /./, body: { memories: [] } }]));
    await expect(new HindsightClient("http://localhost:8888").recall("b", "q")).rejects.toThrow(
      "Malformed recall response from /v1/default/banks/b/memories/recall: no results array"
    );
  });

  it("rejects a 2xx recall response whose results lack text", async () => {
    vi.stubGlobal("fetch", mockFetch([{ url: /./, body: { results: [null] } }]));
    await expect(new HindsightClient("http://localhost:8888").recall("b", "q")).rejects.toThrow(
      "Malformed recall response from /v1/default/banks/b/memories/recall: result without text"
    );
  });

  it("manifest caps every timeout at 1000..120000 ms", () => {
    const props = (
      manifest.instanceConfigSchema as {
        properties: Record<string, { minimum?: number; maximum?: number }>;
      }
    ).properties;
    for (const key of ["requestTimeoutMs", "recallTimeoutMs", "retainTimeoutMs"]) {
      expect([props[key]?.minimum, props[key]?.maximum]).toEqual([1000, 120000]);
    }
  });

  it("worker config: recallTimeoutMs and retainTimeoutMs each bound their own call", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    const harness = buildHarness({
      ...DEFAULT_CONFIG,
      requestTimeoutMs: 60_000,
      recallTimeoutMs: 50,
      retainTimeoutMs: 70,
    });
    await setupPlugin(harness);
    const runCtx = { agentId: "ag-1", runId: "run-to", companyId: "co-1", projectId: "proj-1" };

    const recall = await harness.executeTool("hindsight_recall", { query: "q" }, runCtx);
    expect((recall as { content: string }).content).toMatch(
      /POST \/v1\/default\/banks\/[^ ]+\/memories\/recall timed out after 50ms/
    );

    const retain = await harness.executeTool("hindsight_retain", { content: "c" }, runCtx);
    expect((retain as { content: string }).content).toMatch(
      /Failed to save memory: .*POST \/v1\/default\/banks\/[^ ]+\/memories timed out after 70ms/
    );
  });

  it("rethrows non-timeout errors unchanged", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("down", { status: 503 }))
    );
    await expect(new HindsightClient("http://localhost:8888").recall("b", "q")).rejects.toThrow(
      "HTTP 503 from /v1/default/banks/b/memories/recall: down"
    );
  });
});

// ---------------------------------------------------------------------------
// hindsight_retain tool
// ---------------------------------------------------------------------------

describe("hindsight_retain tool", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stores content via Hindsight retain endpoint", async () => {
    const fetchMock = mockFetch([{ url: /memories$/, body: { success: true } }]);
    vi.stubGlobal("fetch", fetchMock);
    const harness = buildHarness();
    await setupPlugin(harness);

    const result = await harness.executeTool(
      "hindsight_retain",
      { content: "Decision: use Postgres not MySQL" },
      { agentId: "ag-1", runId: "run-1", companyId: "co-1", projectId: "proj-1" }
    );

    expect((result as { content: string }).content).toBe("Memory saved.");
    const call = fetchMock.mock.calls.find(([url]: [string]) => /memories$/.test(url));
    const body = JSON.parse(call?.[1]?.body as string) as {
      items: Array<{ content: string }>;
    };
    expect(body.items[0]?.content).toContain("Postgres");
  });
});

// ---------------------------------------------------------------------------
// onValidateConfig
// ---------------------------------------------------------------------------

describe("onValidateConfig", () => {
  it("fails when hindsightApiUrl is missing", async () => {
    const result = await plugin.definition.onValidateConfig!({ hindsightApiUrl: "" });
    expect(result.ok).toBe(false);
    expect(result.errors?.some((e) => e.includes("hindsightApiUrl"))).toBe(true);
  });

  it("fails when Hindsight is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 503 }))
    );
    const result = await plugin.definition.onValidateConfig!({
      hindsightApiUrl: "http://localhost:8888",
    });
    expect(result.ok).toBe(false);
    vi.unstubAllGlobals();
  });

  it("passes with a reachable Hindsight instance", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200 }))
    );
    const result = await plugin.definition.onValidateConfig!({
      hindsightApiUrl: "http://localhost:8888",
    });
    expect(result.ok).toBe(true);
    vi.unstubAllGlobals();
  });
});

// ---------------------------------------------------------------------------
// enabledAgentIds gate
// ---------------------------------------------------------------------------

describe("enabledAgentIds", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = mockFetch([
      { url: /memories\/recall/, body: { results: [] } },
      { url: /memories$/, body: { success: true } },
    ]);
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("skips recall when agent is not in enabledAgentIds allowlist", async () => {
    const harness = buildHarness({
      ...DEFAULT_CONFIG,
      enabledAgentIds: ["ag-1"],
    });
    await setupPlugin(harness);
    const issue = await seedIssue(harness, { companyId: "co-1", title: "Test" });

    await harness.emit(
      "agent.run.started",
      { agentId: "ag-2", runId: "run-enabled-1", issueId: issue.id },
      { companyId: "co-1" }
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("performs recall when agent is in enabledAgentIds allowlist", async () => {
    const harness = buildHarness({
      ...DEFAULT_CONFIG,
      enabledAgentIds: ["ag-1"],
    });
    await setupPlugin(harness);
    const issue = await seedIssue(harness, { companyId: "co-1", title: "Test" });

    await harness.emit(
      "agent.run.started",
      { agentId: "ag-1", runId: "run-enabled-2", issueId: issue.id },
      { companyId: "co-1" }
    );

    expect(fetchMock).toHaveBeenCalled();
    const recallCall = fetchMock.mock.calls.find((c: unknown[]) =>
      String(c[0]).includes("/memories/recall")
    );
    expect(recallCall).toBeDefined();
  });

  it("treats empty enabledAgentIds array as all agents allowed", async () => {
    const harness = buildHarness({
      ...DEFAULT_CONFIG,
      enabledAgentIds: [],
    });
    await setupPlugin(harness);
    const issue = await seedIssue(harness, { companyId: "co-1", title: "Test" });

    await harness.emit(
      "agent.run.started",
      { agentId: "ag-any", runId: "run-enabled-3", issueId: issue.id },
      { companyId: "co-1" }
    );

    expect(fetchMock).toHaveBeenCalled();
  });

  it("treats unset enabledAgentIds as all agents allowed (unchanged behavior)", async () => {
    const harness = buildHarness(DEFAULT_CONFIG);
    await setupPlugin(harness);
    const issue = await seedIssue(harness, { companyId: "co-1", title: "Test" });

    await harness.emit(
      "agent.run.started",
      { agentId: "ag-any", runId: "run-enabled-4", issueId: issue.id },
      { companyId: "co-1" }
    );

    expect(fetchMock).toHaveBeenCalled();
  });

  it("skips retain when agent is not in enabledAgentIds allowlist", async () => {
    const harness = buildHarness({
      ...DEFAULT_CONFIG,
      enabledAgentIds: ["ag-1"],
    });
    await setupPlugin(harness);
    const issue = await seedIssue(harness, {
      companyId: "co-1",
      title: "Test",
      assigneeAgentId: "ag-2",
    });

    const comment = await harness.ctx.issues.createComment(issue.id, "comment body", "co-1", {
      authorAgentId: "ag-2",
    });
    await harness.emit(
      "issue.comment.created",
      { agentId: "ag-2", commentId: comment.id },
      { companyId: "co-1", entityId: issue.id }
    );

    const retainCalls = fetchMock.mock.calls.filter(([url]: [string]) => /memories$/.test(url));
    expect(retainCalls.length).toBe(0);
  });

  it("recall tool refuses when agent is not in enabledAgentIds allowlist", async () => {
    const harness = buildHarness({
      ...DEFAULT_CONFIG,
      enabledAgentIds: ["ag-1"],
    });
    await setupPlugin(harness);

    const result = await harness.executeTool(
      "hindsight_recall",
      { query: "anything" },
      {
        agentId: "ag-2",
        runId: "run-tool-1",
        companyId: "co-1",
      }
    );

    expect(String(result.content)).toContain("not enabled for this agent");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retain tool refuses when agent is not in enabledAgentIds allowlist", async () => {
    const harness = buildHarness({
      ...DEFAULT_CONFIG,
      enabledAgentIds: ["ag-1"],
    });
    await setupPlugin(harness);

    const result = await harness.executeTool(
      "hindsight_retain",
      { content: "a secret" },
      {
        agentId: "ag-2",
        runId: "run-tool-2",
        companyId: "co-1",
      }
    );

    expect(String(result.content)).toContain("not enabled for this agent");
    const retainCalls = fetchMock.mock.calls.filter(([url]: [string]) => /memories$/.test(url));
    expect(retainCalls.length).toBe(0);
  });

  it("recall tool works when agent is in enabledAgentIds allowlist", async () => {
    const harness = buildHarness({
      ...DEFAULT_CONFIG,
      enabledAgentIds: ["ag-1"],
    });
    await setupPlugin(harness);

    await harness.executeTool(
      "hindsight_recall",
      { query: "anything" },
      {
        agentId: "ag-1",
        runId: "run-tool-3",
        companyId: "co-1",
      }
    );

    const recallCall = fetchMock.mock.calls.find((c: unknown[]) =>
      String(c[0]).includes("/memories/recall")
    );
    expect(recallCall).toBeDefined();
  });

  it("retain tool works when agent is in enabledAgentIds allowlist", async () => {
    const harness = buildHarness({
      ...DEFAULT_CONFIG,
      enabledAgentIds: ["ag-1"],
    });
    await setupPlugin(harness);

    await harness.executeTool(
      "hindsight_retain",
      { content: "a decision" },
      {
        agentId: "ag-1",
        runId: "run-tool-4",
        companyId: "co-1",
      }
    );

    const retainCalls = fetchMock.mock.calls.filter(([url]: [string]) => /memories$/.test(url));
    expect(retainCalls.length).toBe(1);
  });

  it("tools stay available to every agent when enabledAgentIds is unset", async () => {
    const harness = buildHarness(DEFAULT_CONFIG);
    await setupPlugin(harness);

    const result = await harness.executeTool(
      "hindsight_recall",
      { query: "anything" },
      {
        agentId: "ag-whoever",
        runId: "run-tool-5",
        companyId: "co-1",
      }
    );

    expect(String(result.content)).not.toContain("not enabled for this agent");
    expect(fetchMock).toHaveBeenCalled();
  });

  it("performs retain when agent is in enabledAgentIds allowlist", async () => {
    const harness = buildHarness({
      ...DEFAULT_CONFIG,
      enabledAgentIds: ["ag-1"],
    });
    await setupPlugin(harness);
    const issue = await seedIssue(harness, { companyId: "co-1", title: "Test" });

    const comment = await harness.ctx.issues.createComment(issue.id, "comment body", "co-1", {
      authorAgentId: "ag-1",
    });
    await harness.emit(
      "issue.comment.created",
      { agentId: "ag-1", commentId: comment.id },
      { companyId: "co-1", entityId: issue.id }
    );

    const retainCalls = fetchMock.mock.calls.filter(([url]: [string]) => /memories$/.test(url));
    expect(retainCalls.length).toBeGreaterThan(0);
  });

  it("skips retain for issue assignee when assignee not in enabledAgentIds allowlist", async () => {
    const harness = buildHarness({
      ...DEFAULT_CONFIG,
      enabledAgentIds: ["ag-1"],
    });
    await setupPlugin(harness);
    const issue = await seedIssue(harness, {
      companyId: "co-1",
      title: "Test",
      assigneeAgentId: "ag-2",
    });

    const comment = await harness.ctx.issues.createComment(issue.id, "user comment", "co-1");
    await harness.emit(
      "issue.comment.created",
      { commentId: comment.id },
      { companyId: "co-1", entityId: issue.id }
    );

    const retainCalls = fetchMock.mock.calls.filter(([url]: [string]) => /memories$/.test(url));
    expect(retainCalls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Hindsight Cloud API key — secret reference
// ---------------------------------------------------------------------------

describe("manifest version", () => {
  it("matches package.json, so the host shows the version that is installed", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(manifest.version).toBe(pkg.version);
  });
});

describe("hindsightApiKeyRef", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("is declared as a secret-ref field that admits the picker's reference object", () => {
    const field = (
      manifest.instanceConfigSchema as {
        properties: Record<string, { format?: string; oneOf?: Array<Record<string, unknown>> }>;
      }
    ).properties.hindsightApiKeyRef;

    // Without `format` the host renders a plain text box, stores whatever is
    // typed, and every resolve() fails closed on a bare string.
    expect(field?.format).toBe("secret-ref");

    // With `format` alone but `type: "string"`, the host's Ajv pass rejects what
    // its own picker submits: "Configuration does not match the plugin's
    // instanceConfigSchema". The schema must admit the reference object too.
    const objectBranch = field?.oneOf?.find((branch) => branch.type === "object") as
      | { required?: string[]; properties?: Record<string, unknown> }
      | undefined;
    expect(objectBranch).toBeDefined();
    expect(objectBranch?.required).toEqual(["type", "secretId"]);
    expect(field?.oneOf?.some((branch) => branch.type === "string")).toBe(true);
  });

  it("resolves the stored reference for the run's company and authenticates recall", async () => {
    const fetchMock = mockFetch([{ url: /recall/, body: { results: [] } }]);
    vi.stubGlobal("fetch", fetchMock);

    const secretRef = { type: "secret_ref" as const, secretId: "sec-1" };
    const harness = buildHarness({ ...DEFAULT_CONFIG, hindsightApiKeyRef: secretRef });
    const resolve = vi.spyOn(harness.ctx.secrets, "resolve").mockResolvedValue("hs-cloud-key");
    await setupPlugin(harness);
    const issue = await seedIssue(harness, { companyId: "co-1", title: "Ship it" });

    await harness.emit(
      "agent.run.started",
      { agentId: "ag-1", runId: "run-1", issueId: issue.id },
      { companyId: "co-1" }
    );

    expect(resolve).toHaveBeenCalledWith(secretRef, {
      companyId: "co-1",
      configPath: "hindsightApiKeyRef",
    });

    const recallCall = fetchMock.mock.calls.find(([url]: [string]) => url.includes("recall"));
    const headers = recallCall?.[1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer hs-cloud-key");
  });

  it("never touches the secrets client when no reference is configured", async () => {
    const fetchMock = mockFetch([{ url: /recall/, body: { results: [] } }]);
    vi.stubGlobal("fetch", fetchMock);

    const harness = buildHarness();
    const resolve = vi.spyOn(harness.ctx.secrets, "resolve");
    await setupPlugin(harness);
    const issue = await seedIssue(harness, { companyId: "co-1", title: "Self-hosted" });

    await harness.emit(
      "agent.run.started",
      { agentId: "ag-1", runId: "run-1", issueId: issue.id },
      { companyId: "co-1" }
    );

    expect(resolve).not.toHaveBeenCalled();
  });

  it("does not resolve the secret again for a deduped run-start recall", async () => {
    const fetchMock = mockFetch([{ url: /recall/, body: { results: [] } }]);
    vi.stubGlobal("fetch", fetchMock);

    const secretRef = { type: "secret_ref" as const, secretId: "sec-1" };
    const harness = buildHarness({ ...DEFAULT_CONFIG, hindsightApiKeyRef: secretRef });
    const resolve = vi.spyOn(harness.ctx.secrets, "resolve").mockResolvedValue("hs-cloud-key");
    await setupPlugin(harness);
    const issue = await seedIssue(harness, { companyId: "co-1", title: "Ship it" });

    for (const runId of ["run-k1", "run-k2"]) {
      await harness.emit(
        "agent.run.started",
        { agentId: "ag-1", runId, issueId: issue.id },
        { companyId: "co-1" }
      );
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledTimes(1);
  });
});
