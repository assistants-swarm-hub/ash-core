"use client";

import { Bug, Download, Pencil, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  EmptyState,
  Field,
  Input,
  Modal,
  Pagination,
  Progress,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  Tabs,
  Textarea,
  useConfirm,
} from "@/components/ui";
import { useLiveRefresh } from "@/components/realtime/useLiveRefresh";
import { Timestamp } from "@/components/time/Timestamp";
import { TraceStatusBadge } from "@/components/debug/TraceStatusBadge";
import type { ApiErrorBody } from "@/lib/api-error";
import { debugFilterHref, type Trace } from "@/lib/trace";

import { checkColumns, isEmptyValue, ratingScale, renderValue } from "../columns";
import { buildCollectionsBlock } from "../format";
import {
  COLUMN_TYPE_LABELS,
  COLUMN_TYPES,
  KEY_COLUMN_TYPES,
  MAX_COLUMNS,
  MAX_QUERY_PAGE,
  type Collection,
  type CollectionColumn,
  type CollectionRow,
  type CollectionVisibility,
  type ColumnType,
  type RowFilter,
  type RowPage,
  type RowValue,
} from "../types";

/**
 * Collections manager. Client Component for the whole page: the assistant
 * facet, the collection list, and — for the selected collection — the four
 * tabs (Rows / Columns / Instructions / Activity). Every filter is a URL
 * control, so a view is a link; every mutation calls the collections API
 * and `router.refresh()` re-reads the server render (also kept fresh live
 * over the `collections` SSE topic).
 */

/** The query-string state of the rows tab, as the page parsed it. */
export interface RowsSearch {
  q: string;
  gaps: boolean;
  sort: string;
  direction: "asc" | "desc";
  offset: number;
  limit: number;
  filters: RowFilter[];
}

export type CollectionsTab = "rows" | "columns" | "instructions" | "activity";

