import {
  COLUMN_TYPES,
  KEY_COLUMN_TYPES,
  MAX_COLUMNS,
  MAX_ENUM_OPTIONS,
  MAX_LABEL_LENGTH,
  MAX_LIST_ITEMS,
  MAX_LONG_TEXT_LENGTH,
  MAX_TEXT_LENGTH,
  type CollectionColumn,
  type ColumnType,
  type RowValue,
} from "./types";

/**
 * The column rules — what a collection's schema may say and what a value may
 * be. Pure and client-safe: the service, the tools, the Route Handlers and the
 * dashboard's editor all judge by these, so a row that passes here is a row
 * the store accepts. The model proposes columns; this is what enforces them
 * (user decision, 2026-09-08: typed columns, code-enforced, never coerced
 * silently — a bad value is refused with the column named).
 */

export type Check<T> = { ok: true; value: T } | { ok: false; reason: string };

const KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_RATING_SCALE = 10;
const MAX_RATING_SCALE = 1000;

/** The rating scale a column uses. */
export function ratingScale(column: Pick<CollectionColumn, "scale">): number {
  return column.scale ?? DEFAULT_RATING_SCALE;
}

/** Whether a value counts as empty — a missing cell, whatever the type. */
export function isEmptyValue(value: unknown): boolean {
  return (
    value == null ||
    (typeof value === "string" && value.trim() === "") ||
    (Array.isArray(value) && value.length === 0)
  );
}

/**
 * Check a column list: keys well-formed and unique, labels present, exactly
 * one key column of a keyable type, enum options present and unique, rating
 * scales sane. Returns the normalized columns (trimmed, defaults applied).
 */
export function checkColumns(input: unknown): Check<CollectionColumn[]> {
  if (!Array.isArray(input) || input.length === 0) {
    return { ok: false, reason: "a collection needs at least one column" };
  }
  if (input.length > MAX_COLUMNS) {
    return { ok: false, reason: `a collection may have at most ${MAX_COLUMNS} columns` };
  }
  const columns: CollectionColumn[] = [];
  const keys = new Set<string>();
  let keyColumns = 0;
  for (const [index, raw] of input.entries()) {
    if (!raw || typeof raw !== "object") {
      return { ok: false, reason: `column ${index + 1} is not an object` };
    }
    const c = raw as Record<string, unknown>;
    const key = typeof c.key === "string" ? c.key.trim() : "";
    if (!KEY_PATTERN.test(key)) {
      return {
        ok: false,
        reason: `column ${index + 1}: key "${key}" must be a-z, 0-9 and _, start with a letter, and be at most 64 characters`,
      };
    }
    if (keys.has(key)) return { ok: false, reason: `column key "${key}" is used twice` };
    keys.add(key);
    const label = typeof c.label === "string" && c.label.trim() ? c.label.trim() : key;
    if (label.length > MAX_LABEL_LENGTH) {
      return { ok: false, reason: `column "${key}": the label is longer than ${MAX_LABEL_LENGTH} characters` };
    }
    const type = c.type as ColumnType;
    if (!COLUMN_TYPES.includes(type)) {
      return {
        ok: false,
        reason: `column "${key}": type "${String(c.type)}" is not one of ${COLUMN_TYPES.join(", ")}`,
      };
    }
    const column: CollectionColumn = {
      key,
      label,
      type,
      isKey: c.isKey === true,
      requiredForComplete: c.requiredForComplete === true,
    };
    if (type === "enum") {
      const options = Array.isArray(c.options)
        ? [...new Set(c.options.map((o) => String(o).trim()).filter(Boolean))]
        : [];
      if (options.length === 0) return { ok: false, reason: `column "${key}": an enum needs its options` };
      if (options.length > MAX_ENUM_OPTIONS) {
        return { ok: false, reason: `column "${key}": at most ${MAX_ENUM_OPTIONS} options` };
      }
      column.options = options;
    }
    if (type === "rating") {
      const scale = c.scale == null ? DEFAULT_RATING_SCALE : Number(c.scale);
      if (!Number.isInteger(scale) || scale < 1 || scale > MAX_RATING_SCALE) {
        return { ok: false, reason: `column "${key}": the rating scale must be a whole number from 1 to ${MAX_RATING_SCALE}` };
      }
      column.scale = scale;
    }
    if (column.isKey) {
      keyColumns++;
      if (!KEY_COLUMN_TYPES.includes(type)) {
        return { ok: false, reason: `column "${key}": a key column must be text, number or url` };
      }
    }
    columns.push(column);
  }
  if (keyColumns !== 1) {
    return {
      ok: false,
      reason:
        keyColumns === 0
          ? "exactly one column must be the key (isKey) — the site's id or the URL, so a repeat updates instead of duplicating"
          : "only one column may be the key",
    };
  }
  return { ok: true, value: columns };
}

function checkUrl(value: unknown, column: CollectionColumn): Check<RowValue> {
  const text = typeof value === "string" ? value.trim() : "";
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("scheme");
    return { ok: true, value: url.toString() };
  } catch {
    return { ok: false, reason: `"${column.key}" must be an http(s) URL` };
  }
}

/**
 * Normalize one value for its column, or say why it is refused. Empty (null,
 * blank, an empty list) is accepted for every type and stored as null —
 * emptiness is what a gap is, and completeness is judged separately.
 */
