import { requireOwnCollection } from "@/features/collections/server/ownership";
import { updateRowSchema } from "@/features/collections/server/schema";
import { editRowService, getRowService, removeRowService } from "@/features/collections/server/service";
import { defineRoute, ok, parseJson } from "@/server/http";

/** One row of a collection, by id. Account level, gated through the collection's assistant. */
export const GET = defineRoute(
  async ({ params, account }) => {
    await requireOwnCollection(account, params.id);
    return ok(await getRowService(params.id, { id: params.rowId }, { kind: "dashboard" }));
  },
  { access: "account" },
);

export const PATCH = defineRoute(
  async ({ request, params, account }) => {
    await requireOwnCollection(account, params.id);
    const { values } = await parseJson(request, updateRowSchema);
    return ok(
      await editRowService(params.id, { id: params.rowId }, values, {
        access: { kind: "dashboard" },
        trigger: { kind: "dashboard" },
      }),
    );
  },
  { access: "account" },
);

export const DELETE = defineRoute(
  async ({ params, account }) => {
    await requireOwnCollection(account, params.id);
    await removeRowService(params.id, { id: params.rowId }, { access: { kind: "dashboard" }, trigger: { kind: "dashboard" } });
    return ok({ deleted: true });
  },
  { access: "account" },
);