export interface CollectionsManagerProps {
  assistants: { id: string; name: string }[];
  /** The assistant facet, or "" for every owned assistant. */
  assistantId: string;
  collections: Collection[];
  selected: Collection | null;
  tab: CollectionsTab;
  rows: RowPage | null;
  rowsError: string | null;
  search: RowsSearch;
  activity: Trace[];
  restricted: boolean;
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as ApiErrorBody;
    return body.error?.message ?? `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}

const FILTER_OPS: { value: RowFilter["op"]; label: string; needsValue: boolean }[] = [
  { value: "eq", label: "is", needsValue: true },
  { value: "neq", label: "is not", needsValue: true },
  { value: "contains", label: "contains", needsValue: true },
  { value: "gt", label: ">", needsValue: true },
  { value: "gte", label: "≥", needsValue: true },
  { value: "lt", label: "<", needsValue: true },
  { value: "lte", label: "≤", needsValue: true },
  { value: "empty", label: "is empty", needsValue: false },
  { value: "not_empty", label: "is filled", needsValue: false },
];

/** The page's URL for a state: only non-default keys are written. */
function hrefFor(state: {
  assistantId: string;
  collectionId?: string | null;
  tab?: CollectionsTab;
  search?: Partial<RowsSearch>;
}): string {
  const params = new URLSearchParams();
  if (state.assistantId) params.set("assistant", state.assistantId);
  if (state.collectionId) params.set("collection", state.collectionId);
  if (state.tab && state.tab !== "rows") params.set("tab", state.tab);
  const s = state.search;
  if (s) {
    if (s.q) params.set("q", s.q);
    if (s.gaps) params.set("gaps", "1");
    if (s.sort) params.set("sort", s.sort);
    if (s.direction && s.direction !== "asc") params.set("direction", s.direction);
    if (s.offset) params.set("offset", String(s.offset));
    if (s.limit && s.limit !== 20) params.set("limit", String(s.limit));
    if (s.filters && s.filters.length > 0) params.set("filters", JSON.stringify(s.filters));
  }
  const qs = params.toString();
  return qs ? `/collections?${qs}` : "/collections";
}

/* ------------------------------ the page ------------------------------ */

export function CollectionsManager(props: CollectionsManagerProps) {
  const router = useRouter();
  useLiveRefresh("collections");
  const [dialog, setDialog] = useState<"closed" | "create">("closed");
  const { confirm, dialog: confirmDialog } = useConfirm();
  const { assistants, assistantId, collections, selected } = props;

  async function deleteCollection(collection: Collection) {
    const ok = await confirm({
      title: `Delete "${collection.name}"?`,
      body: `Every one of its ${collection.rowCount} rows goes with it. This cannot be undone.`,
      confirmLabel: "Delete collection",
      tone: "danger",
    });
    if (!ok) return;
    const res = await fetch(`/api/collections/${encodeURIComponent(collection.id)}`, { method: "DELETE" });
    if (!res.ok) {
      alert(await readError(res));
      return;
    }
    router.push(hrefFor({ assistantId }));
    router.refresh();
  }

  return (
    <div className="space-y-6">
      {confirmDialog}
      <div className="flex flex-wrap items-end gap-3">
        <Field id="collections-assistant" label="Assistant" className="min-w-56">
          {({ id }) => (
            <Select
              id={id}
              value={assistantId}
              onChange={(e) => router.push(hrefFor({ assistantId: e.target.value }))}
            >
              <option value="">Every assistant</option>
              {assistants.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Button onClick={() => setDialog("create")} disabled={assistants.length === 0}>
          <Plus className="h-4 w-4" aria-hidden />
          New collection
        </Button>
      </div>

      {collections.length === 0 ? (
        <EmptyState
          icon={Plus}
          title="No collections yet"
          description="An assistant creates one when asked to store structured data — or start one here with its columns."
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {collections.map((collection) => {
            const active = selected?.id === collection.id;
            const complete = collection.rowCount - collection.gapCount;
            return (
              <Link
                key={collection.id}
                href={hrefFor({ assistantId, collectionId: collection.id })}
                className="block rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                aria-current={active ? "page" : undefined}
              >
                <Card interactive className={active ? "border-primary" : undefined}>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      {collection.name}
                      <Badge tone={collection.visibility === "shared" ? "info" : "neutral"}>
                        {collection.visibility}
                      </Badge>
                    </CardTitle>
                    <CardDescription>
                      {assistants.find((a) => a.id === collection.assistantId)?.name ?? collection.assistantId}
                      {" · "}
                      {collection.rowCount} rows
                      {collection.gapCount > 0 ? `, ${collection.gapCount} with gaps` : ""}
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <Progress
                      value={complete}
                      max={Math.max(collection.rowCount, 1)}
                      tone={collection.gapCount === 0 ? "success" : "primary"}
                      label={`${complete} of ${collection.rowCount} rows complete`}
                    />
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      )}

      {selected ? (
        <Card>
          <CardHeader className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle>{selected.name}</CardTitle>
              <CardDescription>
                {selected.description || "No description."} {selected.rowCount} rows,{" "}
                {selected.gapCount} with gaps. Created <Timestamp iso={selected.createdAt} />.
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Button asChild variant="outline" size="sm">
                <a href={`/api/collections/${encodeURIComponent(selected.id)}/export`}>
                  <Download className="h-4 w-4" aria-hidden />
                  Export CSV
                </a>
              </Button>
              {props.restricted ? null : (
                <Button asChild variant="outline" size="sm">
                  <Link href={debugFilterHref({ feature: "collections", relatedId: selected.id })}>
                    <Bug className="h-4 w-4" aria-hidden />
                    Debug
                  </Link>
                </Button>
              )}
              <Button variant="danger" size="sm" onClick={() => deleteCollection(selected)}>
                <Trash2 className="h-4 w-4" aria-hidden />
                Delete
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <Tabs
              value={props.tab}
              onValueChange={(id) =>
                router.push(hrefFor({ assistantId, collectionId: selected.id, tab: id as CollectionsTab }))
              }
              tabs={[
                {
                  id: "rows",
                  label: `Rows (${selected.rowCount})`,
                  content: (
                    <RowsTab
                      collection={selected}
                      assistantId={assistantId}
                      rows={props.rows}
                      rowsError={props.rowsError}
                      search={props.search}
                    />
                  ),
                },
                {
                  id: "columns",
                  label: `Columns (${selected.columns.length})`,
                  content: <ColumnsTab collection={selected} />,
                },
                { id: "instructions", label: "Instructions", content: <InstructionsTab collection={selected} /> },
                {
                  id: "activity",
                  label: "Activity",
                  content: <ActivityTab collection={selected} activity={props.activity} />,
                },
              ]}
            />
          </CardContent>
        </Card>
      ) : null}

      {dialog === "create" ? (
        <CreateCollectionDialog
          assistants={assistants}
          assistantId={assistantId || assistants[0]?.id || ""}
          onClose={() => setDialog("closed")}
          onCreated={(collection) => {
            setDialog("closed");
            router.push(hrefFor({ assistantId, collectionId: collection.id }));
            router.refresh();
          }}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------ rows tab ------------------------------ */

function RowsTab({
  collection,
  assistantId,
  rows,
  rowsError,
  search,
}: {
  collection: Collection;
  assistantId: string;
  rows: RowPage | null;
  rowsError: string | null;
  search: RowsSearch;
}) {
  const router = useRouter();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [editing, setEditing] = useState<CollectionRow | "new" | null>(null);
  const [draft, setDraft] = useState<RowsSearch>(search);
  const columns = collection.columns;
  const keyColumn = columns.find((c) => c.isKey) ?? columns[0];

  const go = (next: Partial<RowsSearch>) =>
    router.push(hrefFor({ assistantId, collectionId: collection.id, search: { ...draft, offset: 0, ...next } }));

  async function deleteRow(row: CollectionRow) {
    const ok = await confirm({
      title: `Delete row "${row.keyValue}"?`,
      body: "The row is removed from the collection.",
      confirmLabel: "Delete row",
      tone: "danger",
    });
    if (!ok) return;
    const res = await fetch(
      `/api/collections/${encodeURIComponent(collection.id)}/rows/${encodeURIComponent(row.id)}`,
      { method: "DELETE" },
    );
    if (!res.ok) {
      alert(await readError(res));
      return;
    }
    router.refresh();
  }

  return (
    <div className="space-y-4">
      {confirmDialog}
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          go({});
        }}
      >
        <Field id="rows-q" label="Search" className="min-w-56 flex-1">
          {({ id }) => (
            <Input
              id={id}
              value={draft.q}
              placeholder="Free text — by meaning when embeddings are configured"
              onChange={(e) => setDraft({ ...draft, q: e.target.value })}
            />
          )}
        </Field>
        <Field id="rows-sort" label="Sort by">
          {({ id }) => (
            <Select id={id} value={draft.sort} onChange={(e) => setDraft({ ...draft, sort: e.target.value })}>
              <option value="">Insertion order</option>
              {columns.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field id="rows-direction" label="Direction">
          {({ id }) => (
            <Select
              id={id}
              value={draft.direction}
              onChange={(e) => setDraft({ ...draft, direction: e.target.value as "asc" | "desc" })}
            >
              <option value="asc">Ascending</option>
              <option value="desc">Descending</option>
            </Select>
          )}
        </Field>
        <label className="flex h-9 items-center gap-2 text-sm">
          <Checkbox checked={draft.gaps} onChange={(e) => setDraft({ ...draft, gaps: e.target.checked })} />
          Only rows with gaps
        </label>
        <Button type="submit" variant="outline">
          Apply
        </Button>
        <Button type="button" onClick={() => setEditing("new")}>
          <Plus className="h-4 w-4" aria-hidden />
          Add row
        </Button>
      </form>

      <FiltersEditor
        columns={columns}
        filters={draft.filters}
        onChange={(filters) => setDraft({ ...draft, filters })}
      />

      {rowsError ? (
        <p className="text-sm text-danger">{rowsError}</p>
      ) : !rows ? null : rows.rows.length === 0 ? (
        <EmptyState
          icon={Plus}
          title={rows.total === 0 && !search.q && search.filters.length === 0 && !search.gaps ? "No rows yet" : "Nothing matches"}
          description={
            rows.total === 0 && !search.q && search.filters.length === 0 && !search.gaps
              ? "Rows arrive from the chat — an import, an item the assistant adds — or from the Add row button."
              : "Loosen the search, the filters or the gaps switch."
          }
        />
      ) : (
        <>
          {rows.semantic ? <p className="text-xs text-muted">Ranked by meaning for “{search.q}”.</p> : null}
          <Table>
            <TableHead>
              <TableRow>
                {columns.map((c) => (
                  <TableHeaderCell key={c.key}>
                    {c.label}
                    {c.isKey ? <span className="ml-1 text-xs text-muted">key</span> : null}
                  </TableHeaderCell>
                ))}
                <TableHeaderCell>Complete</TableHeaderCell>
                <TableHeaderCell>Updated</TableHeaderCell>
                <TableHeaderCell className="w-24" />
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.rows.map((row) => (
                <TableRow key={row.id}>
                  {columns.map((c) => (
                    <TableCell key={c.key} className="max-w-64 truncate align-top">
                      <CellValue column={c} value={row.values[c.key] ?? null} />
                    </TableCell>
                  ))}
                  <TableCell className="align-top">
                    <Badge tone={row.complete ? "success" : "warning"}>{row.complete ? "yes" : "gaps"}</Badge>
                  </TableCell>
                  <TableCell className="align-top whitespace-nowrap text-muted">
                    <Timestamp iso={row.updatedAt} />
                  </TableCell>
                  <TableCell className="align-top">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => setEditing(row)} aria-label={`Edit ${row.keyValue}`}>
                        <Pencil className="h-4 w-4" aria-hidden />
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => deleteRow(row)} aria-label={`Delete ${row.keyValue}`}>
                        <Trash2 className="h-4 w-4" aria-hidden />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Pagination
            total={rows.total}
            limit={rows.limit}
            offset={rows.offset}
            noun="row"
            hrefFor={(offset) => hrefFor({ assistantId, collectionId: collection.id, search: { ...search, offset } })}
          />
        </>
      )}

      {editing ? (
        <RowDialog
          collection={collection}
          row={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            router.refresh();
          }}
        />
      ) : null}
      <p className="text-xs text-muted">
        Key column: {keyColumn?.label}. A row written with an existing key updates that row. Pages of up to {MAX_QUERY_PAGE}.
      </p>
    </div>
  );
}

function CellValue({ column, value }: { column: CollectionColumn; value: RowValue }) {
  if (isEmptyValue(value)) return <span className="text-faint">—</span>;
  if (column.type === "image" && typeof value === "string") {
    return (
      <a href={value} target="_blank" rel="noreferrer noopener" className="inline-block">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={value} alt="" className="h-12 w-auto rounded object-cover" loading="lazy" />
      </a>
    );
  }
  if (column.type === "url" && typeof value === "string") {
    return (
      <a href={value} target="_blank" rel="noreferrer noopener" className="text-primary underline-offset-2 hover:underline">
        {value}
      </a>
    );
  }
  if (column.type === "rating" && typeof value === "number") return <>{value} / {ratingScale(column)}</>;
  return <span title={renderValue(value)}>{renderValue(value)}</span>;
}

function FiltersEditor({
  columns,
  filters,
  onChange,
}: {
  columns: CollectionColumn[];
  filters: RowFilter[];
  onChange: (filters: RowFilter[]) => void;
}) {
  const update = (index: number, patch: Partial<RowFilter>) =>
    onChange(filters.map((f, i) => (i === index ? { ...f, ...patch } : f)));
  return (
    <div className="space-y-2">
      {filters.map((filter, index) => {
        const op = FILTER_OPS.find((o) => o.value === filter.op);
        return (
          <div key={index} className="flex flex-wrap items-center gap-2">
            <Select value={filter.column} onChange={(e) => update(index, { column: e.target.value })} aria-label="Column">
              {columns.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </Select>
            <Select
              value={filter.op}
              onChange={(e) => update(index, { op: e.target.value as RowFilter["op"] })}
              aria-label="Condition"
            >
              {FILTER_OPS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
            {op?.needsValue ? (
              <Input
                value={filter.value == null ? "" : String(filter.value)}
                onChange={(e) => update(index, { value: e.target.value })}
                aria-label="Value"
                className="w-48"
              />
            ) : null}
            <Button variant="ghost" size="sm" onClick={() => onChange(filters.filter((_, i) => i !== index))} aria-label="Remove filter">
              <Trash2 className="h-4 w-4" aria-hidden />
            </Button>
          </div>
        );
      })}
      {filters.length < 10 ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onChange([...filters, { column: columns[0]?.key ?? "", op: "contains", value: "" }])}
        >
          <Plus className="h-4 w-4" aria-hidden />
          Add filter
        </Button>
      ) : null}
    </div>
  );
}

/** The form control for one cell, by column type. Values travel as strings and are typed on save. */
function ValueInput({
  column,
  value,
  onChange,
  id,
}: {
  column: CollectionColumn;
  value: string;
  onChange: (value: string) => void;
  id: string;
}) {
  switch (column.type) {
    case "long_text":
    case "list":
      return (
        <Textarea
          id={id}
          value={value}
          rows={column.type === "list" ? 2 : 4}
          placeholder={column.type === "list" ? "One item per line, or comma-separated" : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case "enum":
      return (
        <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">—</option>
          {(column.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </Select>
      );
    case "boolean":
      return (
        <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">—</option>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </Select>
      );
    case "number":
      return <Input id={id} type="number" step="any" value={value} onChange={(e) => onChange(e.target.value)} />;
    case "rating":
      return (
        <Input id={id} type="number" min={0} max={ratingScale(column)} step="any" value={value} onChange={(e) => onChange(e.target.value)} />
      );
    case "date":
      return <Input id={id} type="date" value={value.slice(0, 10)} onChange={(e) => onChange(e.target.value)} />;
    case "url":
    case "image":
      return <Input id={id} type="url" value={value} placeholder="https://…" onChange={(e) => onChange(e.target.value)} />;
    default:
      return <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} />;
  }
}

/** A stored value as its form text. */
function toFormValue(value: RowValue | undefined): string {
  if (value == null) return "";
  if (Array.isArray(value)) return value.join("\n");
  return String(value);
}

/** A form text as the value the API takes — empty means null (a gap). */
function fromFormValue(column: CollectionColumn, text: string): RowValue {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (column.type === "list") return trimmed.split(/[\n,;]/).map((s) => s.trim()).filter(Boolean);
  if (column.type === "boolean") return trimmed === "true";
  if (column.type === "number" || column.type === "rating") return Number(trimmed);
  return trimmed;
}

function RowDialog({
  collection,
  row,
  onClose,
  onSaved,
}: {
  collection: Collection;
  row: CollectionRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(collection.columns.map((c) => [c.key, toFormValue(row?.values[c.key])])),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const body = {
        values: Object.fromEntries(collection.columns.map((c) => [c.key, fromFormValue(c, values[c.key] ?? "")])),
      };
      const res = row
        ? await fetch(`/api/collections/${encodeURIComponent(collection.id)}/rows/${encodeURIComponent(row.id)}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          })
        : await fetch(`/api/collections/${encodeURIComponent(collection.id)}/rows`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      onSaved();
    } catch {
      setError("Network error — could not reach the server");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      busy={busy}
      size="lg"
      title={row ? `Edit row "${row.keyValue}"` : "Add row"}
      description="Every value is checked against its column's type. Leave a column empty to record a gap."
      footer={
        <>
          {error ? <p className="mr-auto text-sm text-danger">{error}</p> : null}
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy}>
            {busy ? "Saving…" : row ? "Save changes" : "Add row"}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {collection.columns.map((column) => (
          <Field
            key={column.key}
            id={`row-${column.key}`}
            label={`${column.label}${column.isKey ? " (key)" : ""}`}
            required={column.isKey}
            hint={
              column.type === "enum"
                ? undefined
                : column.type === "rating"
                  ? `0 to ${ratingScale(column)}`
                  : COLUMN_TYPE_LABELS[column.type]
            }
            className={column.type === "long_text" ? "sm:col-span-2" : undefined}
          >
            {({ id }) => (
              <ValueInput
                id={id}
                column={column}
                value={values[column.key] ?? ""}
                onChange={(value) => setValues({ ...values, [column.key]: value })}
              />
            )}
          </Field>
        ))}
      </div>
    </Modal>
  );
}

