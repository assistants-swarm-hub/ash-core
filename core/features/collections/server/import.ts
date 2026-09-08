import "server-only";

import type { DocumentFormat } from "@assistants-swarm-hub/contracts";

import { parseDelimited } from "@/features/documents/csv";
import { readXlsx } from "@/features/documents/xlsx";

import type { CollectionColumn } from "../types";

/**
 * Turning a document into rows for an import: the tabular formats by their
 * header, a JSON file as an array of objects. Pure over the bytes — which
 * document, whose collection and what is written are the service's business.
 */

/** A file read for import: named columns and the records under them. */
export interface ImportTable {
  /** The file's column names — the header row, or a JSON array's union of keys. */
  headers: string[];
  /** One record per data row, by header. */
  records: Record<string, string>[];
  /** The sheets a workbook has (one for the other formats), and which one was read. */
  sheets: string[];
  sheet: string;
}

function decodeText(bytes: Buffer): string {
  const text = bytes.toString("utf8");
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function fromSheets(
  sheets: { name: string; rows: string[][] }[],
  wanted: string | number | undefined,
): ImportTable {
  const picked =
    typeof wanted === "number"
      ? sheets[wanted]
      : typeof wanted === "string"
        ? sheets.find((sheet) => sheet.name === wanted)
        : sheets[0];
  if (!picked) {
    throw new Error(
      `no sheet ${JSON.stringify(wanted)} — the workbook has ${sheets.map((s) => `"${s.name}"`).join(", ")}`,
    );
  }
  const [first, ...rest] = picked.rows;
  if (!first || first.length === 0) {
    return { headers: [], records: [], sheets: sheets.map((s) => s.name), sheet: picked.name };
  }
  // The first row is the header: an import needs names to map by. A file
  // without one maps by index (`0`, `1`, …) — the headers are the indices.
  const looksLikeHeader = first.every((cell) => cell.trim().length > 0 && !/^-?\d+(\.\d+)?$/.test(cell.trim()));
  const headers = looksLikeHeader ? first.map((cell) => cell.trim()) : first.map((_, i) => String(i));
  const data = looksLikeHeader ? rest : picked.rows;
  const records = data.map((row) => {
    const record: Record<string, string> = {};
    headers.forEach((header, i) => {
      record[header] = row[i] ?? "";
    });
    return record;
  });
  return { headers, records, sheets: sheets.map((s) => s.name), sheet: picked.name };
}

function fromJson(text: string): ImportTable {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("the file is not valid JSON");
  }
  // Accept an array at the top, or the first array-valued property of an object.
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object"
      ? Object.values(parsed as Record<string, unknown>).find((value) => Array.isArray(value))
      : undefined;
  if (!Array.isArray(list)) throw new Error("the JSON holds no array of records");
  const headers: string[] = [];
  const seen = new Set<string>();
  const records: Record<string, string>[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record: Record<string, string> = {};
    for (const [key, value] of Object.entries(item as Record<string, unknown>)) {
      if (!seen.has(key)) {
        seen.add(key);
        headers.push(key);
      }
      record[key] =
        value == null
          ? ""
          : Array.isArray(value)
            ? value.map((v) => String(v)).join(", ")
            : typeof value === "object"
              ? JSON.stringify(value)
              : String(value);
    }
    records.push(record);
  }
  return { headers, records, sheets: ["records"], sheet: "records" };
}

/** Read a document's records for import. Throws with a plain reason when it cannot. */
export function readImportTable(
  bytes: Buffer,
  format: DocumentFormat,
  options: { sheet?: string | number } = {},
): ImportTable {
  switch (format) {
    case "csv":
      return fromSheets([{ name: "Sheet1", rows: parseDelimited(decodeText(bytes), ",") }], options.sheet);
    case "tsv":
      return fromSheets([{ name: "Sheet1", rows: parseDelimited(decodeText(bytes), "\t") }], options.sheet);
    case "xlsx":
      return fromSheets(readXlsx(bytes), options.sheet);
    case "json":
      return fromJson(decodeText(bytes));
    case "txt":
    case "md":
      throw new Error(`a ${format.toUpperCase()} file has no columns to import`);
  }
}

/**
 * Which file column each collection column reads from. An explicit mapping
 * wins (by header name, or 0-based index); otherwise a column takes the
 * header equal to its key or its label, case-insensitively. Returns the
 * columns left unmapped too, so the caller can say what will stay empty.
 */
export function resolveMapping(
  columns: readonly CollectionColumn[],
  headers: readonly string[],
  mapping: Record<string, string | number> = {},
): { byColumn: Map<string, string>; unmapped: string[]; unknown: string[] } {
  const byColumn = new Map<string, string>();
  const unknown: string[] = [];
  const lower = new Map(headers.map((header) => [header.toLowerCase(), header]));
  for (const column of columns) {
    const wanted = mapping[column.key];
    if (wanted !== undefined) {
      const header = typeof wanted === "number" ? headers[wanted] : lower.get(wanted.toLowerCase());
      if (header === undefined) unknown.push(`${column.key} -> ${JSON.stringify(wanted)}`);
      else byColumn.set(column.key, header);
      continue;
    }
    const guess = lower.get(column.key.toLowerCase()) ?? lower.get(column.label.toLowerCase());
    if (guess !== undefined) byColumn.set(column.key, guess);
  }
  const unmapped = columns.filter((column) => !byColumn.has(column.key)).map((column) => column.key);
  return { byColumn, unmapped, unknown };
}
