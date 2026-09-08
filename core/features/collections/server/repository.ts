import "server-only";

import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";

import {
  collectionRows,
  collections,
  type CollectionInsert,
  type CollectionRow as CollectionRecordRow,
  type CollectionRowRow,
} from "../../../store/schema";
import type { StoreDb } from "@/server/store/db";

import { isComplete, isEmptyValue } from "../columns";
import type {
  Collection,
  CollectionColumn,
  CollectionRow,
  CollectionVisibility,
  RowFilter,
  RowValue,
} from "../types";

/**
 * Typed persistence for collections and their rows, over the core store.
 * Pure data access: no rights, no validation, no trace recording — the
 * service owns those. Every function takes a {@link StoreDb} so the same
 * code runs against the pool or a test instance.
 *
 * A row's cells live in one JSONB column keyed by column key, so a filter
 * or a sort on a column is an expression over `values` — typed by the
 * column's declared type, never by guessing at the cell.
 */

/** A collection with its live counts. */
export type CollectionRecord = Collection;

function toCollection(
  row: CollectionRecordRow,
  counts: { rowCount: number; gapCount: number },
): CollectionRecord {
  return {
    id: row.id,
    assistantId: row.assistantId,
    name: row.name,
    description: row.description,
    visibility: row.visibility as CollectionVisibility,
    fillInstruction: row.fillInstruction,
    presentationInstruction: row.presentationInstruction,
    columns: row.columns as CollectionColumn[],
    rowCount: counts.rowCount,
    gapCount: counts.gapCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toRow(row: CollectionRowRow): CollectionRow {
  return {
    id: row.id,
    collectionId: row.collectionId,
    keyValue: row.keyValue,
    values: row.values as Record<string, RowValue>,
    complete: row.complete,
    createdByUserRef: row.createdByUserRef,
    originChatRef: row.originChatRef,
    sourceDocumentRef: row.sourceDocumentRef,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Row and gap counts per collection, for the given ids. */
async function countsFor(
  db: StoreDb,
  ids: string[],
): Promise<Map<string, { rowCount: number; gapCount: number }>> {
  const counts = new Map<string, { rowCount: number; gapCount: number }>();
  if (ids.length === 0) return counts;
  const rows = await db
    .select({
      collectionId: collectionRows.collectionId,
      rowCount: sql<number>`count(*)::int`,
      gapCount: sql<number>`count(*) filter (where not ${collectionRows.complete})::int`,
    })
    .from(collectionRows)
    .where(inArray(collectionRows.collectionId, ids))
    .groupBy(collectionRows.collectionId);
  for (const row of rows) {
    counts.set(row.collectionId, { rowCount: row.rowCount, gapCount: row.gapCount });
  }
  return counts;
}

const NO_COUNTS = { rowCount: 0, gapCount: 0 };

/** Every collection, or those of the given assistants, oldest first, with counts. */
export async function listCollections(
  db: StoreDb,
  filter: { assistantIds?: string[] | null } = {},
): Promise<CollectionRecord[]> {
  if (filter.assistantIds && filter.assistantIds.length === 0) return [];
  const rows = await db
    .select()
    .from(collections)
    .where(filter.assistantIds ? inArray(collections.assistantId, filter.assistantIds) : undefined)
    .orderBy(asc(collections.createdAt), asc(collections.id));
  const counts = await countsFor(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => toCollection(row, counts.get(row.id) ?? NO_COUNTS));
}

/** One collection by id, with counts, or null. */
export async function getCollectionById(db: StoreDb, id: string): Promise<CollectionRecord | null> {
  const [row] = await db.select().from(collections).where(eq(collections.id, id)).limit(1);
  if (!row) return null;
  const counts = await countsFor(db, [id]);
  return toCollection(row, counts.get(id) ?? NO_COUNTS);
}

/** How many collections an assistant has. */
export async function countCollections(db: StoreDb, assistantId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(collections)
    .where(eq(collections.assistantId, assistantId));
  return row?.count ?? 0;
}

/** Whether an assistant already has a collection of this name (case-insensitively). */
export async function isCollectionNameTaken(
  db: StoreDb,
  assistantId: string,
  name: string,
  exceptId?: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: collections.id })
    .from(collections)
    .where(
      and(
        eq(collections.assistantId, assistantId),
        sql`lower(${collections.name}) = lower(${name})`,
        exceptId ? sql`${collections.id} <> ${exceptId}` : undefined,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export async function insertCollection(db: StoreDb, values: CollectionInsert): Promise<CollectionRecord> {
  const [row] = await db.insert(collections).values(values).returning();
  return toCollection(row, NO_COUNTS);
}

export async function updateCollection(
  db: StoreDb,
  id: string,
  values: Partial<Omit<CollectionInsert, "id" | "assistantId" | "createdAt">>,
): Promise<CollectionRecord | null> {
  const [row] = await db
    .update(collections)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(collections.id, id))
    .returning();
  if (!row) return null;
  const counts = await countsFor(db, [id]);
  return toCollection(row, counts.get(id) ?? NO_COUNTS);
}

export async function deleteCollection(db: StoreDb, id: string): Promise<boolean> {
  const rows = await db.delete(collections).where(eq(collections.id, id)).returning({ id: collections.id });
  return rows.length > 0;
}

// ---- rows --------------------------------------------------------------------

export async function getRowById(
  db: StoreDb,
  collectionId: string,
  id: string,
): Promise<CollectionRow | null> {
  const [row] = await db
    .select()
    .from(collectionRows)
    .where(and(eq(collectionRows.collectionId, collectionId), eq(collectionRows.id, id)))
    .limit(1);
  return row ? toRow(row) : null;
}

export async function getRowByKey(
  db: StoreDb,
  collectionId: string,
  keyValue: string,
): Promise<CollectionRow | null> {
  const [row] = await db
    .select()
    .from(collectionRows)
    .where(and(eq(collectionRows.collectionId, collectionId), eq(collectionRows.keyValue, keyValue)))
    .limit(1);
  return row ? toRow(row) : null;
}

/** The rows among the given keys that exist, by key. */
export async function getRowsByKeys(
  db: StoreDb,
  collectionId: string,
  keys: string[],
): Promise<Map<string, CollectionRow>> {
  const found = new Map<string, CollectionRow>();
  if (keys.length === 0) return found;
  const rows = await db
    .select()
    .from(collectionRows)
    .where(and(eq(collectionRows.collectionId, collectionId), inArray(collectionRows.keyValue, keys)));
  for (const row of rows) found.set(row.keyValue, toRow(row));
  return found;
}

export async function countRows(db: StoreDb, collectionId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(collectionRows)
    .where(eq(collectionRows.collectionId, collectionId));
  return row?.count ?? 0;
}

export interface RowWrite {
  id: string;
  collectionId: string;
  keyValue: string;
  values: Record<string, RowValue>;
  complete: boolean;
  embedding: number[] | null;
  createdByUserRef: string | null;
  originChatRef: string | null;
  sourceDocumentRef: string | null;
}

export async function insertRow(db: StoreDb, values: RowWrite): Promise<CollectionRow> {
  const [row] = await db.insert(collectionRows).values(values).returning();
  return toRow(row);
}

/** Insert many rows at once (an import's batch); returns how many landed. */
export async function insertRows(db: StoreDb, values: RowWrite[]): Promise<number> {
  if (values.length === 0) return 0;
  const rows = await db.insert(collectionRows).values(values).returning({ id: collectionRows.id });
  return rows.length;
}

export async function updateRow(
  db: StoreDb,
  id: string,
  values: {
    keyValue?: string;
    values: Record<string, RowValue>;
    complete: boolean;
    embedding?: number[] | null;
    sourceDocumentRef?: string | null;
  },
): Promise<CollectionRow | null> {
  const [row] = await db
    .update(collectionRows)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(collectionRows.id, id))
    .returning();
  return row ? toRow(row) : null;
}

export async function deleteRow(db: StoreDb, collectionId: string, id: string): Promise<boolean> {
  const rows = await db
    .delete(collectionRows)
    .where(and(eq(collectionRows.collectionId, collectionId), eq(collectionRows.id, id)))
    .returning({ id: collectionRows.id });
  return rows.length > 0;
}

/**
 * Re-derive every row of a collection against a changed column list:
 * removed columns' cells are dropped, added ones read as empty, and
 * `complete` is recomputed. Pages through the rows so a large collection
 * never sits in memory whole; embeddings are left as they are (the text
 * they came from is still mostly the row).
 */
export async function reshapeRows(
  db: StoreDb,
  collectionId: string,
  columns: readonly CollectionColumn[],
): Promise<number> {
  const PAGE = 500;
  let offset = 0;
  let touched = 0;
  for (;;) {
    const rows = await db
      .select({ id: collectionRows.id, values: collectionRows.values, complete: collectionRows.complete })
      .from(collectionRows)
      .where(eq(collectionRows.collectionId, collectionId))
      .orderBy(asc(collectionRows.createdAt), asc(collectionRows.id))
      .limit(PAGE)
      .offset(offset);
    for (const row of rows) {
      const stored = row.values as Record<string, RowValue>;
      const values: Record<string, RowValue> = {};
      for (const column of columns) values[column.key] = stored[column.key] ?? null;
      const complete = isComplete(columns, values);
      const same =
        complete === row.complete &&
        Object.keys(stored).length === columns.length &&
        columns.every((column) => column.key in stored);
      if (same) continue;
      await db
        .update(collectionRows)
        .set({ values, complete, updatedAt: new Date() })
        .where(eq(collectionRows.id, row.id));
      touched++;
    }
    if (rows.length < PAGE) break;
    offset += PAGE;
  }
  return touched;
}

// ---- queries -----------------------------------------------------------------

/** A filter resolved against its column — the service checks the column exists and the value fits. */
export interface ResolvedFilter extends RowFilter {
  columnType: CollectionColumn["type"];
}

export interface RowQuery {
  filters: ResolvedFilter[];
  /** Only rows that still have gaps. */
  gaps: boolean;
  /** Free text: a substring over every cell (the lexical half). */
  text: string | null;
  /** The text's embedding, when the semantic half is available. */
  vector: number[] | null;
  /** A column to sort by, with its type, or null for insertion order. */
  sort: { column: CollectionColumn; direction: "asc" | "desc" } | null;
  offset: number;
  limit: number;
}

const NUMERIC_TYPES = new Set(["number", "rating"]);

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** The JSONB cell of a column. */
function cell(key: string): SQL {
  return sql`${collectionRows.values} -> ${key}`;
}

/** The cell as text (null when empty). */
function cellText(key: string): SQL {
  return sql`${collectionRows.values} ->> ${key}`;
}

/** Whether a cell is empty: absent, JSON null, blank, or an empty list. */
function cellEmpty(key: string): SQL {
  return sql`(coalesce(${cell(key)}, 'null'::jsonb) = 'null'::jsonb or ${cellText(key)} = '' or ${cell(key)} = '[]'::jsonb)`;
}

function filterSql(filter: ResolvedFilter): SQL {
  const key = filter.column;
  const type = filter.columnType;
  const value = filter.value ?? null;
  switch (filter.op) {
    case "empty":
      return cellEmpty(key);
    case "not_empty":
      return sql`not ${cellEmpty(key)}`;
    case "eq":
    case "neq": {
      let test: SQL;
      if (NUMERIC_TYPES.has(type)) test = sql`(${cellText(key)})::numeric = ${Number(value)}`;
      else if (type === "boolean") test = sql`${cell(key)} = to_jsonb(${value === true || value === "true"}::boolean)`;
      else if (type === "list") test = sql`${cell(key)} @> jsonb_build_array(${String(value)}::text)`;
      else test = sql`lower(${cellText(key)}) = lower(${String(value)})`;
      return filter.op === "eq" ? test : sql`not coalesce(${test}, false)`;
    }
    case "contains": {
      const pattern = `%${escapeLike(String(value))}%`;
      if (type === "list") {
        return sql`exists (select 1 from jsonb_array_elements_text(coalesce(${cell(key)}, '[]'::jsonb)) as item where item ilike ${pattern})`;
      }
      return sql`${cellText(key)} ilike ${pattern}`;
    }
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const op = { gt: sql`>`, gte: sql`>=`, lt: sql`<`, lte: sql`<=` }[filter.op];
      if (NUMERIC_TYPES.has(type)) return sql`(${cellText(key)})::numeric ${op} ${Number(value)}`;
      if (type === "date") return sql`(${cellText(key)})::timestamptz ${op} (${String(value)})::timestamptz`;
      return sql`${cellText(key)} ${op} ${String(value)}`;
    }
  }
}

function sortSql(sort: NonNullable<RowQuery["sort"]>): SQL {
  const key = sort.column.key;
  const expr = NUMERIC_TYPES.has(sort.column.type)
    ? sql`(${cellText(key)})::numeric`
    : sort.column.type === "date"
      ? sql`(${cellText(key)})::timestamptz`
      : sort.column.type === "boolean"
        ? sql`(${cellText(key)})::boolean`
        : sql`lower(${cellText(key)})`;
  return sort.direction === "desc" ? sql`${expr} desc nulls last` : sql`${expr} asc nulls last`;
}

/**
 * One page of rows matching the query, with the total. A semantic query
 * (vector present) ranks by cosine distance and ignores the sort; a text
 * query without one is a substring match over the row's cells.
 */
export async function queryRows(
  db: StoreDb,
  collectionId: string,
  query: RowQuery,
): Promise<{ rows: CollectionRow[]; total: number }> {
  const conditions: (SQL | undefined)[] = [eq(collectionRows.collectionId, collectionId)];
  if (query.gaps) conditions.push(eq(collectionRows.complete, false));
  for (const filter of query.filters) conditions.push(filterSql(filter));
  if (query.text && !query.vector) {
    conditions.push(sql`${collectionRows.values}::text ilike ${`%${escapeLike(query.text)}%`}`);
  }
  const where = and(...conditions);
  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(collectionRows)
    .where(where);
  const order = query.vector
    ? [sql`${collectionRows.embedding} <=> ${JSON.stringify(query.vector)}::vector nulls last`, asc(collectionRows.id)]
    : query.sort
      ? [sortSql(query.sort), asc(collectionRows.id)]
      : [asc(collectionRows.createdAt), asc(collectionRows.id)];
  const rows = await db
    .select()
    .from(collectionRows)
    .where(where)
    .orderBy(...order)
    .limit(query.limit)
    .offset(query.offset);
  return { rows: rows.map(toRow), total: countRow?.count ?? 0 };
}

/** Rows that have no embedding yet, oldest first — for a backfill pass. */
export async function listRowsWithoutEmbedding(
  db: StoreDb,
  collectionId: string,
  limit: number,
): Promise<CollectionRow[]> {
  const rows = await db
    .select()
    .from(collectionRows)
    .where(and(eq(collectionRows.collectionId, collectionId), sql`${collectionRows.embedding} is null`))
    .orderBy(asc(collectionRows.createdAt), asc(collectionRows.id))
    .limit(limit);
  return rows.map(toRow);
}

export async function setRowEmbeddings(
  db: StoreDb,
  updates: { id: string; embedding: number[] }[],
): Promise<void> {
  for (const update of updates) {
    await db
      .update(collectionRows)
      .set({ embedding: update.embedding })
      .where(eq(collectionRows.id, update.id));
  }
}

/** Every row of a collection, in insertion order, for an export. */
export async function listAllRows(db: StoreDb, collectionId: string): Promise<CollectionRow[]> {
  const rows = await db
    .select()
    .from(collectionRows)
    .where(eq(collectionRows.collectionId, collectionId))
    .orderBy(asc(collectionRows.createdAt), asc(collectionRows.id));
  return rows.map(toRow);
}

/** Whether a value counts as empty, re-exported for the service's convenience. */
export { isEmptyValue };
