import "server-only";

import { randomUUID } from "node:crypto";

import { getAssistantById } from "@/features/assistants/server/repository";
import { getEmbeddingRuntime } from "@/features/settings/server/service";
import { ApiError } from "@/lib/api-error";
import { FEATURES } from "@/lib/features";
import type { TraceTrigger } from "@/lib/trace";
import { embed, type EmbeddingRuntime } from "@/server/llm/embeddings";
import { publishEvent } from "@/server/realtime/hub";
import { getStoreDb, type StoreDb } from "@/server/store/db";
import { withTrace, type TraceRecorder } from "@/server/trace";

import {
  checkColumns,
  gapsOf,
  isComplete,
  isEmptyValue,
  keyColumnOf,
  keyValueOf,
  normalizeValue,
  normalizeValues,
  renderRowForEmbedding,
  renderValue,
} from "../columns";
import { summarizeCollection } from "../format";
import {
  MAX_COLLECTIONS_PER_ASSISTANT,
  MAX_IMPORT_SKIPS_REPORTED,
  MAX_ROWS_PER_COLLECTION,
  type Collection,
  type CollectionColumn,
  type CollectionRow,
  type ImportReport,
  type RowPage,
  type RowValue,
} from "../types";
import { readImportTable, resolveMapping } from "./import";
import * as repository from "./repository";
import type { ResolvedFilter } from "./repository";
import type {
  CreateCollectionInput,
  ImportInput,
  QueryRowsInput,
  UpdateCollectionInput,
} from "./schema";

/**
 * Collections domain service — the boundary the Route Handlers, the
 * dashboard, the prompt composers and the MCP tools call. Owns the rules
 * the store cannot: who may see and write a collection, what a column list
 * and a row may say (`columns.ts`), identity by key (a write with an
 * existing key updates), completeness, the caps, embeddings for the
 * semantic half of a query, and trace recording for every mutation.
 *
 * Two kinds of caller, told apart by {@link CollectionAccess}:
 *
 *  - **dashboard** — a Route Handler that already scoped the caller to its
 *    own assistants through the ownership helpers; sees everything of
 *    those assistants and may write.
 *  - **chat** — a tool call in a turn of one assistant: sees that
 *    assistant's collections, the private ones only with owner rights
 *    (`sender.isOwner`, or rights a standing task lent), and writes only
 *    with owner rights (user decisions, 2026-09-08). A collection the turn
 *    may not see reads as unknown, never as forbidden.
 */

const FEATURE = FEATURES.collections;

export type CollectionAccess =
  | { kind: "dashboard" }
  | { kind: "chat"; assistantId: string; ownerRights: boolean };

/** Who wrote a row, and from where — recorded on the row for provenance. */
export interface RowProvenance {
  createdByUserRef: string | null;
  originChatRef: string | null;
}

const NO_PROVENANCE: RowProvenance = { createdByUserRef: null, originChatRef: null };

const NOT_FOUND = "Unknown collection";
const WRITE_DENIED =
  "Only the assistant's owner can change its collections — this sender does not hold owner rights.";

function assertVisible(collection: Collection, access: CollectionAccess): Collection {
  if (access.kind === "dashboard") return collection;
  if (collection.assistantId !== access.assistantId) throw ApiError.notFound(NOT_FOUND);
  if (collection.visibility === "private" && !access.ownerRights) throw ApiError.notFound(NOT_FOUND);
  return collection;
}

function assertWritable(collection: Collection, access: CollectionAccess): Collection {
  assertVisible(collection, access);
  if (access.kind === "chat" && !access.ownerRights) throw ApiError.forbidden(WRITE_DENIED);
  return collection;
}

/** A readable collection by id, per the caller's access, or a not-found error. */
export async function getReadableCollection(
  id: string,
  access: CollectionAccess,
  db: StoreDb = getStoreDb(),
): Promise<Collection> {
  const collection = await repository.getCollectionById(db, id);
  if (!collection) throw ApiError.notFound(NOT_FOUND);
  return assertVisible(collection, access);
}

