import "server-only";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { scopedRef } from "@assistants-swarm-hub/contracts";
import { z } from "zod";

import { getDocument } from "@/features/documents/server/service";
import { ApiError } from "@/lib/api-error";
import { getToolContext, toolContextTrigger, type McpToolContext } from "@/server/mcp/context";
import type { ToolOfferScope } from "@/server/mcp/registry";
import type { StoreDb } from "@/server/store/db";

import { ratingScale, renderValue } from "../columns";
import { summarizeCollection } from "../format";
import {
  COLUMN_TYPES,
  MAX_COLLECTIONS_PER_ASSISTANT,
  MAX_COLUMNS,
  MAX_QUERY_PAGE,
  type Collection,
  type CollectionColumn,
} from "../types";
import {
  addRowService,
  assistantHasCollections,
  createCollectionService,
  editCollectionService,
  editRowService,
  getRowService,
  importRowsService,
  queryRowsService,
  removeCollectionService,
  removeRowService,
  type CollectionAccess,
  type RowProvenance,
  type RowRef,
  type RowWithGaps,
} from "./service";

/**
 * The collections toolkit, exposed as MCP tools: how an assistant keeps
 * structured data — a watchlist, a reading list, expenses — in typed
 * columns it proposed and code enforces (user decisions, 2026-09-08).
 *
 * The turn's assistant is bound in the tool context, so a tool only ever
 * reaches that assistant's collections. Rights are judged **inside** the
 * service: a private collection is invisible without owner rights, and
 * every write needs them (`sender.isOwner`, or rights a standing task
 * lent). A refusal is a plain tool error the model relays.
 *
 * Offered only to an assistant that has at least one collection — the
 * prompt block that names them is what makes the ids usable — except
 * `collections_create`, offered always, because the first collection has
 * to come from somewhere (user decision, 2026-09-08).
 */

export const COLLECTIONS_CREATE_TOOL = "collections_create";
export const COLLECTIONS_UPDATE_TOOL = "collections_update";
export const COLLECTIONS_DELETE_TOOL = "collections_delete";
export const COLLECTION_IMPORT_TOOL = "collection_import";
export const ROWS_ADD_TOOL = "rows_add";
export const ROWS_UPDATE_TOOL = "rows_update";
export const ROWS_DELETE_TOOL = "rows_delete";
export const ROWS_GET_TOOL = "rows_get";
export const ROWS_QUERY_TOOL = "rows_query";

export const COLLECTIONS_TOOL_NAMES = [
  COLLECTIONS_CREATE_TOOL,
  COLLECTIONS_UPDATE_TOOL,
  COLLECTIONS_DELETE_TOOL,
  COLLECTION_IMPORT_TOOL,
  ROWS_ADD_TOOL,
  ROWS_UPDATE_TOOL,
  ROWS_DELETE_TOOL,
  ROWS_GET_TOOL,
  ROWS_QUERY_TOOL,
];

/** The offer rule: the create tool always, the rest once the assistant has a collection. */
export function collectionsToolOffered(toolName: string, scope: ToolOfferScope): boolean {
  if (toolName === COLLECTIONS_CREATE_TOOL) return true;
  return scope.assistantHasCollections === true;
}

/** The scope fact the offer rule reads, resolved once per toolset. */
export async function collectionsScopeFacts(
  scope: ToolOfferScope,
  db?: StoreDb,
): Promise<Partial<ToolOfferScope>> {
  if (!scope.assistantId) return { assistantHasCollections: false };
  const has = await assistantHasCollections(scope.assistantId, db).catch(() => false);
  return { assistantHasCollections: has };
}

const NO_ASSISTANT = "This turn has no assistant to act as, so it has no collections. Nothing was done.";

const COLUMN_TYPE_HELP =
  "Column types: text (short), long_text, number, date (YYYY-MM-DD), url, image (an image URL, shown " +
  "as a picture), list (several short texts), enum (one of fixed 'options'), rating (0 to 'scale', " +
  "default 10), boolean. Exactly ONE column is the key (is_key) — the value that identifies an item, " +
  "such as the site's id or the URL — so writing an item that already exists updates it instead of " +
  "duplicating it. Mark with required_for_complete the columns an item must have before it counts as " +
  "complete: that is what 'gaps' means, and what a fill-the-gaps job works through.";

