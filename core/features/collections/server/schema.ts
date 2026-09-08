import { z } from "zod";

import {
  COLUMN_TYPES,
  DEFAULT_QUERY_PAGE,
  MAX_DESCRIPTION_LENGTH,
  MAX_INSTRUCTION_LENGTH,
  MAX_NAME_LENGTH,
  MAX_QUERY_PAGE,
} from "../types";

/**
 * Collections validation contract — the shape of a collection, a row and a
 * query as every caller speaks it: the service, the Route Handlers, the MCP
 * toolkit and the dashboard. Pure (no `server-only`) so tests build inputs
 * against the same schema the handlers parse. Column *rules* (one key, enum
 * options, value types) are judged by `columns.ts`, not here — these schemas
 * validate shapes and bounds.
 */

const name = z.string().trim().min(1, "a name is required").max(MAX_NAME_LENGTH);
const description = z.string().trim().max(MAX_DESCRIPTION_LENGTH);
const instruction = z.string().trim().max(MAX_INSTRUCTION_LENGTH);
const visibility = z.enum(["private", "shared"]);

/** A column as a caller states it; the rules run in `checkColumns`. */
export const columnSchema = z.object({
  key: z.string().trim().min(1).max(64),
  label: z.string().trim().max(80).optional(),
  type: z.enum(COLUMN_TYPES),
  options: z.array(z.string()).optional(),
  scale: z.number().int().optional(),
  isKey: z.boolean().optional().default(false),
  requiredForComplete: z.boolean().optional().default(false),
});

export const createCollectionSchema = z.object({
  assistantId: z.string().min(1),
  name,
  description: description.optional().default(""),
  visibility: visibility.optional().default("private"),
  fillInstruction: instruction.optional().default(""),
  presentationInstruction: instruction.optional().default(""),
  columns: z.array(columnSchema).min(1),
});

export type CreateCollectionInput = z.infer<typeof createCollectionSchema>;

export const updateCollectionSchema = z
  .object({
    name,
    description,
    visibility,
    fillInstruction: instruction,
    presentationInstruction: instruction,
    columns: z.array(columnSchema).min(1),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: "Provide at least one field to update" });

export type UpdateCollectionInput = z.infer<typeof updateCollectionSchema>;

/** A row's values: any object; the columns decide what is accepted. */
export const rowValuesSchema = z.record(z.string(), z.unknown());

export const addRowSchema = z.object({
  values: rowValuesSchema,
});

export const updateRowSchema = z.object({
  values: rowValuesSchema.refine((v) => Object.keys(v).length > 0, {
    message: "Provide at least one value to update",
  }),
});

export const rowFilterSchema = z.object({
  column: z.string().min(1),
  op: z.enum(["eq", "neq", "contains", "gt", "gte", "lt", "lte", "empty", "not_empty"]),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
});

export const queryRowsSchema = z.object({
  /** Free text: a substring match over every cell, or a semantic query when embeddings run. */
  query: z.string().trim().max(500).optional(),
  filters: z.array(rowFilterSchema).max(10).optional().default([]),
  /** Only rows that still have gaps. */
  gaps: z.boolean().optional().default(false),
  sort: z.string().min(1).optional(),
  direction: z.enum(["asc", "desc"]).optional().default("asc"),
  offset: z.number().int().min(0).optional().default(0),
  limit: z.number().int().min(1).max(MAX_QUERY_PAGE).optional().default(DEFAULT_QUERY_PAGE),
});

export type QueryRowsInput = z.infer<typeof queryRowsSchema>;

/**
 * The dashboard's query-string form of the same query (every filter a URL
 * control): `q`, `gaps=1`, `sort`, `direction`, `offset`, `limit`, and
 * `filters` as a JSON array of `{ column, op, value }`.
 */
export const queryRowsQuerySchema = z.object({
  q: z.string().trim().max(500).optional(),
  gaps: z.enum(["1", "0"]).optional(),
  sort: z.string().optional(),
  direction: z.enum(["asc", "desc"]).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_QUERY_PAGE).optional(),
  filters: z.string().optional(),
});

export type QueryRowsSearch = z.infer<typeof queryRowsQuerySchema>;

/** The query-string form as the service's input; a malformed `filters` is a validation error. */
export function rowQueryFromSearch(search: QueryRowsSearch): QueryRowsInput {
  let filters: unknown = [];
  if (search.filters) {
    try {
      filters = JSON.parse(search.filters);
    } catch {
      throw new z.ZodError([
        { code: "custom", path: ["filters"], message: "filters must be a JSON array", input: search.filters },
      ]);
    }
  }
  return queryRowsSchema.parse({
    query: search.q,
    filters,
    gaps: search.gaps === "1",
    sort: search.sort || undefined,
    direction: search.direction,
    offset: search.offset,
    limit: search.limit,
  });
}

/**
 * An import: which document, into which collection (existing, or one to
 * create from a confirmed proposal), and how the file's columns map onto the
 * collection's — by header name or 0-based index.
 */
export const importSchema = z
  .object({
    documentId: z.string().min(1),
    collectionId: z.string().min(1).optional(),
    proposal: createCollectionSchema.omit({ assistantId: true }).optional(),
    /** collection column key → file column (a header name, or a 0-based index). */
    mapping: z.record(z.string(), z.union([z.string(), z.number().int().min(0)])),
    /** For a workbook: the sheet to import, by name or 0-based index. */
    sheet: z.union([z.string(), z.number().int().min(0)]).optional(),
  })
  .refine((v) => (v.collectionId ? !v.proposal : Boolean(v.proposal)), {
    message: "Give either an existing collectionId or a proposal for a new collection, not both",
  });

export type ImportInput = z.infer<typeof importSchema>;
