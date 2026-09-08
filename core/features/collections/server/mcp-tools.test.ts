import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api-error";
import { runWithToolContext } from "@/server/mcp/context";

import type { Collection } from "../types";
import {
  COLLECTION_IMPORT_TOOL,
  COLLECTIONS_CREATE_TOOL,
  COLLECTIONS_TOOL_NAMES,
  ROWS_ADD_TOOL,
  ROWS_GET_TOOL,
  ROWS_QUERY_TOOL,
  collectionsScopeFacts,
  collectionsToolOffered,
  registerCollectionsMcpTools,
} from "./mcp-tools";

/**
 * The toolkit's contract around the service: the offer rule (create always,
 * the rest once the assistant has a collection), the rights the turn hands
 * the service (the sender's stamp or a task's lent authority), the
 * provenance a row is written with, and that a service refusal reaches the
 * model as a plain error. The rights themselves are enforced in the service
 * and integration-tested against a real database.
 */

vi.mock("./service", () => ({
  addRowService: vi.fn(),
  assistantHasCollections: vi.fn(),
  createCollectionService: vi.fn(),
  editCollectionService: vi.fn(),
  editRowService: vi.fn(),
  getRowService: vi.fn(),
  importRowsService: vi.fn(),
  queryRowsService: vi.fn(),
  removeCollectionService: vi.fn(),
  removeRowService: vi.fn(),
}));
vi.mock("@/features/documents/server/service", () => ({ getDocument: vi.fn() }));

const service = vi.mocked(await import("./service"));
const documents = vi.mocked(await import("@/features/documents/server/service"));

function collection(over: Partial<Collection> = {}): Collection {
  return {
    id: "c1",
    assistantId: "assistant-1",
    name: "Watchlist",
    description: "",
    visibility: "private",
    fillInstruction: "",
    presentationInstruction: "",
    columns: [
      { key: "url", label: "URL", type: "url", isKey: true, requiredForComplete: true },
      { key: "title", label: "Title", type: "text", isKey: false, requiredForComplete: true },
    ],
    rowCount: 0,
    gapCount: 0,
    createdAt: "2026-09-08T00:00:00.000Z",
    updatedAt: "2026-09-08T00:00:00.000Z",
    ...over,
  };
}

