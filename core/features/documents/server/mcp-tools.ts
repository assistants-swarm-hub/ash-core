import "server-only";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { getToolContext } from "@/server/mcp/context";

import {
  MAX_CHARS_PER_WINDOW,
  MAX_ROWS_PER_WINDOW,
  readDocumentWindow,
  type DocumentWindow,
} from "../read";
import { getDocument } from "./service";

/**
 * The document tool: how an assistant reads a file someone sent in the chat.
 * A document is kept whole and never described, so its content reaches the
 * model only through this call — in windows, because a CSV export or a
 * workbook is far larger than one turn should hold. The tool reads only
 * documents of the bound conversation: a document is that chat's data, and
 * an id from elsewhere answers "not in this conversation", which is all a
 * model may learn about it.
 */

export const READ_DOCUMENT_TOOL = "read_document";

export const DOCUMENTS_TOOL_NAMES = [READ_DOCUMENT_TOOL];

const READ_DOCUMENT_DESCRIPTION =
  "Read a document someone sent in this conversation — a CSV, TSV, JSON, XLSX, TXT or MD file. " +
  "Documents appear in the transcript as [document: <name>, id <id>]; pass that id. A tabular " +
  "file (CSV, TSV, XLSX) answers with its header and a window of data rows — default 50, at most " +
  `${MAX_ROWS_PER_WINDOW} — plus the total row count, so page with 'offset' until 'has_more' is ` +
  "false; a workbook lists its sheets and reads one at a time ('sheet' by name or index). A text " +
  `file (JSON, TXT, MD) answers with a window of characters — default 6000, at most ${MAX_CHARS_PER_WINDOW} — ` +
  "plus the total length. Read a file before saying what it contains; never guess its content " +
  "from its name or its size.";

const NOT_HERE =
  "No document with that id in this conversation. Documents you can read appear in the " +
  "transcript as [document: <name>, id <id>].";

function refusal(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true as const };
}

/** The window as the model reads it: a compact text rendering plus the structured form. */
export function renderWindow(label: string, window: DocumentWindow): string {
  if (window.shape === "text") {
    const end = window.offset + window.text.length;
    const range = `characters ${window.offset}-${end} of ${window.totalChars}`;
    const more = window.hasMore ? ` (more follows — continue at offset ${end})` : "";
    return `${label} — ${range}${more}\n\n${window.text}`;
  }
  const first = window.offset + 1;
  const last = window.offset + window.rows.length;
  const sheet =
    window.sheets.length > 1
      ? ` — sheet "${window.sheet}" of ${window.sheets.map((name) => `"${name}"`).join(", ")}`
      : "";
  const range =
    window.totalRows === 0
      ? "no data rows"
      : `rows ${first}-${last} of ${window.totalRows}`;
  const more = window.hasMore ? ` (more follows — continue at offset ${last})` : "";
  const lines: string[] = [`${label}${sheet} — ${range}${more}`];
  if (window.header) lines.push(`header: ${window.header.join(" | ")}`);
  window.rows.forEach((row, i) => lines.push(`${first + i}: ${row.join(" | ")}`));
  return lines.join("\n");
}

/** Register the document tool on the shared server. */
export function registerDocumentsMcpTools(server: McpServer): void {
  server.registerTool(
    READ_DOCUMENT_TOOL,
    {
      title: "Read a document from this conversation",
      description: READ_DOCUMENT_DESCRIPTION,
      inputSchema: {
        document_id: z
          .string()
          .min(1)
          .describe("The document's id, exactly as the transcript shows it after 'id'."),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            "Where the window starts: a 0-based data-row index for a tabular file, a 0-based character offset for a text file. Default 0.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            `How much to read: rows for a tabular file (at most ${MAX_ROWS_PER_WINDOW}), characters for a text file (at most ${MAX_CHARS_PER_WINDOW}).`,
          ),
        sheet: z
          .union([z.string(), z.number().int().min(0)])
          .optional()
          .describe("For a workbook: the sheet to read, by name or 0-based index. Default: the first."),
      },
      outputSchema: {
        ok: z.boolean(),
        format: z.string().optional(),
        shape: z.enum(["rows", "text"]).optional(),
        offset: z.number().optional(),
        total: z.number().optional(),
        has_more: z.boolean().optional(),
        sheets: z.array(z.string()).optional(),
        sheet: z.string().optional(),
        header: z.array(z.string()).nullable().optional(),
        rows: z.array(z.array(z.string())).optional(),
        text: z.string().optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ document_id, offset, limit, sheet }) => {
      const ctx = getToolContext();
      const document = await getDocument(document_id).catch(() => null);
      // A document belongs to the conversation it was sent in; an id from
      // elsewhere reads as unknown, never as forbidden.
      if (
        !document ||
        document.record.source !== ctx.source ||
        document.record.chatId !== ctx.chatId
      ) {
        return refusal(NOT_HERE);
      }
      let window: DocumentWindow;
      try {
        window = readDocumentWindow(document.bytes, document.format, { offset, limit, sheet });
      } catch (err) {
        return refusal(
          `The document could not be read as ${document.format.toUpperCase()}: ${err instanceof Error ? err.message : String(err)}.`,
        );
      }
      const label = document.record.description ?? document.record.filename ?? "document";
      const structured =
        window.shape === "rows"
          ? {
              ok: true,
              format: window.format,
              shape: "rows" as const,
              offset: window.offset,
              total: window.totalRows,
              has_more: window.hasMore,
              sheets: window.sheets,
              sheet: window.sheet,
              header: window.header,
              rows: window.rows,
            }
          : {
              ok: true,
              format: window.format,
              shape: "text" as const,
              offset: window.offset,
              total: window.totalChars,
              has_more: window.hasMore,
              text: window.text,
            };
      return {
        content: [{ type: "text" as const, text: renderWindow(label, window) }],
        structuredContent: structured,
      };
    },
  );
}
