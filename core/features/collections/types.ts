/**
 * Client-safe shared types for collections — an assistant's structured data:
 * typed columns the model proposes from the data and code enforces, rows keyed
 * by one column, kept per assistant (user decisions, 2026-09-08). Imported by
 * the server service, the Route Handlers and the dashboard, so it must stay
 * free of server-only imports.
 */

/** The column types a collection may declare. */
export const COLUMN_TYPES = [
  "text",
  "long_text",
  "number",
  "date",
  "url",
  "image",
  "list",
  "enum",
  "rating",
  "boolean",
] as const;

export type ColumnType = (typeof COLUMN_TYPES)[number];

/** Human labels for the column types, for the dashboard's pickers. */
export const COLUMN_TYPE_LABELS: Record<ColumnType, string> = {
  text: "Text",
  long_text: "Long text",
  number: "Number",
  date: "Date",
  url: "URL",
  image: "Image (URL)",
  list: "List",
  enum: "One of a set",
  rating: "Rating",
  boolean: "Yes / no",
};

/** Column types whose values may serve as the row key. */
export const KEY_COLUMN_TYPES: readonly ColumnType[] = ["text", "number", "url"];

/** One column of a collection, as stored on the collection row. */
export interface CollectionColumn {
  /** Machine key, unique within the collection: `^[a-z][a-z0-9_]{0,63}$`. */
  key: string;
  /** What people call it. */
  label: string;
  type: ColumnType;
  /** For `enum`: the allowed values. */
  options?: string[];
  /** For `rating`: the top of the scale (a rating is 0..scale). Default 10. */
  scale?: number;
  /** Exactly one column is the key: a write with an existing key updates the row. */
  isKey: boolean;
  /** Part of what makes a row complete — what "missing data" means. */
  requiredForComplete: boolean;
}

export type CollectionVisibility = "private" | "shared";

/** A collection as returned to clients. */
export interface Collection {
  id: string;
  assistantId: string;
  name: string;
  description: string;
  visibility: CollectionVisibility;
  /** How the assistant fills what a row lacks — free text, composed into its prompt. */
  fillInstruction: string;
  /** How an item is presented in chat — free text, composed into its prompt. */
  presentationInstruction: string;
  columns: CollectionColumn[];
  rowCount: number;
  /** Rows not yet complete — what a fill-the-gaps loop works through. */
  gapCount: number;
  createdAt: string;
  updatedAt: string;
}

/** A cell value, normalized per its column's type. `null` is empty. */
export type RowValue = string | number | boolean | string[] | null;

/** A row as returned to clients. */
export interface CollectionRow {
  id: string;
  collectionId: string;
  /** The key column's value as text — unique within the collection. */
  keyValue: string;
  values: Record<string, RowValue>;
  complete: boolean;
  createdByUserRef: string | null;
  originChatRef: string | null;
  /** The document an import created or last updated the row from, or null. */
  sourceDocumentRef: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One condition of a row query. */
export interface RowFilter {
  column: string;
  op: "eq" | "neq" | "contains" | "gt" | "gte" | "lt" | "lte" | "empty" | "not_empty";
  value?: string | number | boolean | null;
}

/** A page of rows, with what the caller needs to page on. */
export interface RowPage {
  rows: CollectionRow[];
  offset: number;
  limit: number;
  total: number;
  hasMore: boolean;
  /** True when the page was ranked semantically (a text query with embeddings configured). */
  semantic: boolean;
}

/** What an import reports. */
export interface ImportReport {
  collectionId: string;
  inserted: number;
  updated: number;
  skipped: { row: number; reason: string }[];
  /** Rows the file held (the header excluded). */
  total: number;
}

// ---- bounds (code constants, per the spec) ------------------------------------

export const MAX_COLLECTIONS_PER_ASSISTANT = 16;
export const MAX_COLUMNS = 64;
export const MAX_ROWS_PER_COLLECTION = 50_000;
export const MAX_QUERY_PAGE = 50;
export const DEFAULT_QUERY_PAGE = 20;
export const MAX_NAME_LENGTH = 80;
export const MAX_LABEL_LENGTH = 80;
export const MAX_DESCRIPTION_LENGTH = 1000;
export const MAX_INSTRUCTION_LENGTH = 4000;
export const MAX_ENUM_OPTIONS = 64;
export const MAX_TEXT_LENGTH = 2000;
export const MAX_LONG_TEXT_LENGTH = 20_000;
export const MAX_LIST_ITEMS = 200;
export const MAX_IMPORT_SKIPS_REPORTED = 50;
