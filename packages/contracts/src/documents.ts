/**
 * Documents on the wire: which files a transport forwards as the `document`
 * media kind, and how large one may be. A document is a text-like file a
 * person sends in a chat — a CSV export, a JSON dump, a spreadsheet, notes —
 * that the core keeps whole (bytes retained, never described by the vision
 * model) so an assistant can read it page by page and import it (user
 * decision, 2026-09-08). Anything else a platform calls an attachment is not
 * media here: a transport names it in the message text and forwards nothing.
 *
 * The predicate and the cap live in the contract, not in a core setting,
 * because a transport must know both BEFORE it downloads: it decides what to
 * forward and how much to pull into memory on its own side, and the core
 * refuses the same things again on ingest. One definition, read by both.
 */

/** The media kind a text-like file travels as. */
export const DOCUMENT_MEDIA_KIND = "document";

/** Hard cap on a document's bytes — a storage guard, the same on every side. */
export const DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;

/** The formats a document may have — what the core knows how to read. */
export const DOCUMENT_FORMATS = ["csv", "tsv", "json", "xlsx", "txt", "md"] as const;

export type DocumentFormat = (typeof DOCUMENT_FORMATS)[number];

/** Mime types that name a format outright; a platform may send any of these. */
const MIME_FORMATS: Record<string, DocumentFormat> = {
  "text/csv": "csv",
  "application/csv": "csv",
  "text/tab-separated-values": "tsv",
  "text/tsv": "tsv",
  "application/json": "json",
  "text/json": "json",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/x-markdown": "md",
};

/** Extensions that name a format when the mime type does not (or lies). */
const EXTENSION_FORMATS: Record<string, DocumentFormat> = {
  csv: "csv",
  tsv: "tsv",
  json: "json",
  xlsx: "xlsx",
  txt: "txt",
  md: "md",
  markdown: "md",
};

/** The extension of a filename, lowercased, or null when it has none. */
export function documentExtension(filename: string | null | undefined): string | null {
  if (!filename) return null;
  const dot = filename.lastIndexOf(".");
  if (dot <= 0 || dot === filename.length - 1) return null;
  return filename.slice(dot + 1).toLowerCase();
}

/**
 * The format a file is, judged from its filename first and its mime type
 * second — or null when it is not a document this contract carries. The
 * extension wins because platforms guess mime types loosely (`text/plain` for
 * a `.csv`, `application/octet-stream` for anything they do not recognize),
 * while the name is what the person chose.
 */
export function documentFormatOf(file: {
  filename?: string | null;
  mimeType?: string | null;
}): DocumentFormat | null {
  const extension = documentExtension(file.filename);
  if (extension && EXTENSION_FORMATS[extension]) return EXTENSION_FORMATS[extension];
  const mime = (file.mimeType ?? "").split(";")[0].trim().toLowerCase();
  return MIME_FORMATS[mime] ?? null;
}

/** Whether a file is a document this contract carries. */
export function isDocumentFile(file: { filename?: string | null; mimeType?: string | null }): boolean {
  return documentFormatOf(file) !== null;
}
