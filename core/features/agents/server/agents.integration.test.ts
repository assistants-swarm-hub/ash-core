import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startTestStoreDb, type TestStoreDb } from "@/test/store-db";

import { enqueueAgentRun, getAgentRunView, getAgentRuns } from "./service";
import {
  appendAgentRunStep,
  claimAgentRun,
  failStaleRunningRuns,
  getAgentRun,
  getAgentRunScreenshot,
  insertAgentRunScreenshot,
  listQueuedAgentRuns,
  settleAgentRun,
} from "./repository";

/**
 * The queue lifecycle against a real Postgres: enqueue → claim-once → settle,
 * plus the crash-safety sweep and screenshot storage. The claim atomicity is the
 * load-bearing invariant — it is what stops two overlapping processes (a
 * redeploy) from double-running a run — so it gets a direct concurrent test.
 */

let ctx: TestStoreDb;

beforeAll(async () => {
  ctx = await startTestStoreDb();
});

afterAll(async () => {
  await ctx?.stop();
});

beforeEach(async () => {
  await ctx.truncate();
});

describe("agents queue", () => {
  it("enqueues a queued run visible to the queue and the dashboard list", async () => {
    const run = await enqueueAgentRun(
      { goal: "find the pricing page", chatRef: "acme:chat:123", isOwner: true },
      ctx.db,
    );
    expect(run.status).toBe("queued");
    expect(run.isOwner).toBe(true);
    // A run enqueued with no turn binding is a browser-only run.
    expect(run).toMatchObject({
      assistantId: null,
      senderIsOwner: false,
      authorityIsOwner: false,
      correlationId: null,
      context: null,
      quiet: false,
    });

    const queued = await listQueuedAgentRuns(ctx.db);
    expect(queued.map((r) => r.id)).toContain(run.id);

    const all = await getAgentRuns(undefined, ctx.db);
    expect(all).toHaveLength(1);
  });

  it("keeps the whole turn binding a chat turn stamped on it", async () => {
    const run = await enqueueAgentRun(
      {
        goal: "fill the gaps",
        context: "  rows 1-5  ",
        quiet: true,
        chatRef: "acme:chat:123",
        threadId: "topic-1",
        createdByUserRef: "acme:user:7",
        assistantId: "asst-1",
        isOwner: true,
        senderIsOwner: false,
        authorityIsOwner: true,
        correlationId: "corr-1",
        restricted: true,
        sourceUrls: ["https://example.com/a"],
      },
      ctx.db,
    );
    const stored = await getAgentRun(ctx.db, run.id);
    expect(stored).toMatchObject({
      assistantId: "asst-1",
      senderIsOwner: false,
      authorityIsOwner: true,
      correlationId: "corr-1",
      // Context is trimmed on the way in; an empty one is stored as none.
      context: "rows 1-5",
      quiet: true,
      threadId: "topic-1",
      restricted: true,
    });
    const blank = await enqueueAgentRun(
      { goal: "browse", context: "   ", chatRef: "acme:chat:1", isOwner: false },
      ctx.db,
    );
    expect(blank.context).toBeNull();
  });

  it("claims a run exactly once — a second claim returns null", async () => {
    const run = await enqueueAgentRun({ goal: "browse", chatRef: "acme:chat:1", isOwner: false }, ctx.db);

    const [first, second] = await Promise.all([
      claimAgentRun(ctx.db, run.id),
      claimAgentRun(ctx.db, run.id),
    ]);

    const claims = [first, second].filter(Boolean);
    expect(claims).toHaveLength(1);
    expect(claims[0]!.status).toBe("running");
    expect(claims[0]!.startedAt).not.toBeNull();
    // Once running it is no longer in the queue.
    expect(await listQueuedAgentRuns(ctx.db)).toHaveLength(0);
  });

  it("records an activity feed as steps are appended, and settles as done", async () => {
    const run = await enqueueAgentRun({ goal: "g", chatRef: "acme:chat:1", isOwner: true }, ctx.db);
    await claimAgentRun(ctx.db, run.id);

    // Steps accumulate as the agent acts — this is what drives the live feed and
    // the run's `steps` count (settle no longer sets it).
    await appendAgentRunStep(ctx.db, run.id, {
      tool: "browser_navigate",
      action: "navigate https://x/",
      url: "https://x/",
      ok: true,
      summary: "Example — 3 elements",
      at: new Date().toISOString(),
    });
    await appendAgentRunStep(ctx.db, run.id, {
      tool: "browser_download_stream",
      action: "download stream https://x/v.m3u8",
      url: "https://x/",
      ok: true,
      summary: 'Saved "v.mp4" (120 MB)',
      at: new Date().toISOString(),
    });

    await settleAgentRun(ctx.db, run.id, {
      status: "done",
      report: "Found it.",
      downloads: [
        { sourceUrl: "https://x/a", filename: "v.mp4", sizeBytes: 2048, deliveredToChat: false },
      ],
    });

    const settled = await getAgentRun(ctx.db, run.id);
    expect(settled).toMatchObject({ status: "done", report: "Found it.", steps: 2 });
    expect(settled!.downloads).toHaveLength(1);
    expect(settled!.finishedAt).not.toBeNull();

    const detail = await getAgentRunView(run.id, ctx.db);
    expect(detail!.activity.map((s) => s.tool)).toEqual([
      "browser_navigate",
      "browser_download_stream",
    ]);
    // seq is derived from stored order (1-based) on read.
    expect(detail!.activity.map((s) => s.seq)).toEqual([1, 2]);
    // A settled run exposes no live state.
    expect(detail!.live).toBeNull();
  });

  it("fails runs left running by a previous process", async () => {
    const run = await enqueueAgentRun({ goal: "g", chatRef: "acme:chat:1", isOwner: false }, ctx.db);
    await claimAgentRun(ctx.db, run.id);

    const reset = await failStaleRunningRuns(ctx.db);
    expect(reset).toBe(1);

    const swept = await getAgentRun(ctx.db, run.id);
    expect(swept!.status).toBe("failed");
    expect(swept!.error).toMatch(/restart/i);
  });

  it("stores and serves run screenshots by sequence, exposed on the detail view", async () => {
    const run = await enqueueAgentRun({ goal: "g", chatRef: "acme:chat:1", isOwner: true }, ctx.db);
    const bytes = Buffer.from([1, 2, 3, 4]);
    await insertAgentRunScreenshot(ctx.db, {
      runId: run.id,
      seq: 0,
      url: "https://x/",
      title: "X",
      data: bytes,
    });

    const stored = await getAgentRunScreenshot(ctx.db, run.id, 0);
    expect(stored).not.toBeNull();
    expect(Buffer.compare(stored!, bytes)).toBe(0);

    const detail = await getAgentRunView(run.id, ctx.db);
    expect(detail!.screenshotSeqs).toEqual([0]);
  });
});