async function getWritableCollection(id: string, access: CollectionAccess, db: StoreDb): Promise<Collection> {
  return assertWritable(await getReadableCollection(id, access, db), access);
}

/** The dashboard's view: every collection, or those of the given assistants. */
export async function getCollectionsView(
  filter: { assistantIds?: string[] | null } = {},
  db: StoreDb = getStoreDb(),
): Promise<Collection[]> {
  return repository.listCollections(db, filter);
}

/** One collection for the dashboard, or null. */
export async function getCollection(id: string, db: StoreDb = getStoreDb()): Promise<Collection | null> {
  return repository.getCollectionById(db, id);
}

/**
 * The collections a chat turn sees: the assistant's, private ones only
 * with owner rights. What the prompt block lists and the tools act on.
 */
export async function getVisibleCollections(
  access: Extract<CollectionAccess, { kind: "chat" }>,
  db: StoreDb = getStoreDb(),
): Promise<Collection[]> {
  const all = await repository.listCollections(db, { assistantIds: [access.assistantId] });
  return all.filter((collection) => access.ownerRights || collection.visibility === "shared");
}

/** Whether an assistant has any collection — what decides if the row tools are offered. */
export async function assistantHasCollections(
  assistantId: string,
  db: StoreDb = getStoreDb(),
): Promise<boolean> {
  return (await repository.countCollections(db, assistantId)) > 0;
}

// ---- embeddings ----------------------------------------------------------------

/**
 * Embed rows, best-effort: no configured model or a failing endpoint means
 * no vectors — the lexical half of search still works, and the row is
 * stored either way. A write is never refused for want of an embedding.
 */
async function embedRows(
  runtime: EmbeddingRuntime | null,
  columns: readonly CollectionColumn[],
  rows: readonly Record<string, RowValue>[],
): Promise<(number[] | null)[]> {
  if (!runtime || rows.length === 0) return rows.map(() => null);
  const texts = rows.map((values) => renderRowForEmbedding(columns, values));
  try {
    const vectors = await embed(runtime, texts.map((text) => text || "(empty)"));
    return vectors;
  } catch {
    return rows.map(() => null);
  }
}

async function embeddingRuntimeOrNull(db: StoreDb): Promise<EmbeddingRuntime | null> {
  return getEmbeddingRuntime(db).catch(() => null);
}

// ---- collections -----------------------------------------------------------------

function assistantIdOf(access: CollectionAccess, input: { assistantId?: string }): string {
  if (access.kind === "chat") return access.assistantId;
  if (!input.assistantId) throw ApiError.badRequest("An assistant is required");
  return input.assistantId;
}

async function checkCollectionName(db: StoreDb, assistantId: string, name: string, exceptId?: string) {
  if (await repository.isCollectionNameTaken(db, assistantId, name, exceptId)) {
    throw ApiError.conflict(`This assistant already has a collection named "${name}"`);
  }
}

function columnsOrThrow(input: unknown): CollectionColumn[] {
  const checked = checkColumns(input);
  if (!checked.ok) throw ApiError.badRequest(`Columns: ${checked.reason}`);
  return checked.value;
}

/** The untraced core of a create, shared with the import (which traces on its own). */
async function createCollectionCore(
  db: StoreDb,
  assistantId: string,
  input: Omit<CreateCollectionInput, "assistantId">,
): Promise<Collection> {
  if (!(await getAssistantById(db, assistantId))) throw ApiError.badRequest("Unknown assistant");
  const columns = columnsOrThrow(input.columns);
  await checkCollectionName(db, assistantId, input.name);
  if ((await repository.countCollections(db, assistantId)) >= MAX_COLLECTIONS_PER_ASSISTANT) {
    throw ApiError.badRequest(
      `This assistant already has ${MAX_COLLECTIONS_PER_ASSISTANT} collections — delete one before creating another`,
    );
  }
  return repository.insertCollection(db, {
    id: randomUUID(),
    assistantId,
    name: input.name,
    description: input.description ?? "",
    visibility: input.visibility ?? "private",
    fillInstruction: input.fillInstruction ?? "",
    presentationInstruction: input.presentationInstruction ?? "",
    columns,
  });
}

