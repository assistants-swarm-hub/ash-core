import "server-only";

import { and, asc, desc, eq, sql } from "drizzle-orm";

import type { StoreDb } from "@/server/store/db";
import {
  agentRuns,
  agentRunScreenshots,
  type AgentRunRow,
} from "../../../store/schema";

import type {
  AgentRun,
  AgentRunDetail,
  BrowserDownloadRecord,
  AgentRunStatus,
  AgentRunStep,
} from "../types";
import { getLiveState } from "./live-state";

/**
 * Typed persistence for agent runs and their screenshots. Pure data
 * access — no policy, no browser, no trace recording (the service/runner own
 * those). Every function takes a {@link StoreDb} so it runs against the pool or
 * a test instance.
 */

/** Columns an enqueue sets. */
export interface InsertAgentRun {
  chatRef: string | null;
  threadId: string | null;
  createdByUserRef: string | null;
  assistantId: string | null;
  isOwner: boolean;
  senderIsOwner: boolean;
  authorityIsOwner: boolean;
  correlationId: string | null;
  restricted: boolean;
  sourceUrls: string[];
  goal: string;
  context: string | null;
  quiet: boolean;
}

function mapRow(row: AgentRunRow): AgentRun {
  return {
    id: row.id,
    chatRef: row.chatRef,
    threadId: row.threadId,
    createdByUserRef: row.createdByUserRef,
    assistantId: row.assistantId,
    isOwner: row.isOwner,
    senderIsOwner: row.senderIsOwner,
    authorityIsOwner: row.authorityIsOwner,
    correlationId: row.correlationId,
    restricted: row.restricted,
    sourceUrls: row.sourceUrls ?? [],
    goal: row.goal,
    context: row.context,
    quiet: row.quiet,
    status: row.status as AgentRunStatus,
    report: row.report,
    error: row.error,
    steps: row.steps,
    // The stored shape is looser than the client type: pre-2026-07-29 rows carry
    // `inline` and no `deliveredToChat`, which normalizes to false — accurate, since
    // every download of that era was kept on disk.
    downloads: (row.downloads ?? []).map((d) => ({
      sourceUrl: d.sourceUrl,
      filename: d.filename,
      sizeBytes: d.sizeBytes,
      deliveredToChat: d.deliveredToChat === true,
      ...(d.discarded === true ? { discarded: true } : {}),
    })),
    traceId: row.traceId,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

/** All runs (optionally scoped to one chat), newest first. */
export async function listAgentRuns(
  db: StoreDb,
  chatRef?: string,
): Promise<AgentRun[]> {
  const rows = await db.query.agentRuns.findMany({
    where: chatRef ? eq(agentRuns.chatRef, chatRef) : undefined,
    orderBy: [desc(agentRuns.createdAt)],
  });
  return rows.map(mapRow);
}

/** One run by id, or null. */
export async function getAgentRun(
  db: StoreDb,
  id: string,
): Promise<AgentRun | null> {
  const row = await db.query.agentRuns.findFirst({
    where: eq(agentRuns.id, id),
  });
  return row ? mapRow(row) : null;
}

/** One run plus its activity feed, screenshot seqs, and live state, or null. */
export async function getAgentRunDetail(
  db: StoreDb,
  id: string,
): Promise<AgentRunDetail | null> {
  const row = await db.query.agentRuns.findFirst({ where: eq(agentRuns.id, id) });
  if (!row) return null;
  const run = mapRow(row);
  const shots = await db
    .select({ seq: agentRunScreenshots.seq })
    .from(agentRunScreenshots)
    .where(eq(agentRunScreenshots.runId, id))
    .orderBy(asc(agentRunScreenshots.seq));
  return {
    ...run,
    // `seq` is presentational, derived from stored order (1-based).
    activity: (row.activity ?? []).map((s, i): AgentRunStep => ({ ...s, seq: i + 1 })),
    screenshotSeqs: shots.map((s) => s.seq),
    // Live state only makes sense while the run is in flight.
    live: run.status === "running" ? getLiveState(id) : null,
  };
}

/** Append one completed action to a run's activity feed. Returns the new length (seq). */
export async function appendAgentRunStep(
  db: StoreDb,
  runId: string,
  step: Omit<AgentRunStep, "seq">,
): Promise<void> {
  await db
    .update(agentRuns)
    .set({
      activity: sql`${agentRuns.activity} || ${JSON.stringify([step])}::jsonb`,
      steps: sql`${agentRuns.steps} + 1`,
    })
    .where(eq(agentRuns.id, runId));
}

/** Insert a queued run with an app-generated id. Returns the stored record. */
export async function insertAgentRun(
  db: StoreDb,
  id: string,
  values: InsertAgentRun,
): Promise<AgentRun> {
  const [row] = await db
    .insert(agentRuns)
    .values({
      id,
      chatRef: values.chatRef,
      threadId: values.threadId,
      createdByUserRef: values.createdByUserRef,
      assistantId: values.assistantId,
      isOwner: values.isOwner,
      senderIsOwner: values.senderIsOwner,
      authorityIsOwner: values.authorityIsOwner,
      correlationId: values.correlationId,
      restricted: values.restricted,
      sourceUrls: values.sourceUrls,
      goal: values.goal,
      context: values.context,
      quiet: values.quiet,
      status: "queued",
    })
    .returning();
  return mapRow(row);
}

/** Queued runs, oldest-first — the runner's work queue. */
export async function listQueuedAgentRuns(db: StoreDb): Promise<AgentRun[]> {
  const rows = await db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.status, "queued"))
    .orderBy(asc(agentRuns.createdAt));
  return rows.map(mapRow);
}

