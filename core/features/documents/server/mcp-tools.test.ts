import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { runWithToolContext } from "@/server/mcp/context";

import { READ_DOCUMENT_TOOL, registerDocumentsMcpTools, renderWindow } from "./mcp-tools";

/**
 * The document tool's boundary: it reads only documents of the bound
 * conversation, pages a tabular file by rows and a text file by characters,
 * and turns an unreadable file into an honest error rather than a guess.
 */

vi.mock("./service", () => ({ getDocument: vi.fn() }));
const service = vi.mocked(await import("./service"));

type ToolArgs = { document_id: string; offset?: number; limit?: number; sheet?: string | number };
type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function handler() {
  let registered: ((args: ToolArgs) => Promise<ToolResult>) | null = null;
  let description = "";
  const server = {
    registerTool: (_name: string, config: { description: string }, fn: unknown) => {
      registered = fn as (args: ToolArgs) => Promise<ToolResult>;
      description = config.description;
    },
  } as unknown as McpServer;
  registerDocumentsMcpTools(server);
  return { run: registered!, description };
}

function stored(overrides: { source?: string; chatId?: string; filename?: string; bytes?: string } = {}) {
  const filename = overrides.filename ?? "watchlist.csv";
  return {
    record: {
      id: "doc-1",
      source: overrides.source ?? "acme",
      chatId: overrides.chatId ?? "42",
      kind: "document",
      filename,
      mimeType: "text/csv",
      description: `${filename} (CSV, 1 KB)`,
      dataBase64: "",
    },
    bytes: Buffer.from(overrides.bytes ?? "title,year\nHeat,1995\nInception,2010\n"),
    format: filename.endsWith(".xlsx") ? "xlsx" : "csv",
  } as never;
}

const inChat = <T>(fn: () => Promise<T>, chatId = "42") =>
  runWithToolContext({ source: "acme", chatId, assistantId: "asst-1" }, fn);

beforeEach(() => {
  vi.clearAllMocks();
});

describe(`${READ_DOCUMENT_TOOL} scope`, () => {
  it("reads a document of the bound conversation", async () => {
    service.getDocument.mockResolvedValue(stored());
    const { run } = handler();
    const result = await inChat(() => run({ document_id: "doc-1" }));
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      ok: true,
      format: "csv",
      shape: "rows",
      header: ["title", "year"],
      rows: [
        ["Heat", "1995"],
        ["Inception", "2010"],
      ],
      total: 2,
      has_more: false,
    });
    expect(result.content[0].text).toContain("watchlist.csv (CSV, 1 KB)");
    expect(result.content[0].text).toContain("header: title | year");
  });

  it("answers 'not here' for another chat's document, an unknown id, and another source", async () => {
    const { run } = handler();
    service.getDocument.mockResolvedValue(stored({ chatId: "99" }));
    expect(await inChat(() => run({ document_id: "doc-1" }))).toMatchObject({ isError: true });
    service.getDocument.mockResolvedValue(null);
    expect(await inChat(() => run({ document_id: "nope" }))).toMatchObject({ isError: true });
    service.getDocument.mockResolvedValue(stored({ source: "other" }));
    const result = await inChat(() => run({ document_id: "doc-1" }));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("No document with that id in this conversation");
  });

  it("pages rows by offset and says where to continue", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => `Film ${i + 1},${2000 + i}`).join("\n");
    service.getDocument.mockResolvedValue(stored({ bytes: `title,year\n${rows}\n` }));
    const { run } = handler();
    const result = await inChat(() => run({ document_id: "doc-1", offset: 2, limit: 2 }));
    expect(result.structuredContent).toMatchObject({
      offset: 2,
      total: 5,
      has_more: true,
      rows: [
        ["Film 3", "2002"],
        ["Film 4", "2003"],
      ],
    });
    expect(result.content[0].text).toContain("rows 3-4 of 5");
    expect(result.content[0].text).toContain("continue at offset 4");
  });

  it("turns a file that is not what its format says into an honest error", async () => {
    service.getDocument.mockResolvedValue(stored({ filename: "sheet.xlsx", bytes: "not a zip" }));
    const { run } = handler();
    const result = await inChat(() => run({ document_id: "doc-1" }));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("could not be read as XLSX");
  });
});

describe(`${READ_DOCUMENT_TOOL} description`, () => {
  it("tells the model where ids come from and how to page, naming no other tool", () => {
    const { description } = handler();
    expect(description).toContain("[document: <name>, id <id>]");
    expect(description).toContain("'offset'");
    expect(description).toContain("'has_more'");
    expect(description).toContain("never guess its content");
    expect(description).not.toMatch(/start_agent|rows_query|collection/);
  });
});

describe("renderWindow", () => {
  it("renders a text window with its range and continuation", () => {
    const text = renderWindow("notes.md (MD, 20 B)", {
      shape: "text",
      format: "md",
      text: "# Hi",
      offset: 0,
      totalChars: 20,
      hasMore: true,
    });
    expect(text).toContain("characters 0-4 of 20");
    expect(text).toContain("continue at offset 4");
    expect(text.endsWith("# Hi")).toBe(true);
  });

  it("names the sheet when a workbook has several, and an empty sheet honestly", () => {
    const text = renderWindow("sheet.xlsx (XLSX, 9 KB)", {
      shape: "rows",
      format: "xlsx",
      sheets: ["A", "B"],
      sheet: "B",
      header: null,
      rows: [],
      offset: 0,
      totalRows: 0,
      hasMore: false,
    });
    expect(text).toContain('sheet "B" of "A", "B"');
    expect(text).toContain("no data rows");
  });
});
