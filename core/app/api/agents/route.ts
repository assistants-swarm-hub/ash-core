import { getAgentRuns } from "@/features/agents/server/service";
import { defineRoute, ok } from "@/server/http";

/**
 * Agent runs API: `GET` lists every run for the dashboard. There is no
 * `POST`: a run is only ever started by an assistant's chat turn through
 * `start_agent` (user decision, 2026-09-08 — a run with no chat and no
 * assistant is not the agent), and the runner owns execution.
 */
export const GET = defineRoute(async () => ok({ runs: await getAgentRuns() }));