export const COLLECTIONS_CREATE_DESCRIPTION =
  "Create a new collection: a table of typed columns for structured data this assistant keeps — a " +
  "watchlist, a reading list, recipes, expenses, anything with repeating items. Propose the columns " +
  "FROM THE DATA you were shown (a file's header, the items described) and confirm the proposal with " +
  "the person in plain words BEFORE calling this — name, columns with types, which column is the key, " +
  "which are needed for an item to be complete. Only the assistant's owner may create one. " +
  COLUMN_TYPE_HELP +
  " Give 'fill_instruction' when the person says how missing data should be found (which site, what to " +
  "look for) and 'presentation_instruction' when they say how an item should be shown in chat.";

const COLLECTIONS_UPDATE_DESCRIPTION =
  "Change a collection: its name, description, visibility (private = only the owner sees it; shared " +
  "= everyone in a chat with you may read it), the fill or presentation instruction, or its columns. " +
  "Passing 'columns' REPLACES the whole column list: include every column that should remain, with " +
  "its current key and type; a column left out loses its values in every row. The key column cannot " +
  "change while the collection has rows. Owner only. " +
  COLUMN_TYPE_HELP;

const COLLECTIONS_DELETE_DESCRIPTION =
  "Delete a whole collection and every row in it. Irreversible — do this only when the owner asked " +
  "for exactly that, naming the collection. Owner only.";

const COLLECTION_IMPORT_DESCRIPTION =
  "Import a document someone sent in this conversation (a CSV, TSV, XLSX or JSON file — it appears in " +
  "the transcript as [document: <name>, id <id>]) into a collection, row by row, in one call. " +
  "Either an existing 'collection_id', or a 'proposal' for a NEW collection (same fields as creating " +
  "one) that you first read the file's header for, proposed to the person, and they confirmed — one " +
  "confirmation, then this call does the whole file. File columns map onto collection columns by " +
  "matching header name (or the column's label); use 'mapping' {column_key: header_or_index} when " +
  "names differ. A row whose key already exists is updated. Every value is checked against its " +
  "column's type; a row that does not fit is skipped and reported with the reason — report the " +
  "counts back plainly. Owner only.";

const ROWS_ADD_DESCRIPTION =
  "Add an item to a collection: 'values' is an object keyed by column key (from the collection's " +
  "column list) with the item's data. Give every value you know, in the column's type — a number for " +
  "a number column, YYYY-MM-DD for a date, an array for a list, one of the options for an enum. " +
  "The key column MUST be present; if an item with that key exists it is updated with these values " +
  "instead of duplicated. Leave unknown columns out (they are gaps to fill later). Owner only.";

const ROWS_UPDATE_DESCRIPTION =
  "Update some columns of one item, named by 'row_id' or by 'key' (the value of its key column). " +
  "Give only the columns that change, in their types; the rest are kept. Use it to fill gaps you " +
  "looked up, to record a rating the person gave, to correct a value. Owner only.";

const ROWS_DELETE_DESCRIPTION =
  "Delete one item from a collection, named by 'row_id' or by 'key'. Owner only.";

const ROWS_GET_DESCRIPTION =
  "Read one item of a collection in full, by 'row_id' or by 'key' (the value of its key column — an " +
  "id, a URL). Answers with every column and which ones are still empty (gaps).";

const ROWS_QUERY_DESCRIPTION =
  "Find items in a collection. Combine: 'filters' (conditions on columns: eq, neq, contains, gt, gte, " +
  "lt, lte, empty, not_empty), 'gaps' true for only the items still missing required data, a free-text " +
  "'query' (meaning-based when an embedding model is configured, a substring match otherwise), 'sort' " +
  "by a column, and 'offset'/'limit' to page — at most " +
  `${MAX_QUERY_PAGE} per page; the answer says the total and whether more follow. ` +
  "Query before answering ANY question about what the collection holds — never recall items from " +
  "memory or the transcript. For a fill-the-gaps job, query with gaps=true and work through the page.";