type ToolResult = {
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

type Registered = {
  config: { description: string; inputSchema: Record<string, unknown> };
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
};

function tools(): Record<string, Registered> {
  const registered: Record<string, Registered> = {};
  const server = {
    registerTool: (name: string, config: unknown, handler: unknown) => {
      registered[name] = { config, handler } as Registered;
    },
  } as unknown as McpServer;
  registerCollectionsMcpTools(server);
  return registered;
}

const owner = { source: "acme" as const, chatId: "100", assistantId: "assistant-1", userId: "7", senderIsOwner: true };
const guest = { source: "acme" as const, chatId: "100", assistantId: "assistant-1", userId: "8" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("registration and offer rule", () => {
  it("registers every declared tool, each with a description", () => {
    const registered = tools();
    expect(Object.keys(registered).sort()).toEqual([...COLLECTIONS_TOOL_NAMES].sort());
    for (const tool of Object.values(registered)) expect(tool.config.description.length).toBeGreaterThan(40);
  });

  it("offers the create tool always and the rest only to an assistant with a collection", () => {
    for (const name of COLLECTIONS_TOOL_NAMES) {
      expect(collectionsToolOffered(name, { assistantId: "assistant-1", assistantHasCollections: true })).toBe(true);
      expect(collectionsToolOffered(name, { assistantId: "assistant-1", assistantHasCollections: false })).toBe(
        name === COLLECTIONS_CREATE_TOOL,
      );
      expect(collectionsToolOffered(name, {})).toBe(name === COLLECTIONS_CREATE_TOOL);
    }
  });

  it("resolves the fact from the service, and reads false without an assistant or on a failing read", async () => {
    service.assistantHasCollections.mockResolvedValue(true);
    expect(await collectionsScopeFacts({ assistantId: "assistant-1" })).toEqual({ assistantHasCollections: true });
    expect(await collectionsScopeFacts({})).toEqual({ assistantHasCollections: false });
    service.assistantHasCollections.mockRejectedValue(new Error("db down"));
    expect(await collectionsScopeFacts({ assistantId: "assistant-1" })).toEqual({ assistantHasCollections: false });
  });
});

describe("rights and provenance", () => {
  it("hands the service the sender's owner stamp and the chat's provenance on a row write", async () => {
    service.addRowService.mockResolvedValue({
      row: { id: "r1", collectionId: "c1", keyValue: "https://x.y/1", values: { url: "https://x.y/1", title: null }, complete: false, gaps: ["title"], createdByUserRef: "acme:user:7", originChatRef: "acme:chat:100", sourceDocumentRef: null, createdAt: "", updatedAt: "" },
      created: true,
    });

    const result = await runWithToolContext({ ...owner, correlationId: "acme:chat:100:41" }, () =>
      tools()[ROWS_ADD_TOOL].handler({ collection_id: "c1", values: { url: "https://x.y/1" } }),
    );

    expect(service.addRowService).toHaveBeenCalledWith(
      "c1",
      { url: "https://x.y/1" },
      expect.objectContaining({
        access: { kind: "chat", assistantId: "assistant-1", ownerRights: true },
        provenance: { createdByUserRef: "acme:user:7", originChatRef: "acme:chat:100" },
        trigger: expect.objectContaining({ kind: "transport", actor: "acme:user:7", correlationId: "acme:chat:100:41" }),
      }),
    );
    expect(result.content[0].text).toContain("Added: r1");
    expect(result.content[0].text).toContain("[gaps: title]");
    expect(result.structuredContent).toMatchObject({ id: "r1", created: true, gaps: ["title"] });
  });

  it("lends a standing task's authority as owner rights", async () => {
    service.queryRowsService.mockResolvedValue({ rows: [], offset: 0, limit: 20, total: 0, hasMore: false, semantic: false });
    await runWithToolContext({ ...guest, authorityIsOwner: true }, () =>
      tools()[ROWS_QUERY_TOOL].handler({ collection_id: "c1" }),
    );
    expect(service.queryRowsService).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({ gaps: false, offset: 0, limit: 20 }),
      { kind: "chat", assistantId: "assistant-1", ownerRights: true },
    );
  });

  it("relays a service refusal as a tool error the model can read", async () => {
    service.createCollectionService.mockRejectedValue(ApiError.forbidden("Only the assistant's owner can change its collections"));
    const result = await runWithToolContext(guest, () =>
      tools()[COLLECTIONS_CREATE_TOOL].handler({
        name: "Watchlist",
        columns: [{ key: "url", type: "url", is_key: true }],
      }),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("owner");
  });

  it("refuses a turn without an assistant before touching the service", async () => {
    const result = await runWithToolContext({ source: "acme", chatId: "100" }, () =>
      tools()[ROWS_GET_TOOL].handler({ collection_id: "c1", key: "https://x.y/1" }),
    );
    expect(result.isError).toBe(true);
    expect(service.getRowService).not.toHaveBeenCalled();
  });

  it("maps the tool's column shape onto the service's", async () => {
    service.createCollectionService.mockResolvedValue(collection());
    await runWithToolContext(owner, () =>
      tools()[COLLECTIONS_CREATE_TOOL].handler({
        name: "Watchlist",
        visibility: "shared",
        columns: [
          { key: "url", type: "url", is_key: true, required_for_complete: true },
          { key: "kind", type: "enum", options: ["Movie"] },
        ],
      }),
    );
    expect(service.createCollectionService).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Watchlist",
        visibility: "shared",
        columns: [
          expect.objectContaining({ key: "url", isKey: true, requiredForComplete: true }),
          expect.objectContaining({ key: "kind", options: ["Movie"], isKey: false, requiredForComplete: false }),
        ],
      }),
      { kind: "chat", assistantId: "assistant-1", ownerRights: true },
      expect.anything(),
    );
  });
});

describe("import", () => {
  const stored = (source = "acme", chatId = "100") =>
    ({
      record: { id: "doc-1", source, chatId, kind: "document", filename: "watchlist.csv", description: "watchlist.csv (CSV, 1 KB)" },
      bytes: Buffer.from("url,title\nhttps://x.y/1,Heat\n"),
      format: "csv",
    }) as never;

  it("reads only this conversation's document and hands the service the file with its ref", async () => {
    documents.getDocument.mockResolvedValue(stored());
    service.importRowsService.mockResolvedValue({ collectionId: "c1", inserted: 1, updated: 0, skipped: [], total: 1 });

    const result = await runWithToolContext(owner, () =>
      tools()[COLLECTION_IMPORT_TOOL].handler({ document_id: "doc-1", collection_id: "c1" }),
    );

    expect(service.importRowsService).toHaveBeenCalledWith(
      { collectionId: "c1", proposal: undefined, mapping: {}, sheet: undefined },
      expect.objectContaining({ ref: "acme:document:doc-1", label: "watchlist.csv (CSV, 1 KB)", format: "csv" }),
      expect.objectContaining({ access: expect.objectContaining({ ownerRights: true }) }),
    );
    expect(result.content[0].text).toContain("1 added, 0 updated, 0 skipped of 1");
  });

  it("answers 'not in this conversation' for a document of another chat", async () => {
    documents.getDocument.mockResolvedValue(stored("acme", "999"));
    const result = await runWithToolContext(owner, () =>
      tools()[COLLECTION_IMPORT_TOOL].handler({ document_id: "doc-1", collection_id: "c1" }),
    );
    expect(result.isError).toBe(true);
    expect(service.importRowsService).not.toHaveBeenCalled();
  });

  it("needs exactly one of an existing collection and a proposal", async () => {
    const result = await runWithToolContext(owner, () =>
      tools()[COLLECTION_IMPORT_TOOL].handler({ document_id: "doc-1" }),
    );
    expect(result.isError).toBe(true);
    expect(documents.getDocument).not.toHaveBeenCalled();
  });
});
