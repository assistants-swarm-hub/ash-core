import { requireOwnCollection } from "@/features/collections/server/ownership";
import { exportCollectionCsv } from "@/features/collections/server/service";
import { csvDownload, defineRoute } from "@/server/http";

/** The whole collection as a CSV download (a header of column keys, one line per row). */
export const GET = defineRoute(
  async ({ params, account }) => {
    await requireOwnCollection(account, params.id);
    const { collection, csv } = await exportCollectionCsv(params.id, { kind: "dashboard" });
    const slug = collection.name.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-|-$/g, "") || "collection";
    return csvDownload(csv, `${slug}.csv`);
  },
  { access: "account" },
);