/** Create a collection, gated and traced. */
export async function createCollectionService(
  input: CreateCollectionInput | (Omit<CreateCollectionInput, "assistantId"> & { assistantId?: string }),
  access: CollectionAccess,
  trigger: TraceTrigger,
  db: StoreDb = getStoreDb(),
): Promise<Collection> {
  const assistantId = assistantIdOf(access, input);
  if (access.kind === "chat" && !access.ownerRights) throw ApiError.forbidden(WRITE_DENIED);
  return withTrace(
    {
      feature: FEATURE.id,
      action: "create",
      assistantId,
      trigger,
      inputSummary: `${input.name}: ${input.columns.length} columns`,
    },
    async (trace) => {
      await trace.event({ type: "input", message: "create collection", data: { ...input, assistantId } });
      const record = await createCollectionCore(db, assistantId, input);
      await trace.succeed({
        outputSummary: summarizeCollection(record),
        relatedIds: { [FEATURE.relatedIdsKey]: [record.id] },
      });
      publishEvent(FEATURE.realtimeTopic);
      return record;
    },
  );
}

/**
 * Change a collection's name, texts, visibility or columns. A column change
 * reshapes every row (dropped columns lose their cells, `complete` is
 * re-derived); the key column may change only while the collection is
 * empty, because the rows' identities are the old key's values.
 */
export async function editCollectionService(
  id: string,
  input: UpdateCollectionInput,
  access: CollectionAccess,
  trigger: TraceTrigger,
  db: StoreDb = getStoreDb(),
): Promise<Collection> {
  const current = await getWritableCollection(id, access, db);
  return withTrace(
    {
      feature: FEATURE.id,
      action: "update",
      assistantId: current.assistantId,
      trigger,
      inputSummary: `${current.name}: ${Object.keys(input).join(", ")}`,
    },
    async (trace) => {
      trace.relate(FEATURE.relatedIdsKey, [id]);
      await trace.event({ type: "input", message: "update collection", data: input });
      const patch: Parameters<typeof repository.updateCollection>[2] = {};
      if (input.name !== undefined && input.name !== current.name) {
        await checkCollectionName(db, current.assistantId, input.name, id);
        patch.name = input.name;
      }
      if (input.description !== undefined) patch.description = input.description;
      if (input.visibility !== undefined) patch.visibility = input.visibility;
      if (input.fillInstruction !== undefined) patch.fillInstruction = input.fillInstruction;
      if (input.presentationInstruction !== undefined) patch.presentationInstruction = input.presentationInstruction;
      let reshaped = 0;
      if (input.columns !== undefined) {
        const columns = columnsOrThrow(input.columns);
        const oldKey = keyColumnOf(current.columns).key;
        const newKey = keyColumnOf(columns).key;
        if (oldKey !== newKey && current.rowCount > 0) {
          throw ApiError.badRequest(
            `The key column cannot change while the collection has rows (it is "${oldKey}"); empty it first`,
          );
        }
        patch.columns = columns;
        reshaped = await repository.reshapeRows(db, id, columns);
      }
      const record = await repository.updateCollection(db, id, patch);
      if (!record) throw ApiError.notFound(NOT_FOUND);
      await trace.event({
        type: "step",
        message: "collection updated",
        data: { changed: Object.keys(patch), rowsReshaped: reshaped },
      });
      await trace.succeed({ outputSummary: summarizeCollection(record) });
      publishEvent(FEATURE.realtimeTopic);
      return record;
    },
  );
}

