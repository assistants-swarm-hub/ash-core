import { Bug, Database } from "lucide-react";
import Link from "next/link";

import { Button, EmptyState, PageHeader } from "@/components/ui";
import { LiveIndicator } from "@/components/realtime/LiveIndicator";
import { getAssistants } from "@/features/assistants/server/service";
import { queryRowsQuerySchema, rowQueryFromSearch } from "@/features/collections/server/schema";
import { getCollectionsView, queryRowsService } from "@/features/collections/server/service";
import type { Collection, RowFilter, RowPage } from "@/features/collections/types";
import {
  CollectionsManager,
  type CollectionsTab,
  type RowsSearch,
} from "@/features/collections/ui/CollectionsManager";
import { featureDebugHref } from "@/lib/features";
import type { Trace } from "@/lib/trace";
import { actingAccount } from "@/server/auth/acting";
import { ownedAssistantIds } from "@/server/ownership";
import { getTraceList } from "@/server/trace";

// Collections and their rows are read at request time.
export const dynamic = "force-dynamic";

const TABS: CollectionsTab[] = ["rows", "columns", "instructions", "activity"];

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Collections dashboard page. Server Component: loads the owned assistants,
 * their collections (an assistant facet narrows the list), and for the
 * selected collection one page of rows under the URL's query plus its recent
 * traces, then delegates every interaction to a Client Component that
 * live-updates over the shared SSE stream.
 */
export default async function CollectionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  // Role-scoped: a user sees and edits collections of their own assistants.
  const account = await actingAccount();
  const restricted = account?.role === "user";
  const assistantParam = first(sp.assistant) ?? "";
  const collectionParam = first(sp.collection) ?? "";
  const tabParam = first(sp.tab);
  const tab: CollectionsTab = TABS.includes(tabParam as CollectionsTab) ? (tabParam as CollectionsTab) : "rows";

  let assistants: { id: string; name: string }[] = [];
  let collections: Collection[] = [];
  let selected: Collection | null = null;
  let rows: RowPage | null = null;
  let rowsError: string | null = null;
  let activity: Trace[] = [];
  let dbError: string | null = null;
  const search: RowsSearch = {
    q: first(sp.q) ?? "",
    gaps: first(sp.gaps) === "1",
    sort: first(sp.sort) ?? "",
    direction: first(sp.direction) === "desc" ? "desc" : "asc",
    offset: Number(first(sp.offset) ?? 0) || 0,
    limit: Number(first(sp.limit) ?? 20) || 20,
    filters: [],
  };
  try {
    const [assistantRows, owned] = await Promise.all([getAssistants(), ownedAssistantIds(account)]);
    assistants = assistantRows
      .filter((a) => owned === null || owned.has(a.id))
      .map((a) => ({ id: a.id, name: a.name }));
    const visible = new Set(assistants.map((a) => a.id));
    const facet = assistantParam && visible.has(assistantParam) ? assistantParam : "";
    collections = await getCollectionsView({ assistantIds: facet ? [facet] : [...visible] });
    selected = collections.find((c) => c.id === collectionParam) ?? null;
    if (selected) {
      const parsed = queryRowsQuerySchema.safeParse({
        q: first(sp.q),
        gaps: first(sp.gaps),
        sort: first(sp.sort),
        direction: first(sp.direction),
        offset: first(sp.offset),
        limit: first(sp.limit),
        filters: first(sp.filters),
      });
      try {
        const query = rowQueryFromSearch(parsed.success ? parsed.data : {});
        search.filters = query.filters as RowFilter[];
        rows = await queryRowsService(selected.id, query, { kind: "dashboard" });
      } catch (err) {
        rowsError = err instanceof Error ? err.message : "Could not query the rows";
      }
      activity = (
        await getTraceList({ feature: "collections", relatedId: selected.id, limit: 30 }).catch(() => ({
          traces: [] as Trace[],
        }))
      ).traces;
    }
  } catch (err) {
    dbError = err instanceof Error ? err.message : "Could not read collections from the database";
  }

  return (
    <>
      <PageHeader
        title="Collections"
        description="Structured data an assistant keeps: typed columns it proposed, rows it fills from chat, files and lookups."
        actions={
          <div className="flex items-center gap-2">
            <LiveIndicator topic="collections" />
            {restricted ? null : (
              <Button asChild variant="outline" size="sm">
                <Link href={featureDebugHref("collections")}>
                  <Bug className="h-4 w-4" aria-hidden />
                  Debug
                </Link>
              </Button>
            )}
          </div>
        }
      />

      {dbError ? (
        <EmptyState icon={Database} title="Database unavailable" description={dbError} />
      ) : (
        <CollectionsManager
          assistants={assistants}
          assistantId={assistantParam && assistants.some((a) => a.id === assistantParam) ? assistantParam : ""}
          collections={collections}
          selected={selected}
          tab={tab}
          rows={rows}
          rowsError={rowsError}
          search={search}
          activity={activity}
          restricted={restricted}
        />
      )}
    </>
  );
}