/**
 * Claim a queued run for execution: flip it to `running` and stamp `started_at`,
 * but only if it is still `queued`. Returns the claimed run, or null when another
 * worker (or a redeploy) already took it — the atomic guard against double-run.
 */
export async function claimAgentRun(
  db: StoreDb,
  id: string,
): Promise<AgentRun | null> {
  const [row] = await db
    .update(agentRuns)
    .set({ status: "running", startedAt: new Date(), traceId: null })
    .where(and(eq(agentRuns.id, id), eq(agentRuns.status, "queued")))
    .returning();
  return row ? mapRow(row) : null;
}

/** Attach the execution trace id to a running run (for Debug drill-down). */
export async function setAgentRunTrace(
  db: StoreDb,
  id: string,
  traceId: string,
): Promise<void> {
  await db.update(agentRuns).set({ traceId }).where(eq(agentRuns.id, id));
}

/**
 * Settle a run as done or failed with its report/error and downloads. `steps` is
 * owned by {@link appendAgentRunStep} (incremented per completed action), so it
 * is deliberately not written here — the count already reflects every step.
 */
export async function settleAgentRun(
  db: StoreDb,
  id: string,
  input: {
    status: Extract<AgentRunStatus, "done" | "failed">;
    report?: string | null;
    error?: string | null;
    downloads: BrowserDownloadRecord[];
  },
): Promise<void> {
  await db
    .update(agentRuns)
    .set({
      status: input.status,
      report: input.report ?? null,
      error: input.error ?? null,
      downloads: input.downloads,
      finishedAt: new Date(),
    })
    .where(eq(agentRuns.id, id));
}

/**
 * Fail any run left `running` from a previous process (a crash/redeploy mid-run).
 * Called once at startup so a dead run never blocks the dashboard as "running"
 * forever. Returns how many were reset.
 */
export async function failStaleRunningRuns(db: StoreDb): Promise<number> {
  const rows = await db
    .update(agentRuns)
    .set({
      status: "failed",
      error: "Interrupted by a server restart",
      finishedAt: new Date(),
    })
    .where(eq(agentRuns.status, "running"))
    .returning({ id: agentRuns.id });
  return rows.length;
}

/** Store one screenshot's bytes at the given capture sequence. */
export async function insertAgentRunScreenshot(
  db: StoreDb,
  input: { runId: string; seq: number; url: string | null; title: string | null; data: Buffer },
): Promise<void> {
  await db.insert(agentRunScreenshots).values({
    runId: input.runId,
    seq: input.seq,
    url: input.url,
    title: input.title,
    data: input.data,
  });
}

/** One screenshot's bytes by (run, seq), or null. */
export async function getAgentRunScreenshot(
  db: StoreDb,
  runId: string,
  seq: number,
): Promise<Buffer | null> {
  const row = await db.query.agentRunScreenshots.findFirst({
    where: and(eq(agentRunScreenshots.runId, runId), eq(agentRunScreenshots.seq, seq)),
    columns: { data: true },
  });
  return row?.data ?? null;
}