/** Delete a collection and every row in it. */
export async function removeCollectionService(
  id: string,
  access: CollectionAccess,
  trigger: TraceTrigger,
  db: StoreDb = getStoreDb(),
): Promise<void> {
  const current = await getWritableCollection(id, access, db);
  await withTrace(
    {
      feature: FEATURE.id,
      action: "delete",
      assistantId: current.assistantId,
      trigger,
      inputSummary: summarizeCollection(current),
    },
    async (trace) => {
      trace.relate(FEATURE.relatedIdsKey, [id]);
      if (!(await repository.deleteCollection(db, id))) throw ApiError.notFound(NOT_FOUND);
      await trace.succeed({ outputSummary: `deleted ${current.name} with ${current.rowCount} rows` });
      publishEvent(FEATURE.realtimeTopic);
    },
  );
}

// ---- rows --------------------------------------------------------------------------

/** How a row is named by a caller: by its id, or by its key value. */
export type RowRef = { id: string } | { key: string };

async function findRow(db: StoreDb, collectionId: string, ref: RowRef): Promise<CollectionRow | null> {
  return "id" in ref
    ? repository.getRowById(db, collectionId, ref.id)
    : repository.getRowByKey(db, collectionId, ref.key.trim());
}

/** A row with what it still lacks, the shape every read returns. */
export interface RowWithGaps extends CollectionRow {
  gaps: string[];
}

function withGaps(columns: readonly CollectionColumn[], row: CollectionRow): RowWithGaps {
  return { ...row, gaps: gapsOf(columns, row.values) };
}

/** One row by id or key, or a not-found error. */
export async function getRowService(
  collectionId: string,
  ref: RowRef,
  access: CollectionAccess,
  db: StoreDb = getStoreDb(),
): Promise<RowWithGaps> {
  const collection = await getReadableCollection(collectionId, access, db);
  const row = await findRow(db, collectionId, ref);
  if (!row) throw ApiError.notFound("id" in ref ? "Unknown row" : `No row with key "${ref.key}"`);
  return withGaps(collection.columns, row);
}

async function assertRoomForRows(db: StoreDb, collection: Collection, adding: number) {
  const count = await repository.countRows(db, collection.id);
  if (count + adding > MAX_ROWS_PER_COLLECTION) {
    throw ApiError.badRequest(
      `${collection.name} would exceed ${MAX_ROWS_PER_COLLECTION} rows (it has ${count}; ${adding} more requested)`,
    );
  }
}

/**
 * Add a row — or, when its key already exists, update that row with the
 * given values (identity by key: user decision, 2026-09-08). Every column
 * is checked against its type; an unknown column or a bad value refuses
 * the whole write with the column named.
 */
export async function addRowService(
  collectionId: string,
  input: Record<string, unknown>,
  options: { access: CollectionAccess; provenance?: RowProvenance; trigger: TraceTrigger },
  db: StoreDb = getStoreDb(),
): Promise<{ row: RowWithGaps; created: boolean }> {
  const collection = await getWritableCollection(collectionId, options.access, db);
  const normalized = normalizeValues(collection.columns, input, { partial: false });
  if (!normalized.ok) throw ApiError.badRequest(normalized.reason);
  const key = keyValueOf(collection.columns, normalized.value);
  if (!key.ok) throw ApiError.badRequest(key.reason);
  return withTrace(
    {
      feature: FEATURE.id,
      action: "row-add",
      assistantId: collection.assistantId,
      trigger: options.trigger,
      inputSummary: `${collection.name}: ${key.value}`,
    },
    async (trace) => {
      trace.relate(FEATURE.relatedIdsKey, [collectionId]);
      await trace.event({ type: "input", message: "add row", data: { values: input } });
      const existing = await repository.getRowByKey(db, collectionId, key.value);
      const runtime = await embeddingRuntimeOrNull(db);
      if (existing) {
        // Given values win; an absent one keeps what the row had.
        const given = input as Record<string, unknown>;
        const values: Record<string, RowValue> = { ...existing.values };
        for (const column of collection.columns) {
          if (column.key in given) values[column.key] = normalized.value[column.key];
        }
        const [embedding] = await embedRows(runtime, collection.columns, [values]);
        const row = await repository.updateRow(db, existing.id, {
          values,
          complete: isComplete(collection.columns, values),
          embedding,
        });
        if (!row) throw ApiError.notFound("Unknown row");
        await trace.succeed({ outputSummary: `updated existing row ${key.value}` });
        publishEvent(FEATURE.realtimeTopic);
        return { row: withGaps(collection.columns, row), created: false };
      }
      await assertRoomForRows(db, collection, 1);
      const [embedding] = await embedRows(runtime, collection.columns, [normalized.value]);
      const provenance = options.provenance ?? NO_PROVENANCE;
      const row = await repository.insertRow(db, {
        id: randomUUID(),
        collectionId,
        keyValue: key.value,
        values: normalized.value,
        complete: isComplete(collection.columns, normalized.value),
        embedding,
        createdByUserRef: provenance.createdByUserRef,
        originChatRef: provenance.originChatRef,
        sourceDocumentRef: null,
      });
      await trace.succeed({ outputSummary: `added row ${key.value}` });
      publishEvent(FEATURE.realtimeTopic);
      return { row: withGaps(collection.columns, row), created: true };
    },
  );
}

