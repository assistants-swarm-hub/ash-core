import { getAgentRunView } from "@/features/agents/server/service";
import { ApiError } from "@/lib/api-error";
import { defineRoute, ok } from "@/server/http";

/** One agent run with its screenshot sequence numbers. */
export const GET = defineRoute(async ({ params }) => {
  const run = await getAgentRunView(params.id);
  if (!run) throw ApiError.notFound("Browser run not found");
  return ok(run);
});
