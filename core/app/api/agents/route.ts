import { z } from "zod";

import { enqueueAgentRun, getAgentRuns } from "@/features/agents/server/service";
import { emitRunEnqueued } from "@/features/agents/server/signal";
import { defineRoute, ok, parseJson } from "@/server/http";

/**
 * Agent runs API. `GET` lists all runs for the dashboard; `POST` queues a
 * dashboard-started run (no chat to deliver to — the report is stored on the run).
 * Thin handlers: the service owns persistence, the runner owns execution.
 */
export const GET = defineRoute(async () => ok({ runs: await getAgentRuns() }));

const createRunSchema = z.object({
  goal: z.string().trim().min(4).max(4000),
});

export const POST = defineRoute(async ({ request }) => {
  const { goal } = await parseJson(request, createRunSchema);
  // Dashboard runs are the operator's own — treat as owner (downloads enabled).
  const run = await enqueueAgentRun({ goal, chatRef: null, isOwner: true });
  emitRunEnqueued();
  return ok(run, { status: 201 });
});