/** Update some columns of one row (by id or key). The key column may change to a free key. */
export async function editRowService(
  collectionId: string,
  ref: RowRef,
  input: Record<string, unknown>,
  options: { access: CollectionAccess; trigger: TraceTrigger },
  db: StoreDb = getStoreDb(),
): Promise<RowWithGaps> {
  const collection = await getWritableCollection(collectionId, options.access, db);
  const existing = await findRow(db, collectionId, ref);
  if (!existing) throw ApiError.notFound("id" in ref ? "Unknown row" : `No row with key "${ref.key}"`);
  const normalized = normalizeValues(collection.columns, input, { partial: true });
  if (!normalized.ok) throw ApiError.badRequest(normalized.reason);
  const values: Record<string, RowValue> = { ...existing.values, ...normalized.value };
  const key = keyValueOf(collection.columns, values);
  if (!key.ok) throw ApiError.badRequest(key.reason);
  return withTrace(
    {
      feature: FEATURE.id,
      action: "row-update",
      assistantId: collection.assistantId,
      trigger: options.trigger,
      inputSummary: `${collection.name}: ${existing.keyValue}`,
    },
    async (trace) => {
      trace.relate(FEATURE.relatedIdsKey, [collectionId]);
      await trace.event({ type: "input", message: "update row", data: { ref, values: input } });
      if (key.value !== existing.keyValue) {
        const clash = await repository.getRowByKey(db, collectionId, key.value);
        if (clash) throw ApiError.conflict(`Another row already has the key "${key.value}"`);
      }
      const runtime = await embeddingRuntimeOrNull(db);
      const [embedding] = await embedRows(runtime, collection.columns, [values]);
      const row = await repository.updateRow(db, existing.id, {
        keyValue: key.value,
        values,
        complete: isComplete(collection.columns, values),
        embedding,
      });
      if (!row) throw ApiError.notFound("Unknown row");
      await trace.succeed({
        outputSummary: `updated ${Object.keys(normalized.value).join(", ")} of ${key.value}`,
      });
      publishEvent(FEATURE.realtimeTopic);
      return withGaps(collection.columns, row);
    },
  );
}

/** Delete one row (by id or key). */
export async function removeRowService(
  collectionId: string,
  ref: RowRef,
  options: { access: CollectionAccess; trigger: TraceTrigger },
  db: StoreDb = getStoreDb(),
): Promise<void> {
  const collection = await getWritableCollection(collectionId, options.access, db);
  const existing = await findRow(db, collectionId, ref);
  if (!existing) throw ApiError.notFound("id" in ref ? "Unknown row" : `No row with key "${ref.key}"`);
  await withTrace(
    {
      feature: FEATURE.id,
      action: "row-delete",
      assistantId: collection.assistantId,
      trigger: options.trigger,
      inputSummary: `${collection.name}: ${existing.keyValue}`,
    },
    async (trace) => {
      trace.relate(FEATURE.relatedIdsKey, [collectionId]);
      await repository.deleteRow(db, collectionId, existing.id);
      await trace.succeed({ outputSummary: `deleted row ${existing.keyValue}` });
      publishEvent(FEATURE.realtimeTopic);
    },
  );
}

