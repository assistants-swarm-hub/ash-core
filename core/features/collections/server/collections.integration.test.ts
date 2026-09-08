import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api-error";
import { resetEnvCache } from "@/server/env";
import { closeStorePool } from "@/server/store/db";
import { listTraces } from "@/server/trace";
import { startTestStoreDb, type TestStoreDb } from "@/test/store-db";

import { MAX_COLLECTIONS_PER_ASSISTANT } from "../types";
import {
  addRowService,
  assistantHasCollections,
  createCollectionService,
  editCollectionService,
  editRowService,
  exportCollectionCsv,
  getRowService,
  getVisibleCollections,
  importRowsService,
  queryRowsService,
  removeCollectionService,
  removeRowService,
  type CollectionAccess,
} from "./service";

/**
 * Collections against a real database: the rights gates (private is
 * invisible without owner rights, every write needs them), identity by key
 * (a repeat updates), typed refusals, completeness and gap counts, the
 * structured query (filters, gaps, sort, paging, substring text), column
 * reshaping, the caps, and a document import with skips and merges. No
 * embedding model is configured here, so every query is the lexical path.
 */

let ctx: TestStoreDb;

beforeAll(async () => {
  ctx = await startTestStoreDb();
  process.env.DATABASE_URL = ctx.connectionUri;
  resetEnvCache();
});

afterAll(async () => {
  await closeStorePool();
  await ctx?.stop();
});

beforeEach(async () => {
  await ctx.truncate();
  await ctx.pool.query(
    `INSERT INTO assistants (id, name, persona) VALUES ('assistant-1', 'Fixture Assistant', ''), ('assistant-2', 'Other Assistant', '')`,
  );
});

const dashboard: CollectionAccess = { kind: "dashboard" };
const owner: CollectionAccess = { kind: "chat", assistantId: "assistant-1", ownerRights: true };
const guest: CollectionAccess = { kind: "chat", assistantId: "assistant-1", ownerRights: false };
const otherAssistant: CollectionAccess = { kind: "chat", assistantId: "assistant-2", ownerRights: true };
const trigger = { kind: "dashboard" } as const;
const chatTrigger = { kind: "transport", actor: "acme:user:7", correlationId: "acme:chat:100:1" } as const;

const COLUMNS = [
  { key: "url", type: "url" as const, isKey: true, requiredForComplete: true },
  { key: "title", type: "text" as const, isKey: false, requiredForComplete: true },
  { key: "year", type: "number" as const, isKey: false, requiredForComplete: false },
  { key: "genres", type: "list" as const, isKey: false, requiredForComplete: false },
  { key: "kind", type: "enum" as const, options: ["Movie", "Series"], isKey: false, requiredForComplete: false },
  { key: "my_rating", type: "rating" as const, scale: 10, isKey: false, requiredForComplete: false },
  { key: "seen", type: "boolean" as const, isKey: false, requiredForComplete: false },
];

function create(over: Record<string, unknown> = {}, access: CollectionAccess = owner) {
  return createCollectionService(
    { name: "Watchlist", columns: COLUMNS, ...over } as Parameters<typeof createCollectionService>[0],
    access,
    access.kind === "dashboard" ? trigger : chatTrigger,
    ctx.db,
  );
}

const film = (n: number, over: Record<string, unknown> = {}) => ({
  url: `https://x.y/title/tt${n}`,
  title: `Film ${n}`,
  year: 1990 + n,
  ...over,
});