const VALUE = z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]);

const columnInput = z.object({
  key: z.string().min(1).max(64).describe("Machine key: lowercase letters, digits, underscores; starts with a letter."),
  label: z.string().max(80).optional().describe("What people call the column. Defaults to the key."),
  type: z.enum(COLUMN_TYPES),
  options: z.array(z.string()).optional().describe("For enum: the allowed values."),
  scale: z.number().int().optional().describe("For rating: the top of the scale (a rating is 0..scale). Default 10."),
  is_key: z.boolean().optional().describe("True on exactly one column: the item's identity."),
  required_for_complete: z.boolean().optional().describe("True when an item without this value counts as having a gap."),
});

const collectionFields = {
  name: z.string().min(1).max(80),
  description: z.string().max(1000).optional().describe("One or two sentences on what the collection holds."),
  visibility: z.enum(["private", "shared"]).optional().describe("Default private."),
  fill_instruction: z.string().max(4000).optional().describe("How to find what an item lacks, in the owner's words."),
  presentation_instruction: z.string().max(4000).optional().describe("How to present an item in chat, in the owner's words."),
  columns: z.array(columnInput).min(1).max(MAX_COLUMNS),
};

const proposalInput = z.object(collectionFields);

const rowRefFields = {
  row_id: z.string().optional().describe("The item's id, as a previous answer gave it."),
  key: z.string().optional().describe("The value of the item's key column."),
};

function textResult(text: string, structured?: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], structuredContent: structured };
}

function errorResult(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true as const };
}

/** An ApiError becomes the refusal the model relays; anything else is rethrown. */
function toToolError(err: unknown) {
  if (err instanceof ApiError) return errorResult(err.message);
  throw err;
}

function accessOf(ctx: McpToolContext): CollectionAccess | null {
  if (!ctx.assistantId) return null;
  return {
    kind: "chat",
    assistantId: ctx.assistantId,
    ownerRights: ctx.senderIsOwner === true || ctx.authorityIsOwner === true,
  };
}

function provenanceOf(ctx: McpToolContext): RowProvenance {
  return {
    createdByUserRef: ctx.userId ? scopedRef(ctx.source, "user", ctx.userId) : null,
    originChatRef: scopedRef(ctx.source, "chat", ctx.chatId),
  };
}

function toColumns(input: z.infer<typeof columnInput>[]) {
  return input.map((column) => ({
    key: column.key,
    label: column.label,
    type: column.type,
    options: column.options,
    scale: column.scale,
    isKey: column.is_key ?? false,
    requiredForComplete: column.required_for_complete ?? false,
  }));
}

function toCollectionInput(input: z.infer<typeof proposalInput>) {
  return {
    name: input.name,
    description: input.description ?? "",
    visibility: input.visibility ?? ("private" as const),
    fillInstruction: input.fill_instruction ?? "",
    presentationInstruction: input.presentation_instruction ?? "",
    columns: toColumns(input.columns),
  };
}

function rowRefOf(input: { row_id?: string; key?: string }): RowRef | null {
  if (input.row_id?.trim()) return { id: input.row_id.trim() };
  if (input.key?.trim()) return { key: input.key.trim() };
  return null;
}

const NO_ROW_REF = "Name the item: give 'row_id' or 'key'.";

/** A column line for the model. */
function columnText(column: CollectionColumn): string {
  const notes: string[] = [column.type];
  if (column.type === "enum" && column.options?.length) notes.push(`one of ${column.options.join("/")}`);
  if (column.type === "rating") notes.push(`0-${ratingScale(column)}`);
  if (column.isKey) notes.push("key");
  if (column.requiredForComplete) notes.push("needed");
  return `${column.key} (${notes.join(", ")})`;
}

function collectionText(collection: Collection): string {
  return (
    `${summarizeCollection(collection)} — id ${collection.id}, ${collection.visibility}\n` +
    `columns: ${collection.columns.map(columnText).join("; ")}`
  );
}

