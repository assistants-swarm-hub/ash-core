import { requireOwnCollection } from "@/features/collections/server/ownership";
import { addRowSchema, queryRowsQuerySchema, rowQueryFromSearch } from "@/features/collections/server/schema";
import { addRowService, queryRowsService } from "@/features/collections/server/service";
import { defineRoute, ok, parseJson, parseQuery } from "@/server/http";

/**
 * Rows of one collection: a filtered, sorted, paged query (every filter a
 * query-string control the dashboard renders) and the add-or-update-by-key
 * write. Account level, gated through the collection's assistant.
 */
export const GET = defineRoute(
  async ({ request, params, account }) => {
    await requireOwnCollection(account, params.id);
    const query = rowQueryFromSearch(parseQuery(request, queryRowsQuerySchema));
    return ok(await queryRowsService(params.id, query, { kind: "dashboard" }));
  },
  { access: "account" },
);

export const POST = defineRoute(
  async ({ request, params, account }) => {
    await requireOwnCollection(account, params.id);
    const { values } = await parseJson(request, addRowSchema);
    const result = await addRowService(params.id, values, {
      access: { kind: "dashboard" },
      trigger: { kind: "dashboard" },
    });
    return ok(result, { status: result.created ? 201 : 200 });
  },
  { access: "account" },
);