describe("collections", () => {
  it("creates one for the turn's assistant, traced and related", async () => {
    const created = await create();
    expect(created).toMatchObject({ assistantId: "assistant-1", name: "Watchlist", visibility: "private", rowCount: 0 });
    expect(created.columns.find((c) => c.isKey)?.key).toBe("url");
    expect(await assistantHasCollections("assistant-1", ctx.db)).toBe(true);
    expect(await assistantHasCollections("assistant-2", ctx.db)).toBe(false);
    const { traces } = await listTraces({ feature: "collections", relatedId: created.id });
    expect(traces.map((t) => t.action)).toContain("create");
  });

  it("refuses a duplicate name per assistant, a bad column list, and a guest creating", async () => {
    await create();
    await expect(create({ name: "watchlist" })).rejects.toMatchObject({ status: 409 });
    await expect(create({ name: "Bad", columns: [{ key: "a", type: "text" }] })).rejects.toMatchObject({ status: 400 });
    await expect(create({ name: "Guest" }, guest)).rejects.toMatchObject({ status: 403 });
    // Another assistant may use the same name.
    await expect(create({}, otherAssistant)).resolves.toMatchObject({ assistantId: "assistant-2" });
  });

  it("caps collections per assistant", async () => {
    for (let i = 0; i < MAX_COLLECTIONS_PER_ASSISTANT; i++) await create({ name: `C${i}` });
    await expect(create({ name: "One more" })).rejects.toMatchObject({ status: 400 });
  });

  it("hides a private collection from a guest and shows a shared one read-only", async () => {
    const priv = await create({ name: "Private" });
    const shared = await create({ name: "Shared", visibility: "shared" });
    expect((await getVisibleCollections({ kind: "chat", assistantId: "assistant-1", ownerRights: false }, ctx.db)).map((c) => c.id)).toEqual([shared.id]);
    expect((await getVisibleCollections({ kind: "chat", assistantId: "assistant-1", ownerRights: true }, ctx.db)).map((c) => c.id)).toEqual([priv.id, shared.id]);
    // Reads: the private one is unknown to a guest, the shared one readable.
    await expect(queryRowsService(priv.id, query(), guest, ctx.db)).rejects.toMatchObject({ status: 404 });
    await expect(queryRowsService(shared.id, query(), guest, ctx.db)).resolves.toMatchObject({ total: 0 });
    // Writes on the shared one still need owner rights; another assistant sees nothing.
    await expect(addRowService(shared.id, film(1), { access: guest, trigger: chatTrigger }, ctx.db)).rejects.toMatchObject({ status: 403 });
    await expect(queryRowsService(shared.id, query(), otherAssistant, ctx.db)).rejects.toMatchObject({ status: 404 });
  });

  it("updates texts and visibility; a column change reshapes the rows and the key is pinned while rows exist", async () => {
    const created = await create();
    await addRowService(created.id, film(1, { genres: ["Crime"] }), { access: owner, trigger: chatTrigger }, ctx.db);
    const renamed = await editCollectionService(created.id, { name: "Films", visibility: "shared", fillInstruction: "Look it up." }, owner, chatTrigger, ctx.db);
    expect(renamed).toMatchObject({ name: "Films", visibility: "shared", fillInstruction: "Look it up.", rowCount: 1 });
    // Drop `genres`, require `year`: the row loses the cell and becomes incomplete.
    const reshaped = await editCollectionService(
      created.id,
      { columns: COLUMNS.filter((c) => c.key !== "genres").map((c) => (c.key === "year" ? { ...c, requiredForComplete: true } : c)) },
      owner,
      chatTrigger,
      ctx.db,
    );
    expect(reshaped.columns.map((c) => c.key)).not.toContain("genres");
    const row = await getRowService(created.id, { key: "https://x.y/title/tt1" }, owner, ctx.db);
    expect(row.values).not.toHaveProperty("genres");
    expect(row.complete).toBe(true);
    await expect(
      editCollectionService(created.id, { columns: COLUMNS.map((c) => ({ ...c, isKey: c.key === "title" })) }, owner, chatTrigger, ctx.db),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("deletes a collection with its rows", async () => {
    const created = await create();
    await addRowService(created.id, film(1), { access: owner, trigger: chatTrigger }, ctx.db);
    await removeCollectionService(created.id, owner, chatTrigger, ctx.db);
    expect(await assistantHasCollections("assistant-1", ctx.db)).toBe(false);
    expect((await ctx.pool.query(`select count(*)::int as n from collection_rows`)).rows[0].n).toBe(0);
  });
});

function query(over: Record<string, unknown> = {}) {
  return { filters: [], gaps: false, direction: "asc" as const, offset: 0, limit: 20, ...over };
}

describe("rows", () => {
  it("adds by key, updates on a repeated key, and keeps provenance", async () => {
    const created = await create();
    const provenance = { createdByUserRef: "acme:user:7", originChatRef: "acme:chat:100" };
    const first = await addRowService(created.id, film(1), { access: owner, provenance, trigger: chatTrigger }, ctx.db);
    expect(first.created).toBe(true);
    expect(first.row).toMatchObject({ keyValue: "https://x.y/title/tt1", complete: true, gaps: [], ...provenance });
    const again = await addRowService(created.id, { url: "https://x.y/title/tt1", my_rating: 8 }, { access: owner, trigger: chatTrigger }, ctx.db);
    expect(again.created).toBe(false);
    expect(again.row.values).toMatchObject({ title: "Film 1", my_rating: 8 });
    expect((await queryRowsService(created.id, query(), owner, ctx.db)).total).toBe(1);
  });

  it("refuses a bad value with the column named, and an unknown column", async () => {
    const created = await create();
    await expect(addRowService(created.id, film(1, { kind: "Short" }), { access: owner, trigger: chatTrigger }, ctx.db)).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('"kind" must be one of'),
    });
    await expect(addRowService(created.id, film(1, { director: "Mann" }), { access: owner, trigger: chatTrigger }, ctx.db)).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('"director" is not a column'),
    });
    await expect(addRowService(created.id, { title: "No key" }, { access: owner, trigger: chatTrigger }, ctx.db)).rejects.toMatchObject({ status: 400 });
  });

  it("counts gaps, updates by id or key, refuses a key clash, and deletes", async () => {
    const created = await create();
    const { row } = await addRowService(created.id, { url: "https://x.y/title/tt1" }, { access: owner, trigger: chatTrigger }, ctx.db);
    expect(row).toMatchObject({ complete: false, gaps: ["title"] });
    await addRowService(created.id, film(2), { access: owner, trigger: chatTrigger }, ctx.db);
    const visible = await getVisibleCollections({ kind: "chat", assistantId: "assistant-1", ownerRights: true }, ctx.db);
    expect(visible[0]).toMatchObject({ rowCount: 2, gapCount: 1 });
    const filled = await editRowService(created.id, { id: row.id }, { title: "Film 1" }, { access: owner, trigger: chatTrigger }, ctx.db);
    expect(filled).toMatchObject({ complete: true, gaps: [] });
    await expect(
      editRowService(created.id, { key: "https://x.y/title/tt1" }, { url: "https://x.y/title/tt2" }, { access: owner, trigger: chatTrigger }, ctx.db),
    ).rejects.toMatchObject({ status: 409 });
    await removeRowService(created.id, { key: "https://x.y/title/tt2" }, { access: owner, trigger: chatTrigger }, ctx.db);
    await expect(getRowService(created.id, { key: "https://x.y/title/tt2" }, owner, ctx.db)).rejects.toBeInstanceOf(ApiError);
    expect((await queryRowsService(created.id, query(), owner, ctx.db)).total).toBe(1);
  });

  it("queries with typed filters, the gaps switch, a sort, text and paging", async () => {
    const created = await create();
    for (let n = 1; n <= 5; n++) {
      await addRowService(
        created.id,
        film(n, { genres: n % 2 ? ["Crime", "Drama"] : ["Comedy"], kind: n <= 3 ? "Movie" : "Series", seen: n === 1, ...(n === 5 ? { title: null } : {}) }),
        { access: owner, trigger: chatTrigger },
        ctx.db,
      );
    }
    const keys = (page: { rows: { keyValue: string }[] }) => page.rows.map((r) => r.keyValue.slice(-3));
    expect(keys(await queryRowsService(created.id, query({ filters: [{ column: "year", op: "gte", value: 1994 }] }), owner, ctx.db))).toEqual(["tt4", "tt5"]);
    expect(keys(await queryRowsService(created.id, query({ filters: [{ column: "kind", op: "eq", value: "series" }] }), owner, ctx.db))).toEqual(["tt4", "tt5"]);
    expect(keys(await queryRowsService(created.id, query({ filters: [{ column: "genres", op: "contains", value: "com" }] }), owner, ctx.db))).toEqual(["tt2", "tt4"]);
    expect(keys(await queryRowsService(created.id, query({ filters: [{ column: "genres", op: "eq", value: "Crime" }] }), owner, ctx.db))).toEqual(["tt1", "tt3", "tt5"]);
    expect(keys(await queryRowsService(created.id, query({ filters: [{ column: "seen", op: "eq", value: true }] }), owner, ctx.db))).toEqual(["tt1"]);
    expect(keys(await queryRowsService(created.id, query({ filters: [{ column: "title", op: "empty" }] }), owner, ctx.db))).toEqual(["tt5"]);
    expect(keys(await queryRowsService(created.id, query({ gaps: true }), owner, ctx.db))).toEqual(["tt5"]);
    expect(keys(await queryRowsService(created.id, query({ sort: "year", direction: "desc", limit: 2 }), owner, ctx.db))).toEqual(["tt5", "tt4"]);
    const page = await queryRowsService(created.id, query({ query: "film 3" }), owner, ctx.db);
    expect(page).toMatchObject({ total: 1, semantic: false });
    expect(keys(page)).toEqual(["tt3"]);
    const second = await queryRowsService(created.id, query({ offset: 3, limit: 2 }), owner, ctx.db);
    expect(second).toMatchObject({ total: 5, hasMore: false, offset: 3 });
    expect(keys(second)).toEqual(["tt4", "tt5"]);
    await expect(queryRowsService(created.id, query({ filters: [{ column: "director", op: "eq", value: "x" }] }), owner, ctx.db)).rejects.toMatchObject({ status: 400 });
    await expect(queryRowsService(created.id, query({ filters: [{ column: "kind", op: "eq", value: "Short" }] }), owner, ctx.db)).rejects.toMatchObject({ status: 400 });
  });

  it("exports as CSV with the columns as header", async () => {
    const created = await create();
    await addRowService(created.id, film(1, { genres: ["Crime", "Drama"], title: 'He said "hi"' }), { access: owner, trigger: chatTrigger }, ctx.db);
    const { csv } = await exportCollectionCsv(created.id, dashboard, ctx.db);
    expect(csv.split("\r\n")[0]).toBe("url,title,year,genres,kind,my_rating,seen");
    expect(csv.split("\r\n")[1]).toBe('https://x.y/title/tt1,"He said ""hi""",1991,"Crime, Drama",,,');
  });
});