function collectionView(collection: Collection) {
  return {
    id: collection.id,
    name: collection.name,
    description: collection.description,
    visibility: collection.visibility,
    fill_instruction: collection.fillInstruction,
    presentation_instruction: collection.presentationInstruction,
    columns: collection.columns.map((column) => ({
      key: column.key,
      label: column.label,
      type: column.type,
      options: column.options,
      scale: column.scale,
      is_key: column.isKey,
      required_for_complete: column.requiredForComplete,
    })),
    rows: collection.rowCount,
    rows_with_gaps: collection.gapCount,
  };
}

/** One row as one line: `id · key · col=value; col=value` with the gaps named. */
export function rowText(row: RowWithGaps): string {
  const cells = Object.entries(row.values)
    .filter(([, value]) => value !== null && value !== "")
    .map(([key, value]) => `${key}=${renderValue(value)}`)
    .join("; ");
  const gaps = row.gaps.length > 0 ? ` [gaps: ${row.gaps.join(", ")}]` : "";
  return `${row.id} · ${cells}${gaps}`;
}

function rowView(row: RowWithGaps) {
  return { id: row.id, key: row.keyValue, values: row.values, complete: row.complete, gaps: row.gaps };
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

/** Register the collections toolkit on the shared server. */
export function registerCollectionsMcpTools(server: McpServer): void {
  server.registerTool(
    COLLECTIONS_CREATE_TOOL,
    {
      title: "Create a collection",
      description: COLLECTIONS_CREATE_DESCRIPTION,
      inputSchema: collectionFields,
      annotations: WRITE,
    },
    async (input) => {
      const ctx = getToolContext();
      const access = accessOf(ctx);
      if (!access) return errorResult(NO_ASSISTANT);
      try {
        const collection = await createCollectionService(toCollectionInput(input), access, toolContextTrigger(ctx));
        return textResult(
          `Created ${collectionText(collection)}. Up to ${MAX_COLLECTIONS_PER_ASSISTANT} collections per assistant.`,
          collectionView(collection),
        );
      } catch (err) {
        return toToolError(err);
      }
    },
  );

  server.registerTool(
    COLLECTIONS_UPDATE_TOOL,
    {
      title: "Change a collection",
      description: COLLECTIONS_UPDATE_DESCRIPTION,
      inputSchema: {
        collection_id: z.string().min(1),
        name: collectionFields.name.optional(),
        description: collectionFields.description,
        visibility: collectionFields.visibility,
        fill_instruction: collectionFields.fill_instruction,
        presentation_instruction: collectionFields.presentation_instruction,
        columns: collectionFields.columns.optional(),
      },
      annotations: WRITE,
    },
    async (input) => {
      const ctx = getToolContext();
      const access = accessOf(ctx);
      if (!access) return errorResult(NO_ASSISTANT);
      const patch = {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
        ...(input.fill_instruction !== undefined ? { fillInstruction: input.fill_instruction } : {}),
        ...(input.presentation_instruction !== undefined
          ? { presentationInstruction: input.presentation_instruction }
          : {}),
        ...(input.columns !== undefined ? { columns: toColumns(input.columns) } : {}),
      };
      if (Object.keys(patch).length === 0) return errorResult("Nothing to change: give at least one field.");
      try {
        const collection = await editCollectionService(input.collection_id, patch, access, toolContextTrigger(ctx));
        return textResult(`Updated ${collectionText(collection)}.`, collectionView(collection));
      } catch (err) {
        return toToolError(err);
      }
    },
  );

  server.registerTool(
    COLLECTIONS_DELETE_TOOL,
    {
      title: "Delete a collection",
      description: COLLECTIONS_DELETE_DESCRIPTION,
      inputSchema: { collection_id: z.string().min(1) },
      annotations: DESTRUCTIVE,
    },
    async (input) => {
      const ctx = getToolContext();
      const access = accessOf(ctx);
      if (!access) return errorResult(NO_ASSISTANT);
      try {
        await removeCollectionService(input.collection_id, access, toolContextTrigger(ctx));
        return textResult(`Deleted collection ${input.collection_id} with all its rows.`, { ok: true });
      } catch (err) {
        return toToolError(err);
      }
    },
  );

  server.registerTool(
    COLLECTION_IMPORT_TOOL,
    {
      title: "Import a document into a collection",
      description: COLLECTION_IMPORT_DESCRIPTION,
      inputSchema: {
        document_id: z.string().min(1).describe("The document's id, as the transcript shows it after 'id'."),
        collection_id: z.string().optional().describe("An existing collection to import into."),
        proposal: proposalInput.optional().describe("A new collection to create for the file, confirmed by the person."),
        mapping: z
          .record(z.string(), z.union([z.string(), z.number().int().min(0)]))
          .optional()
          .describe("collection column key -> file column (header name, or 0-based index). Only where names differ."),
        sheet: z.union([z.string(), z.number().int().min(0)]).optional().describe("For a workbook: the sheet, by name or index."),
      },
      annotations: WRITE,
    },
    async (input) => {
      const ctx = getToolContext();
      const access = accessOf(ctx);
      if (!access) return errorResult(NO_ASSISTANT);
      if (Boolean(input.collection_id) === Boolean(input.proposal)) {
        return errorResult("Give either 'collection_id' (an existing collection) or 'proposal' (a new one), not both.");
      }
      const document = await getDocument(input.document_id).catch(() => null);
      // A document belongs to the conversation it was sent in — the same rule
      // as reading one.
      if (!document || document.record.source !== ctx.source || document.record.chatId !== ctx.chatId) {
        return errorResult(
          "No document with that id in this conversation. Documents appear in the transcript as [document: <name>, id <id>].",
        );
      }
      try {
        const report = await importRowsService(
          {
            collectionId: input.collection_id,
            proposal: input.proposal ? toCollectionInput(input.proposal) : undefined,
            mapping: input.mapping ?? {},
            sheet: input.sheet,
          },
          {
            ref: scopedRef(document.record.source, "document", document.record.id),
            label: document.record.description ?? document.record.filename ?? "document",
            bytes: document.bytes,
            format: document.format,
          },
          { access, provenance: provenanceOf(ctx), trigger: toolContextTrigger(ctx) },
        );
        const skipped =
          report.skipped.length > 0
            ? `\nSkipped:\n${report.skipped.map((s) => `row ${s.row}: ${s.reason}`).join("\n")}`
            : "";
        return textResult(
          `Imported into collection ${report.collectionId}: ${report.inserted} added, ${report.updated} updated, ` +
            `${report.skipped.length} skipped of ${report.total} records.${skipped}`,
          {
            collection_id: report.collectionId,
            inserted: report.inserted,
            updated: report.updated,
            skipped: report.skipped,
            total: report.total,
          },
        );
      } catch (err) {
        return toToolError(err);
      }
    },
  );

  server.registerTool(
    ROWS_ADD_TOOL,
    {
      title: "Add an item to a collection",
      description: ROWS_ADD_DESCRIPTION,
      inputSchema: {
        collection_id: z.string().min(1),
        values: z.record(z.string(), VALUE).describe("The item's data, keyed by column key."),
      },
      annotations: WRITE,
    },
    async (input) => {
      const ctx = getToolContext();
      const access = accessOf(ctx);
      if (!access) return errorResult(NO_ASSISTANT);
      try {
        const { row, created } = await addRowService(input.collection_id, input.values, {
          access,
          provenance: provenanceOf(ctx),
          trigger: toolContextTrigger(ctx),
        });
        return textResult(`${created ? "Added" : "Updated existing item"}: ${rowText(row)}`, {
          ...rowView(row),
          created,
        });
      } catch (err) {
        return toToolError(err);
      }
    },
  );

  server.registerTool(
    ROWS_UPDATE_TOOL,
    {
      title: "Update an item",
      description: ROWS_UPDATE_DESCRIPTION,
      inputSchema: {
        collection_id: z.string().min(1),
        ...rowRefFields,
        values: z.record(z.string(), VALUE).describe("The columns that change, keyed by column key."),
      },
      annotations: WRITE,
    },
    async (input) => {
      const ctx = getToolContext();
      const access = accessOf(ctx);
      if (!access) return errorResult(NO_ASSISTANT);
      const ref = rowRefOf(input);
      if (!ref) return errorResult(NO_ROW_REF);
      try {
        const row = await editRowService(input.collection_id, ref, input.values, {
          access,
          trigger: toolContextTrigger(ctx),
        });
        return textResult(`Updated: ${rowText(row)}`, rowView(row));
      } catch (err) {
        return toToolError(err);
      }
    },
  );

  server.registerTool(
    ROWS_DELETE_TOOL,
    {
      title: "Delete an item",
      description: ROWS_DELETE_DESCRIPTION,
      inputSchema: { collection_id: z.string().min(1), ...rowRefFields },
      annotations: DESTRUCTIVE,
    },
    async (input) => {
      const ctx = getToolContext();
      const access = accessOf(ctx);
      if (!access) return errorResult(NO_ASSISTANT);
      const ref = rowRefOf(input);
      if (!ref) return errorResult(NO_ROW_REF);
      try {
        await removeRowService(input.collection_id, ref, { access, trigger: toolContextTrigger(ctx) });
        return textResult("Deleted the item.", { ok: true });
      } catch (err) {
        return toToolError(err);
      }
    },
  );

  server.registerTool(
    ROWS_GET_TOOL,
    {
      title: "Read one item",
      description: ROWS_GET_DESCRIPTION,
      inputSchema: { collection_id: z.string().min(1), ...rowRefFields },
      annotations: READ_ONLY,
    },
    async (input) => {
      const ctx = getToolContext();
      const access = accessOf(ctx);
      if (!access) return errorResult(NO_ASSISTANT);
      const ref = rowRefOf(input);
      if (!ref) return errorResult(NO_ROW_REF);
      try {
        const row = await getRowService(input.collection_id, ref, access);
        return textResult(rowText(row), rowView(row));
      } catch (err) {
        return toToolError(err);
      }
    },
  );

  server.registerTool(
    ROWS_QUERY_TOOL,
    {
      title: "Find items",
      description: ROWS_QUERY_DESCRIPTION,
      inputSchema: {
        collection_id: z.string().min(1),
        query: z.string().max(500).optional().describe("Free text to search the items for."),
        filters: z
          .array(
            z.object({
              column: z.string().min(1),
              op: z.enum(["eq", "neq", "contains", "gt", "gte", "lt", "lte", "empty", "not_empty"]),
              value: VALUE.optional(),
            }),
          )
          .max(10)
          .optional(),
        gaps: z.boolean().optional().describe("True: only items that still lack required data."),
        sort: z.string().optional().describe("A column key to sort by."),
        direction: z.enum(["asc", "desc"]).optional(),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(MAX_QUERY_PAGE).optional(),
      },
      annotations: READ_ONLY,
    },
    async (input) => {
      const ctx = getToolContext();
      const access = accessOf(ctx);
      if (!access) return errorResult(NO_ASSISTANT);
      try {
        const page = await queryRowsService(
          input.collection_id,
          {
            query: input.query,
            filters: (input.filters ?? []).map((filter) => ({
              column: filter.column,
              op: filter.op,
              value: Array.isArray(filter.value) ? filter.value[0] : filter.value,
            })),
            gaps: input.gaps ?? false,
            sort: input.sort,
            direction: input.direction ?? "asc",
            offset: input.offset ?? 0,
            limit: input.limit ?? 20,
          },
          access,
        );
        const first = page.offset + 1;
        const last = page.offset + page.rows.length;
        const range = page.total === 0 ? "no items match" : `items ${first}-${last} of ${page.total}`;
        const more = page.hasMore ? ` (more follow — continue at offset ${last})` : "";
        const how = page.semantic ? ", ranked by meaning" : "";
        const lines = [`${range}${how}${more}`, ...page.rows.map(rowText)];
        return textResult(lines.join("\n"), {
          rows: page.rows.map(rowView),
          offset: page.offset,
          limit: page.limit,
          total: page.total,
          has_more: page.hasMore,
          semantic: page.semantic,
        });
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