/* ------------------------------ columns tab ------------------------------ */

/** A column as the editor holds it: options as one text, scale as text. */
interface ColumnDraft {
  key: string;
  label: string;
  type: ColumnType;
  options: string;
  scale: string;
  isKey: boolean;
  requiredForComplete: boolean;
}

function toDraft(column: CollectionColumn): ColumnDraft {
  return {
    key: column.key,
    label: column.label,
    type: column.type,
    options: (column.options ?? []).join(", "),
    scale: column.scale == null ? "" : String(column.scale),
    isKey: column.isKey,
    requiredForComplete: column.requiredForComplete,
  };
}

function fromDraft(draft: ColumnDraft) {
  return {
    key: draft.key.trim(),
    label: draft.label.trim() || undefined,
    type: draft.type,
    options: draft.type === "enum" ? draft.options.split(/[,\n;]/).map((s) => s.trim()).filter(Boolean) : undefined,
    scale: draft.type === "rating" && draft.scale.trim() ? Number(draft.scale) : undefined,
    isKey: draft.isKey,
    requiredForComplete: draft.requiredForComplete,
  };
}

const EMPTY_COLUMN: ColumnDraft = {
  key: "",
  label: "",
  type: "text",
  options: "",
  scale: "",
  isKey: false,
  requiredForComplete: false,
};

