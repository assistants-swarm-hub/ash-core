import type { DocumentFormat } from "@assistants-swarm-hub/contracts";

import { parseDelimited } from "./csv";
import { readXlsx } from "./xlsx";

/**
 * Reading a stored document in windows: rows for the tabular formats, a
 * character range for the text ones. Every answer says how much there is in
 * total and where the window ended, so the caller (the document tool, and
 * the collection import behind it) can page through a file far larger than
 * one model turn should see. Pure over the bytes; no server imports.
 */

/** A page of rows out of a tabular document. */
export interface TabularWindow {
  shape: "rows";
  format: "csv" | "tsv" | "xlsx";
  /** The sheets a workbook has (one for CSV/TSV), and which one this is. */
  sheets: string[];
  sheet: string;
  /** The first row of the sheet, when it looks like a header — always sent, never counted in the window. */
  header: string[] | null;
  /** Data rows in the window (the header excluded). */
  rows: string[][];
  /** 0-based index of the first data row in the window. */
  offset: number;
  /** Data rows in the whole sheet (the header excluded). */
  totalRows: number;
  hasMore: boolean;
}

/** A page of text out of a text document. */
export interface TextWindow {
  shape: "text";
  format: "json" | "txt" | "md";
  text: string;
  /** 0-based character offset the window starts at. */
  offset: number;
  totalChars: number;
  hasMore: boolean;
}

export type DocumentWindow = TabularWindow | TextWindow;

export interface ReadOptions {
  /** Where the window starts: a data-row index, or a character offset. */
  offset?: number;
  /** How many rows, or how many characters. Clamped to the caps below. */
  limit?: number;
  /** For a workbook: which sheet, by name or 0-based index. Default: the first. */
  sheet?: string | number;
}

/** Caps on one window — what one tool result may carry. */
export const MAX_ROWS_PER_WINDOW = 200;
export const DEFAULT_ROWS_PER_WINDOW = 50;
export const MAX_CHARS_PER_WINDOW = 20_000;
export const DEFAULT_CHARS_PER_WINDOW = 6_000;

function clamp(value: number | undefined, fallback: number, max: number): number {
  if (value == null || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value)));
}

/** Rows of a tabular document, with a header when the first row looks like one. */
function tabularWindow(
  format: "csv" | "tsv" | "xlsx",
  sheets: { name: string; rows: string[][] }[],
  options: ReadOptions,
): TabularWindow {
  const wanted = options.sheet;
  const picked =
    typeof wanted === "number"
      ? sheets[wanted]
      : typeof wanted === "string"
        ? sheets.find((sheet) => sheet.name === wanted)
        : sheets[0];
  const sheet = picked ?? sheets[0] ?? { name: "Sheet1", rows: [] };
  const all = sheet.rows;
  // A header is a first row that is entirely non-empty text — the shape an
  // export's column names have. Anything else is data from row one.
  const header =
    all.length > 0 && all[0].length > 0 && all[0].every((cell) => cell.trim().length > 0 && !/^-?\d+(\.\d+)?$/.test(cell.trim()))
      ? all[0]
      : null;
  const data = header ? all.slice(1) : all;
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const limit = clamp(options.limit, DEFAULT_ROWS_PER_WINDOW, MAX_ROWS_PER_WINDOW);
  const rows = data.slice(offset, offset + limit);
  return {
    shape: "rows",
    format,
    sheets: sheets.map((s) => s.name),
    sheet: sheet.name,
    header,
    rows,
    offset,
    totalRows: data.length,
    hasMore: offset + rows.length < data.length,
  };
}

/** A character range of a text document. */
function textWindow(format: "json" | "txt" | "md", text: string, options: ReadOptions): TextWindow {
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const limit = clamp(options.limit, DEFAULT_CHARS_PER_WINDOW, MAX_CHARS_PER_WINDOW);
  const slice = text.slice(offset, offset + limit);
  return {
    shape: "text",
    format,
    text: slice,
    offset,
    totalChars: text.length,
    hasMore: offset + slice.length < text.length,
  };
}

/** A UTF-8 text, the BOM dropped. */
function decodeText(bytes: Buffer): string {
  const text = bytes.toString("utf8");
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * One window of a document. Throws when the bytes are not what the format
 * says (a workbook that is not a zip); the tool turns that into an honest
 * error result.
 */
export function readDocumentWindow(
  bytes: Buffer,
  format: DocumentFormat,
  options: ReadOptions = {},
): DocumentWindow {
  switch (format) {
    case "csv":
      return tabularWindow("csv", [{ name: "Sheet1", rows: parseDelimited(decodeText(bytes), ",") }], options);
    case "tsv":
      return tabularWindow("tsv", [{ name: "Sheet1", rows: parseDelimited(decodeText(bytes), "\t") }], options);
    case "xlsx":
      return tabularWindow("xlsx", readXlsx(bytes), options);
    case "json":
    case "txt":
    case "md":
      return textWindow(format, decodeText(bytes), options);
  }
}