describe("import", () => {
  const source = (text: string, format: "csv" | "json" = "csv") => ({
    ref: "acme:document:doc-1",
    label: "watchlist.csv",
    bytes: Buffer.from(text),
    format,
  });

  it("creates the proposed collection and writes the file's records, skipping what does not fit", async () => {
    const csv =
      "Const,Title,Year,Genres,Title Type,Your Rating\n" +
      "https://x.y/title/tt1,Heat,1995,\"Crime, Drama\",Movie,9\n" +
      "https://x.y/title/tt2,Inception,2010,Sci-Fi,Movie,\n" +
      "not a url,Broken,2000,,Movie,\n" +
      "https://x.y/title/tt1,Heat,1995,\"Crime, Drama\",Movie,10\n";
    const report = await importRowsService(
      {
        proposal: { name: "Watchlist", description: "", visibility: "private", fillInstruction: "", presentationInstruction: "", columns: COLUMNS },
        mapping: { url: "Const", kind: "Title Type", my_rating: "Your Rating" },
      },
      source(csv),
      { access: owner, provenance: { createdByUserRef: "acme:user:7", originChatRef: "acme:chat:100" }, trigger: chatTrigger },
      ctx.db,
    );
    expect(report).toMatchObject({ inserted: 2, updated: 0, total: 4 });
    expect(report.skipped).toEqual([{ row: 3, reason: expect.stringContaining('"url" must be an http(s) URL') }]);
    // The repeat within the file merged: the later rating won.
    const heat = await getRowService(report.collectionId, { key: "https://x.y/title/tt1" }, owner, ctx.db);
    expect(heat).toMatchObject({ values: { title: "Heat", year: 1995, genres: ["Crime", "Drama"], kind: "Movie", my_rating: 10 }, sourceDocumentRef: "acme:document:doc-1", complete: true });
    const visible = await getVisibleCollections({ kind: "chat", assistantId: "assistant-1", ownerRights: true }, ctx.db);
    expect(visible[0]).toMatchObject({ name: "Watchlist", rowCount: 2, gapCount: 0 });
    const { traces } = await listTraces({ feature: "collections", relatedId: report.collectionId });
    expect(traces.map((t) => t.action)).toContain("import");
  });

  it("updates existing rows on a second import without blanking what the file lacks", async () => {
    const created = await create();
    await addRowService(created.id, film(1, { my_rating: 7 }), { access: owner, trigger: chatTrigger }, ctx.db);
    const report = await importRowsService(
      { collectionId: created.id, mapping: {} },
      source("url,title,year\nhttps://x.y/title/tt1,Heat,1995\nhttps://x.y/title/tt2,Inception,2010\n"),
      { access: owner, trigger: chatTrigger },
      ctx.db,
    );
    expect(report).toMatchObject({ inserted: 1, updated: 1, total: 2 });
    const heat = await getRowService(created.id, { key: "https://x.y/title/tt1" }, owner, ctx.db);
    expect(heat.values).toMatchObject({ title: "Heat", year: 1995, my_rating: 7 });
  });

  it("reads a JSON array of records and refuses a mapping onto no key", async () => {
    const created = await create();
    const report = await importRowsService(
      { collectionId: created.id, mapping: {} },
      source(JSON.stringify([{ url: "https://x.y/title/tt9", title: "Nine", genres: ["A", "B"] }]), "json"),
      { access: owner, trigger: chatTrigger },
      ctx.db,
    );
    expect(report).toMatchObject({ inserted: 1 });
    expect((await getRowService(created.id, { key: "https://x.y/title/tt9" }, owner, ctx.db)).values.genres).toEqual(["A", "B"]);
    await expect(
      importRowsService({ collectionId: created.id, mapping: {} }, source("link,title\nhttps://x.y/1,X\n"), { access: owner, trigger: chatTrigger }, ctx.db),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining('key column "url"') });
    await expect(
      importRowsService({ collectionId: created.id, mapping: {} }, source("url,title\n"), { access: guest, trigger: chatTrigger }, ctx.db),
    ).rejects.toMatchObject({ status: 403 });
  });
});