/** Resolve a query's filters and sort against the columns, refusing what does not fit. */
function resolveQuery(
  collection: Collection,
  input: QueryRowsInput,
): { filters: ResolvedFilter[]; sort: { column: CollectionColumn; direction: "asc" | "desc" } | null } {
  const byKey = new Map(collection.columns.map((column) => [column.key, column]));
  const filters: ResolvedFilter[] = [];
  for (const filter of input.filters) {
    const column = byKey.get(filter.column);
    if (!column) {
      throw ApiError.badRequest(
        `"${filter.column}" is not a column of ${collection.name} (columns: ${[...byKey.keys()].join(", ")})`,
      );
    }
    const needsValue = filter.op !== "empty" && filter.op !== "not_empty";
    if (needsValue && isEmptyValue(filter.value)) {
      throw ApiError.badRequest(`Filter on "${filter.column}" (${filter.op}) needs a value`);
    }
    let value = filter.value;
    if (needsValue && (filter.op === "eq" || filter.op === "neq")) {
      // An equality test speaks the column's own values — a misspelt enum
      // option or a non-number is an error now, not an empty page.
      const checked = normalizeValue(column, filter.value);
      if (!checked.ok) throw ApiError.badRequest(checked.reason);
      value = Array.isArray(checked.value) ? checked.value[0] : checked.value;
    }
    filters.push({ ...filter, value, columnType: column.type });
  }
  let sort: { column: CollectionColumn; direction: "asc" | "desc" } | null = null;
  if (input.sort) {
    const column = byKey.get(input.sort);
    if (!column) throw ApiError.badRequest(`Cannot sort by "${input.sort}": not a column of ${collection.name}`);
    sort = { column, direction: input.direction };
  }
  return { filters, sort };
}

/**
 * A page of rows: structured filters, the gaps switch, a sort, and a free
 * text that is semantic when an embedding model is configured (the text is
 * embedded and rows are ranked by cosine distance, filters still applied)
 * and a substring match over the cells otherwise.
 */
export async function queryRowsService(
  collectionId: string,
  input: QueryRowsInput,
  access: CollectionAccess,
  db: StoreDb = getStoreDb(),
): Promise<RowPage & { rows: RowWithGaps[] }> {
  const collection = await getReadableCollection(collectionId, access, db);
  const { filters, sort } = resolveQuery(collection, input);
  const text = input.query?.trim() || null;
  let vector: number[] | null = null;
  if (text) {
    const runtime = await embeddingRuntimeOrNull(db);
    if (runtime) {
      try {
        [vector] = await embed(runtime, [text]);
      } catch {
        vector = null;
      }
    }
  }
  const page = await repository.queryRows(db, collectionId, {
    filters,
    gaps: input.gaps,
    text,
    vector,
    sort,
    offset: input.offset,
    limit: input.limit,
  });
  return {
    rows: page.rows.map((row) => withGaps(collection.columns, row)),
    offset: input.offset,
    limit: input.limit,
    total: page.total,
    hasMore: input.offset + page.rows.length < page.total,
    semantic: vector !== null,
  };
}

// ---- import ------------------------------------------------------------------------

/** A document as the import reads it — resolved by the caller, who checks it is theirs. */
export interface ImportSource {
  /** Scoped ref of the document, recorded on every row it wrote. */
  ref: string;
  label: string;
  bytes: Buffer;
  format: Parameters<typeof readImportTable>[1];
}

/**
 * Import a document's records into a collection — an existing one, or one
 * created now from a confirmed proposal (the one confirmation: user
 * decision, 2026-09-08). Records map onto columns by an explicit mapping
 * or by header name; every value is checked like any other write; a record
 * that fails is skipped with its reason, never silently coerced. A record
 * whose key exists updates that row (non-empty cells win). Embeddings are
 * computed per batch, best-effort.
 */
