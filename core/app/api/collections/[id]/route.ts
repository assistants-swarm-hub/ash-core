import { requireOwnCollection } from "@/features/collections/server/ownership";
import { updateCollectionSchema } from "@/features/collections/server/schema";
import { editCollectionService, removeCollectionService } from "@/features/collections/server/service";
import { defineRoute, ok, parseJson } from "@/server/http";

/**
 * Single-collection API. Account level, gated through the collection's
 * assistant: a user-role account reaches only its own assistants'
 * collections (an unknown or foreign id is `not_found`).
 */
export const GET = defineRoute(
  async ({ params, account }) => ok(await requireOwnCollection(account, params.id)),
  { access: "account" },
);

export const PATCH = defineRoute(
  async ({ request, params, account }) => {
    await requireOwnCollection(account, params.id);
    const input = await parseJson(request, updateCollectionSchema);
    return ok(await editCollectionService(params.id, input, { kind: "dashboard" }, { kind: "dashboard" }));
  },
  { access: "account" },
);

export const DELETE = defineRoute(
  async ({ params, account }) => {
    await requireOwnCollection(account, params.id);
    await removeCollectionService(params.id, { kind: "dashboard" }, { kind: "dashboard" });
    return ok({ deleted: true });
  },
  { access: "account" },
);
