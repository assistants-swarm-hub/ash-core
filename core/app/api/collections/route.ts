import { z } from "zod";

import { createCollectionSchema } from "@/features/collections/server/schema";
import { createCollectionService, getCollectionsView } from "@/features/collections/server/service";
import { defineRoute, ok, parseJson, parseQuery } from "@/server/http";
import { isRestricted, ownedAssistantIds, requireAssistantOwnership } from "@/server/ownership";

/**
 * Collections API. Thin handlers: the service owns validation, persistence
 * and trace recording. Account level: a user-role account sees and creates
 * collections of its OWN assistants only; admins see the whole set.
 */
const listQuerySchema = z.object({ assistant: z.string().optional() });

export const GET = defineRoute(
  async ({ request, account }) => {
    const { assistant } = parseQuery(request, listQuerySchema);
    const owned = isRestricted(account) ? (await ownedAssistantIds(account))! : null;
    const assistantIds = assistant
      ? owned && !owned.has(assistant)
        ? []
        : [assistant]
      : owned
        ? [...owned]
        : null;
    return ok(await getCollectionsView({ assistantIds }));
  },
  { access: "account" },
);

export const POST = defineRoute(
  async ({ request, account }) => {
    const input = await parseJson(request, createCollectionSchema);
    await requireAssistantOwnership(account, input.assistantId);
    return ok(await createCollectionService(input, { kind: "dashboard" }, { kind: "dashboard" }), {
      status: 201,
    });
  },
  { access: "account" },
);