export async function importRowsService(
  input: Omit<ImportInput, "documentId">,
  source: ImportSource,
  options: { access: CollectionAccess; provenance?: RowProvenance; trigger: TraceTrigger },
  db: StoreDb = getStoreDb(),
): Promise<ImportReport> {
  const { access } = options;
  if (access.kind === "chat" && !access.ownerRights) throw ApiError.forbidden(WRITE_DENIED);
  const target = input.collectionId
    ? await getWritableCollection(input.collectionId, access, db)
    : null;
  const assistantId = target?.assistantId ?? (access.kind === "chat" ? access.assistantId : null);
  if (!assistantId) throw ApiError.badRequest("An assistant is required");
  return withTrace(
    {
      feature: FEATURE.id,
      action: "import",
      assistantId,
      trigger: options.trigger,
      inputSummary: `${source.label} -> ${target?.name ?? input.proposal?.name ?? "?"}`,
    },
    async (trace) => {
      await trace.event({
        type: "input",
        message: "import document",
        data: { document: source.ref, collectionId: input.collectionId, proposal: input.proposal, mapping: input.mapping, sheet: input.sheet },
      });
      let table;
      try {
        table = readImportTable(source.bytes, source.format, { sheet: input.sheet });
      } catch (err) {
        throw ApiError.badRequest(
          `${source.label} could not be read: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const collection = target ?? (await createCollectionCore(db, assistantId, input.proposal!));
      if (!target) trace.relate(FEATURE.relatedIdsKey, [collection.id]);
      else trace.relate(FEATURE.relatedIdsKey, [collection.id]);
      const mapping = resolveMapping(collection.columns, table.headers, input.mapping);
      if (mapping.unknown.length > 0) {
        throw ApiError.badRequest(
          `The mapping names file columns that do not exist: ${mapping.unknown.join(", ")} (the file has: ${table.headers.join(", ")})`,
        );
      }
      const keyColumn = keyColumnOf(collection.columns);
      if (!mapping.byColumn.has(keyColumn.key)) {
        throw ApiError.badRequest(
          `No file column maps onto the key column "${keyColumn.key}" (the file has: ${table.headers.join(", ")})`,
        );
      }
      await trace.event({
        type: "step",
        message: "records read",
        data: {
          sheet: table.sheet,
          sheets: table.sheets,
          headers: table.headers,
          records: table.records.length,
          mapping: Object.fromEntries(mapping.byColumn),
          unmappedColumns: mapping.unmapped,
        },
      });
      const report = await writeRecords(db, trace, collection, table.records, mapping.byColumn, source, options.provenance ?? NO_PROVENANCE);
      await trace.succeed({
        outputSummary: `${report.inserted} added, ${report.updated} updated, ${report.skipped.length} skipped of ${report.total}`,
      });
      publishEvent(FEATURE.realtimeTopic);
      return report;
    },
  );
}

const IMPORT_BATCH = 200;

async function writeRecords(
  db: StoreDb,
  trace: TraceRecorder,
  collection: Collection,
  records: Record<string, string>[],
  byColumn: Map<string, string>,
  source: ImportSource,
  provenance: RowProvenance,
): Promise<ImportReport> {
  const report: ImportReport = {
    collectionId: collection.id,
    inserted: 0,
    updated: 0,
    skipped: [],
    total: records.length,
  };
  let skippedCount = 0;
  const skip = (row: number, reason: string) => {
    skippedCount++;
    if (report.skipped.length < MAX_IMPORT_SKIPS_REPORTED) report.skipped.push({ row, reason });
  };
  // Normalize everything first (cheap, no I/O), keyed so a repeat within the
  // file merges into one write — the later record's cells win.
  const prepared = new Map<string, { row: number; values: Record<string, RowValue> }>();
  for (const [index, record] of records.entries()) {
    const raw: Record<string, unknown> = {};
    for (const [key, header] of byColumn) raw[key] = record[header] ?? "";
    const normalized = normalizeValues(collection.columns, raw, { partial: false });
    if (!normalized.ok) {
      skip(index + 1, normalized.reason);
      continue;
    }
    const key = keyValueOf(collection.columns, normalized.value);
    if (!key.ok) {
      skip(index + 1, key.reason);
      continue;
    }
    const earlier = prepared.get(key.value);
    if (earlier) {
      for (const column of collection.columns) {
        if (!isEmptyValue(normalized.value[column.key])) earlier.values[column.key] = normalized.value[column.key];
      }
      continue;
    }
    prepared.set(key.value, { row: index + 1, values: normalized.value });
  }
  const runtime = await embeddingRuntimeOrNull(db);
  const entries = [...prepared.entries()];
  const existingCount = await repository.countRows(db, collection.id);
  let room = MAX_ROWS_PER_COLLECTION - existingCount;
  for (let start = 0; start < entries.length; start += IMPORT_BATCH) {
    const batch = entries.slice(start, start + IMPORT_BATCH);
    const existing = await repository.getRowsByKeys(
      db,
      collection.id,
      batch.map(([key]) => key),
    );
    const inserts: repository.RowWrite[] = [];
    const updates: { id: string; values: Record<string, RowValue> }[] = [];
    for (const [key, { row, values }] of batch) {
      const found = existing.get(key);
      if (found) {
        const merged: Record<string, RowValue> = { ...found.values };
        for (const column of collection.columns) {
          if (!isEmptyValue(values[column.key])) merged[column.key] = values[column.key];
        }
        updates.push({ id: found.id, values: merged });
        continue;
      }
      if (room <= 0) {
        skip(row, `the collection is at its ${MAX_ROWS_PER_COLLECTION}-row cap`);
        continue;
      }
      room--;
      inserts.push({
        id: randomUUID(),
        collectionId: collection.id,
        keyValue: key,
        values,
        complete: isComplete(collection.columns, values),
        embedding: null,
        createdByUserRef: provenance.createdByUserRef,
        originChatRef: provenance.originChatRef,
        sourceDocumentRef: source.ref,
      });
    }
    const vectors = await embedRows(runtime, collection.columns, [
      ...inserts.map((insert) => insert.values),
      ...updates.map((update) => update.values),
    ]);
    inserts.forEach((insert, i) => {
      insert.embedding = vectors[i];
    });
    report.inserted += await repository.insertRows(db, inserts);
    for (const [i, update] of updates.entries()) {
      await repository.updateRow(db, update.id, {
        values: update.values,
        complete: isComplete(collection.columns, update.values),
        embedding: vectors[inserts.length + i],
        sourceDocumentRef: source.ref,
      });
      report.updated++;
    }
    await trace.event({
      type: "step",
      message: `batch ${Math.floor(start / IMPORT_BATCH) + 1} written`,
      data: { inserted: inserts.length, updated: updates.length, embedded: vectors.filter(Boolean).length },
    });
  }
  if (skippedCount > report.skipped.length) {
    await trace.event({
      type: "step",
      level: "warn",
      message: `${skippedCount} records skipped (${report.skipped.length} listed)`,
    });
  }
  return report;
}

// ---- export ------------------------------------------------------------------------

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** The whole collection as CSV — a header of column keys, one line per row. */
export async function exportCollectionCsv(
  id: string,
  access: CollectionAccess,
  db: StoreDb = getStoreDb(),
): Promise<{ collection: Collection; csv: string }> {
  const collection = await getReadableCollection(id, access, db);
  const rows = await repository.listAllRows(db, id);
  const lines = [collection.columns.map((column) => csvCell(column.key)).join(",")];
  for (const row of rows) {
    lines.push(collection.columns.map((column) => csvCell(renderValue(row.values[column.key] ?? null))).join(","));
  }
  return { collection, csv: lines.join("\r\n") + "\r\n" };
}