export function normalizeValue(column: CollectionColumn, value: unknown): Check<RowValue> {
  if (isEmptyValue(value)) return { ok: true, value: null };
  switch (column.type) {
    case "text":
    case "long_text": {
      const text = typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : null;
      if (text === null) return { ok: false, reason: `"${column.key}" must be text` };
      const max = column.type === "text" ? MAX_TEXT_LENGTH : MAX_LONG_TEXT_LENGTH;
      if (text.length > max) return { ok: false, reason: `"${column.key}" is longer than ${max} characters` };
      return { ok: true, value: text.trim() };
    }
    case "number": {
      const n = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : Number.NaN;
      if (!Number.isFinite(n)) return { ok: false, reason: `"${column.key}" must be a number` };
      return { ok: true, value: n };
    }
    case "date": {
      const text = typeof value === "string" ? value.trim() : "";
      if (!text || Number.isNaN(Date.parse(text))) {
        return { ok: false, reason: `"${column.key}" must be a date (YYYY-MM-DD, or an ISO date-time)` };
      }
      return { ok: true, value: DATE_ONLY.test(text) ? text : new Date(text).toISOString() };
    }
    case "url":
    case "image":
      return checkUrl(value, column);
    case "list": {
      const items = Array.isArray(value)
        ? value.map((item) => String(item).trim()).filter(Boolean)
        : typeof value === "string"
          ? value.split(/[,;\n]/).map((item) => item.trim()).filter(Boolean)
          : null;
      if (items === null) return { ok: false, reason: `"${column.key}" must be a list of text items` };
      if (items.length > MAX_LIST_ITEMS) return { ok: false, reason: `"${column.key}" may hold at most ${MAX_LIST_ITEMS} items` };
      return { ok: true, value: items.length > 0 ? items : null };
    }
    case "enum": {
      const text = typeof value === "string" ? value.trim() : String(value);
      const options = column.options ?? [];
      const match = options.find((option) => option.toLowerCase() === text.toLowerCase());
      if (!match) return { ok: false, reason: `"${column.key}" must be one of ${options.join(", ")}` };
      return { ok: true, value: match };
    }
    case "rating": {
      const n = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : Number.NaN;
      const scale = ratingScale(column);
      if (!Number.isFinite(n) || n < 0 || n > scale) {
        return { ok: false, reason: `"${column.key}" must be a rating from 0 to ${scale}` };
      }
      return { ok: true, value: n };
    }
    case "boolean": {
      if (typeof value === "boolean") return { ok: true, value };
      const text = typeof value === "string" ? value.trim().toLowerCase() : "";
      if (["true", "yes", "y", "1"].includes(text)) return { ok: true, value: true };
      if (["false", "no", "n", "0"].includes(text)) return { ok: true, value: false };
      return { ok: false, reason: `"${column.key}" must be yes or no` };
    }
  }
}

/**
 * Normalize a values object against the columns: unknown keys are refused
 * (the column is named), known ones normalized. With `partial` only the keys
 * given are checked — an update — otherwise every column is present in the
 * result, absent ones as null.
 */
export function normalizeValues(
  columns: readonly CollectionColumn[],
  input: unknown,
  options: { partial: boolean },
): Check<Record<string, RowValue>> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, reason: "values must be an object keyed by column" };
  }
  const given = input as Record<string, unknown>;
  const known = new Map(columns.map((column) => [column.key, column]));
  for (const key of Object.keys(given)) {
    if (!known.has(key)) {
      return { ok: false, reason: `"${key}" is not a column of this collection (columns: ${[...known.keys()].join(", ")})` };
    }
  }
  const values: Record<string, RowValue> = {};
  for (const column of columns) {
    if (!(column.key in given)) {
      if (!options.partial) values[column.key] = null;
      continue;
    }
    const checked = normalizeValue(column, given[column.key]);
    if (!checked.ok) return checked;
    values[column.key] = checked.value;
  }
  return { ok: true, value: values };
}

/** Whether a row is complete: every "needed for complete" column holds a value. */
export function isComplete(columns: readonly CollectionColumn[], values: Record<string, RowValue>): boolean {
  return columns.every((column) => !column.requiredForComplete || !isEmptyValue(values[column.key]));
}

/** The key column of a collection. */
export function keyColumnOf(columns: readonly CollectionColumn[]): CollectionColumn {
  const key = columns.find((column) => column.isKey);
  if (!key) throw new Error("a collection has no key column");
  return key;
}

/** The row key a values object carries, as text, or why it has none. */
export function keyValueOf(columns: readonly CollectionColumn[], values: Record<string, RowValue>): Check<string> {
  const column = keyColumnOf(columns);
  const value = values[column.key];
  if (isEmptyValue(value)) return { ok: false, reason: `the key column "${column.key}" is empty` };
  return { ok: true, value: String(value).trim() };
}

/** The columns a row still lacks — its gaps. */
export function gapsOf(columns: readonly CollectionColumn[], values: Record<string, RowValue>): string[] {
  return columns
    .filter((column) => column.requiredForComplete && isEmptyValue(values[column.key]))
    .map((column) => column.key);
}

/** A value as one line of text — for the embedding rendering and the prompt. */
export function renderValue(value: RowValue): string {
  if (value == null) return "";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

/** The text a row is embedded from: `label: value` per filled column. */
export function renderRowForEmbedding(
  columns: readonly CollectionColumn[],
  values: Record<string, RowValue>,
): string {
  return columns
    .filter((column) => !isEmptyValue(values[column.key]))
    .map((column) => `${column.label}: ${renderValue(values[column.key])}`)
    .join("\n");
}

/** Apply a column change to stored values: drop removed columns' cells, keep the rest. */
export function reshapeValues(
  columns: readonly CollectionColumn[],
  values: Record<string, RowValue>,
): Record<string, RowValue> {
  const next: Record<string, RowValue> = {};
  for (const column of columns) next[column.key] = values[column.key] ?? null;
  return next;
}
