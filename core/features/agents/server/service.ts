import "server-only";

import { randomUUID } from "node:crypto";

import { getStoreDb, type StoreDb } from "@/server/store/db";

import type { AgentRun, AgentRunDetail } from "../types";
import {
  getAgentRunDetail,
  insertAgentRun,
  listAgentRuns,
  type InsertAgentRun,
} from "./repository";

/**
 * Agents domain service — the boundary the MCP tool, the dashboard Server
 * Components, and the Route Handlers call. It owns enqueuing (the run row is
 * the queue) and reads; the runner (`runner.ts`) owns execution. Tracing lives
 * in the runner, where the work actually happens — enqueuing is a plain insert.
 */

/**
 * Input to enqueue a run. A chat-started run carries the whole turn binding
 * (assistant, sender, owner rights, correlation) so the agent acts as that
 * assistant in that chat; a dashboard-started run has neither a chat nor an
 * assistant and holds the browser tools only.
 */
export interface EnqueueAgentRunInput {
  goal: string;
  /** Facts the starting turn gathered for the agent (default none). */
  context?: string | null;
  /** Post the final report only when the goal failed (default false). */
  quiet?: boolean;
  chatRef: string | null;
  threadId?: string | null;
  createdByUserRef?: string | null;
  /** The assistant the run acts as, or null (dashboard). */
  assistantId?: string | null;
  isOwner: boolean;
  /** The sender's own owner rights (default false). */
  senderIsOwner?: boolean;
  /** Owner permissions lent by a standing task (default false). */
  authorityIsOwner?: boolean;
  /** The starting turn's trace correlation (default none — the run id stands). */
  correlationId?: string | null;
  /** Rule-driven group run, or rights lent to a non-owner (default false). */
  restricted?: boolean;
  /** Verbatim URLs of the triggering message (default none). */
  sourceUrls?: string[];
}

/**
 * Enqueue a run. Returns the stored `queued` record; the caller signals the
 * runner to pick it up (so this stays a pure DB write, testable without the
 * runner singleton).
 */
export async function enqueueAgentRun(
  input: EnqueueAgentRunInput,
  db: StoreDb = getStoreDb(),
): Promise<AgentRun> {
  const context = input.context?.trim() ?? "";
  const values: InsertAgentRun = {
    chatRef: input.chatRef,
    threadId: input.threadId ?? null,
    createdByUserRef: input.createdByUserRef ?? null,
    assistantId: input.assistantId ?? null,
    isOwner: input.isOwner,
    senderIsOwner: input.senderIsOwner ?? false,
    authorityIsOwner: input.authorityIsOwner ?? false,
    correlationId: input.correlationId ?? null,
    restricted: input.restricted ?? false,
    sourceUrls: input.sourceUrls ?? [],
    goal: input.goal.trim(),
    context: context.length > 0 ? context : null,
    quiet: input.quiet ?? false,
  };
  return insertAgentRun(db, randomUUID(), values);
}

/** All runs (optionally chat-scoped), newest first — for the dashboard. */
export async function getAgentRuns(
  chatRef?: string,
  db: StoreDb = getStoreDb(),
): Promise<AgentRun[]> {
  return listAgentRuns(db, chatRef);
}

/** One run plus its screenshot sequence numbers, or null. */
export async function getAgentRunView(
  id: string,
  db: StoreDb = getStoreDb(),
): Promise<AgentRunDetail | null> {
  return getAgentRunDetail(db, id);
}