/** The column list editor, shared by the create dialog and the Columns tab. */
function ColumnsEditor({
  columns,
  onChange,
  keyLocked,
}: {
  columns: ColumnDraft[];
  onChange: (columns: ColumnDraft[]) => void;
  /** The key column cannot move once the collection has rows. */
  keyLocked: boolean;
}) {
  const update = (index: number, patch: Partial<ColumnDraft>) =>
    onChange(columns.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  const setKey = (index: number) => onChange(columns.map((c, i) => ({ ...c, isKey: i === index })));
  return (
    <div className="space-y-3">
      {columns.map((column, index) => (
        <div key={index} className="grid gap-2 rounded-lg border border-border p-3 sm:grid-cols-[1fr_1fr_1fr_auto]">
          <Field id={`col-${index}-key`} label="Key">
            {({ id }) => (
              <Input
                id={id}
                value={column.key}
                placeholder="year"
                disabled={column.isKey && keyLocked}
                onChange={(e) => update(index, { key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_") })}
              />
            )}
          </Field>
          <Field id={`col-${index}-label`} label="Label">
            {({ id }) => <Input id={id} value={column.label} placeholder="Year" onChange={(e) => update(index, { label: e.target.value })} />}
          </Field>
          <Field id={`col-${index}-type`} label="Type">
            {({ id }) => (
              <Select
                id={id}
                value={column.type}
                disabled={column.isKey && keyLocked}
                onChange={(e) => update(index, { type: e.target.value as ColumnType })}
              >
                {COLUMN_TYPES.map((type) => (
                  <option key={type} value={type} disabled={column.isKey && !KEY_COLUMN_TYPES.includes(type)}>
                    {COLUMN_TYPE_LABELS[type]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <div className="flex items-end justify-end">
            <Button
              variant="ghost"
              size="sm"
              disabled={column.isKey && keyLocked}
              onClick={() => onChange(columns.filter((_, i) => i !== index))}
              aria-label={`Remove column ${column.key || index + 1}`}
            >
              <Trash2 className="h-4 w-4" aria-hidden />
            </Button>
          </div>
          {column.type === "enum" ? (
            <Field id={`col-${index}-options`} label="Options (comma-separated)" className="sm:col-span-4">
              {({ id }) => <Input id={id} value={column.options} onChange={(e) => update(index, { options: e.target.value })} />}
            </Field>
          ) : null}
          {column.type === "rating" ? (
            <Field id={`col-${index}-scale`} label="Scale (top of the range, default 10)">
              {({ id }) => <Input id={id} type="number" min={1} value={column.scale} onChange={(e) => update(index, { scale: e.target.value })} />}
            </Field>
          ) : null}
          <div className="flex flex-wrap gap-4 sm:col-span-4">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="key-column"
                checked={column.isKey}
                disabled={keyLocked || !KEY_COLUMN_TYPES.includes(column.type)}
                onChange={() => setKey(index)}
              />
              Key column
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={column.requiredForComplete}
                onChange={(e) => update(index, { requiredForComplete: e.target.checked })}
              />
              Needed for a row to be complete
            </label>
          </div>
        </div>
      ))}
      {columns.length < MAX_COLUMNS ? (
        <Button variant="outline" size="sm" onClick={() => onChange([...columns, { ...EMPTY_COLUMN, isKey: columns.length === 0 }])}>
          <Plus className="h-4 w-4" aria-hidden />
          Add column
        </Button>
      ) : null}
    </div>
  );
}

function ColumnsTab({ collection }: { collection: Collection }) {
  const router = useRouter();
  const [columns, setColumns] = useState<ColumnDraft[]>(collection.columns.map(toDraft));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const checked = checkColumns(columns.map(fromDraft));
  const removed = collection.columns.filter((c) => !columns.some((d) => d.key.trim() === c.key)).map((c) => c.label);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/collections/${encodeURIComponent(collection.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ columns: columns.map(fromDraft) }),
      });
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      router.refresh();
    } catch {
      setError("Network error — could not reach the server");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <ColumnsEditor columns={columns} onChange={setColumns} keyLocked={collection.rowCount > 0} />
      {!checked.ok ? <p className="text-sm text-danger">{checked.reason}</p> : null}
      {removed.length > 0 ? (
        <p className="text-sm text-warning">
          Removing {removed.join(", ")} drops those values from every row when you save.
        </p>
      ) : null}
      <div className="flex items-center gap-3">
        <Button onClick={save} disabled={busy || !checked.ok}>
          {busy ? "Saving…" : "Save columns"}
        </Button>
        <Button variant="ghost" onClick={() => setColumns(collection.columns.map(toDraft))} disabled={busy}>
          Reset
        </Button>
        {error ? <p className="text-sm text-danger">{error}</p> : null}
      </div>
    </div>
  );
}

/* --------------------------- instructions tab --------------------------- */

function InstructionsTab({ collection }: { collection: Collection }) {
  const router = useRouter();
  const [name, setName] = useState(collection.name);
  const [description, setDescription] = useState(collection.description);
  const [visibility, setVisibility] = useState<CollectionVisibility>(collection.visibility);
  const [fill, setFill] = useState(collection.fillInstruction);
  const [presentation, setPresentation] = useState(collection.presentationInstruction);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const preview = buildCollectionsBlock(
    [{ ...collection, name, description, visibility, fillInstruction: fill, presentationInstruction: presentation }],
    { ownerRights: true },
  );

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/collections/${encodeURIComponent(collection.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim(),
          visibility,
          fillInstruction: fill.trim(),
          presentationInstruction: presentation.trim(),
        }),
      });
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      router.refresh();
    } catch {
      setError("Network error — could not reach the server");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="space-y-4">
        <Field id="col-name" label="Name" required>
          {({ id }) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Field id="col-description" label="Description" hint="One or two sentences on what the collection holds.">
          {({ id }) => <Textarea id={id} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />}
        </Field>
        <Field
          id="col-visibility"
          label="Visibility"
          hint="Private: only senders with owner rights see it. Shared: anyone in a chat with the assistant may read and query; writes stay owner-only."
        >
          {({ id }) => (
            <Select id={id} value={visibility} onChange={(e) => setVisibility(e.target.value as CollectionVisibility)}>
              <option value="private">Private</option>
              <option value="shared">Shared</option>
            </Select>
          )}
        </Field>
        <Field
          id="col-fill"
          label="How to fill gaps"
          hint="In your words: where the assistant looks, what it records. Read by the assistant and by its background agents."
        >
          {({ id }) => <Textarea id={id} rows={4} value={fill} onChange={(e) => setFill(e.target.value)} />}
        </Field>
        <Field id="col-presentation" label="How to present an item" hint="How an item is shown in chat: which fields, in what order, with the image or not.">
          {({ id }) => <Textarea id={id} rows={4} value={presentation} onChange={(e) => setPresentation(e.target.value)} />}
        </Field>
        <div className="flex items-center gap-3">
          <Button onClick={save} disabled={busy || name.trim().length === 0}>
            {busy ? "Saving…" : "Save"}
          </Button>
          {error ? <p className="text-sm text-danger">{error}</p> : null}
        </div>
      </div>
      <div className="space-y-2">
        <p className="text-sm font-medium">What the assistant is told</p>
        <pre className="max-h-[32rem] overflow-auto rounded-lg border border-border bg-surface-2 p-3 text-xs whitespace-pre-wrap">
          {preview}
        </pre>
      </div>
    </div>
  );
}

/* ------------------------------ activity tab ------------------------------ */

function ActivityTab({ collection, activity }: { collection: Collection; activity: Trace[] }) {
  if (activity.length === 0) {
    return (
      <EmptyState
        icon={Bug}
        title="No activity recorded yet"
        description="Every create, import, row write and column change is traced here."
      />
    );
  }
  return (
    <div className="space-y-3">
      <Table>
        <TableHead>
          <TableRow>
            <TableHeaderCell>When</TableHeaderCell>
            <TableHeaderCell>Action</TableHeaderCell>
            <TableHeaderCell>Status</TableHeaderCell>
            <TableHeaderCell>Summary</TableHeaderCell>
            <TableHeaderCell />
          </TableRow>
        </TableHead>
        <TableBody>
          {activity.map((trace) => (
            <TableRow key={trace.id}>
              <TableCell className="whitespace-nowrap">
                <Timestamp iso={trace.startedAt} />
              </TableCell>
              <TableCell>{trace.action}</TableCell>
              <TableCell>
                <TraceStatusBadge status={trace.status} />
              </TableCell>
              <TableCell className="max-w-md truncate text-muted">{trace.outputSummary ?? trace.inputSummary ?? ""}</TableCell>
              <TableCell>
                <Link href={`/debug/${trace.id}`} className="text-primary underline-offset-2 hover:underline">
                  Trace
                </Link>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Link
        href={debugFilterHref({ feature: "collections", relatedId: collection.id })}
        className="text-sm text-primary underline-offset-2 hover:underline"
      >
        Everything about this collection in Debug
      </Link>
    </div>
  );
}

/* ------------------------------ create dialog ------------------------------ */

function CreateCollectionDialog({
  assistants,
  assistantId: initialAssistant,
  onClose,
  onCreated,
}: {
  assistants: { id: string; name: string }[];
  assistantId: string;
  onClose: () => void;
  onCreated: (collection: Collection) => void;
}) {
  const [assistantId, setAssistantId] = useState(initialAssistant);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<CollectionVisibility>("private");
  const [columns, setColumns] = useState<ColumnDraft[]>([
    { ...EMPTY_COLUMN, key: "title", label: "Title", isKey: true, requiredForComplete: true },
  ]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const checked = checkColumns(columns.map(fromDraft));

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/collections", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          assistantId,
          name: name.trim(),
          description: description.trim(),
          visibility,
          columns: columns.map(fromDraft),
        }),
      });
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      const body = (await res.json()) as { data: Collection };
      onCreated(body.data);
    } catch {
      setError("Network error — could not reach the server");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      busy={busy}
      size="lg"
      title="New collection"
      description="Typed columns the assistant fills and queries. Exactly one column is the key: the value that identifies an item."
      footer={
        <>
          {error ? <p className="mr-auto text-sm text-danger">{error}</p> : null}
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy || !assistantId || name.trim().length === 0 || !checked.ok}>
            {busy ? "Creating…" : "Create collection"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {assistants.length > 1 ? (
          <Field id="new-assistant" label="Assistant" required>
            {({ id }) => (
              <Select id={id} value={assistantId} onChange={(e) => setAssistantId(e.target.value)}>
                {assistants.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="new-name" label="Name" required>
            {({ id }) => <Input id={id} value={name} placeholder="Watchlist" onChange={(e) => setName(e.target.value)} />}
          </Field>
          <Field id="new-visibility" label="Visibility">
            {({ id }) => (
              <Select id={id} value={visibility} onChange={(e) => setVisibility(e.target.value as CollectionVisibility)}>
                <option value="private">Private</option>
                <option value="shared">Shared</option>
              </Select>
            )}
          </Field>
        </div>
        <Field id="new-description" label="Description">
          {({ id }) => <Textarea id={id} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />}
        </Field>
        <ColumnsEditor columns={columns} onChange={setColumns} keyLocked={false} />
        {!checked.ok ? <p className="text-sm text-danger">{checked.reason}</p> : null}
      </div>
    </Modal>
  );
}
