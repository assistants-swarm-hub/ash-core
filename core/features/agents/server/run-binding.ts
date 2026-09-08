import "server-only";

import { parseScopedRef, tryParseScopedRef } from "@assistants-swarm-hub/contracts";

import type { McpToolContext } from "@/server/mcp/context";

import type { AgentRun } from "../types";
import type { RunOutcomeVerdict } from "./outcome";

/**
 * The pure decisions the runner takes about one run: which turn it acts in,
 * and whether its outcome is posted. Kept apart from the runner so they are
 * unit-testable without its runtime (the store, the browser session, the
 * outbound ports).
 */

/**
 * The turn a chat-started run acts in, rebuilt from the row — the binding
 * `start_agent` stamped at enqueue. Null for a dashboard run (no chat, no
 * assistant), which then holds the browser tools only.
 */
export function runTurnBinding(run: AgentRun): McpToolContext | null {
  if (!run.chatRef || !run.assistantId) return null;
  const chat = parseScopedRef(run.chatRef);
  const user = run.createdByUserRef ? tryParseScopedRef(run.createdByUserRef) : null;
  return {
    source: chat.source,
    chatId: chat.id,
    assistantId: run.assistantId,
    userId: user?.id ?? null,
    // The run's tool traces join the turn that started it.
    correlationId: run.correlationId ?? run.id,
    senderIsOwner: run.senderIsOwner,
    authorityIsOwner: run.authorityIsOwner,
    messageUrls: run.sourceUrls,
    threadId: run.threadId,
    // A run speaks unprompted, like a fire; its notes go out without a ping —
    // the report the runner posts afterwards is the one that pings.
    deliveryKind: "send",
    silentDelivery: true,
  };
}

/**
 * Whether a run's outcome is posted to its chat. Every ordinary run posts; a
 * quiet run (batch work nobody is waiting on) posts only when the goal failed
 * — the failure is the one thing the chat must hear — or when a file was
 * downloaded, because a file is a deliverable, not chatter.
 */
export function shouldPostReport(
  run: Pick<AgentRun, "quiet">,
  verdict: Pick<RunOutcomeVerdict, "goalFailed">,
  stagedFiles: number,
): boolean {
  return !run.quiet || verdict.goalFailed || stagedFiles > 0;
}
