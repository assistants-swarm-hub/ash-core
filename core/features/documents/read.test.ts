import { describe, expect, it } from "vitest";

import {
  DEFAULT_CHARS_PER_WINDOW,
  DEFAULT_ROWS_PER_WINDOW,
  MAX_CHARS_PER_WINDOW,
  MAX_ROWS_PER_WINDOW,
  readDocumentWindow,
} from "./read";
import { buildWorkbook } from "./test-workbook";

/**
 * Windows over a document: rows with a header for the tabular formats, a
 * character range for the text ones, always with the total and whether more
 * follows — what lets a caller page through a file larger than one turn.
 */

const csv = (rows: number) =>
  Buffer.from(["title,year", ...Array.from({ length: rows }, (_, i) => `Film ${i + 1},${1990 + i}`)].join("\n"));

describe("readDocumentWindow — tabular", () => {
  it("reads a CSV with its header, the default window, and the total", () => {
    const window = readDocumentWindow(csv(3), "csv");
    expect(window).toMatchObject({
      shape: "rows",
      format: "csv",
      header: ["title", "year"],
      rows: [
        ["Film 1", "1990"],
        ["Film 2", "1991"],
        ["Film 3", "1992"],
      ],
      offset: 0,
      totalRows: 3,
      hasMore: false,
    });
  });

  it("pages by data-row offset and reports when more follows", () => {
    const first = readDocumentWindow(csv(120), "csv", { limit: 50 });
    expect(first.shape).toBe("rows");
    if (first.shape !== "rows") return;
    expect(first.rows).toHaveLength(50);
    expect(first.hasMore).toBe(true);
    const last = readDocumentWindow(csv(120), "csv", { offset: 100, limit: 50 });
    if (last.shape !== "rows") return;
    expect(last.rows).toHaveLength(20);
    expect(last.rows[0]).toEqual(["Film 101", "2090"]);
    expect(last.hasMore).toBe(false);
    // The header is always sent with a window, never counted in it.
    expect(last.header).toEqual(["title", "year"]);
  });

  it("clamps the window to the cap and defaults it", () => {
    const capped = readDocumentWindow(csv(500), "csv", { limit: 10_000 });
    if (capped.shape !== "rows") return;
    expect(capped.rows).toHaveLength(MAX_ROWS_PER_WINDOW);
    const defaulted = readDocumentWindow(csv(500), "csv");
    if (defaulted.shape !== "rows") return;
    expect(defaulted.rows).toHaveLength(DEFAULT_ROWS_PER_WINDOW);
  });

  it("treats a numeric or blank first row as data, not a header", () => {
    const window = readDocumentWindow(Buffer.from("1,2\n3,4"), "csv");
    if (window.shape !== "rows") return;
    expect(window.header).toBeNull();
    expect(window.totalRows).toBe(2);
  });

  it("reads TSV with tabs", () => {
    const window = readDocumentWindow(Buffer.from("a\tb\n1\t2"), "tsv");
    if (window.shape !== "rows") return;
    expect(window.header).toEqual(["a", "b"]);
    expect(window.rows).toEqual([["1", "2"]]);
  });

  it("reads a workbook sheet by index or name and lists the sheets", () => {
    const first = readDocumentWindow(buildWorkbook(), "xlsx");
    if (first.shape !== "rows") return;
    expect(first.sheets).toEqual(["Watchlist", "Notes & more"]);
    expect(first.sheet).toBe("Watchlist");
    expect(first.header).toEqual(["Title", "Year", "Seen"]);
    expect(first.totalRows).toBe(3);
    const second = readDocumentWindow(buildWorkbook(), "xlsx", { sheet: "Notes & more" });
    if (second.shape !== "rows") return;
    expect(second.sheet).toBe("Notes & more");
    expect(second.header).toEqual(["only A note B"]);
    expect(second.rows).toEqual([]);
    const byIndex = readDocumentWindow(buildWorkbook(), "xlsx", { sheet: 1 });
    if (byIndex.shape !== "rows") return;
    expect(byIndex.sheet).toBe("Notes & more");
  });

  it("throws for a workbook that is not one", () => {
    expect(() => readDocumentWindow(Buffer.from("nope"), "xlsx")).toThrow();
  });
});

describe("readDocumentWindow — text", () => {
  const text = Buffer.from("﻿" + "x".repeat(10_000));

  it("windows characters with the default, the cap, and paging", () => {
    const first = readDocumentWindow(text, "txt");
    expect(first).toMatchObject({ shape: "text", format: "txt", offset: 0, totalChars: 10_000, hasMore: true });
    if (first.shape !== "text") return;
    expect(first.text).toHaveLength(DEFAULT_CHARS_PER_WINDOW);
    const rest = readDocumentWindow(text, "txt", { offset: DEFAULT_CHARS_PER_WINDOW, limit: MAX_CHARS_PER_WINDOW });
    if (rest.shape !== "text") return;
    expect(rest.text).toHaveLength(10_000 - DEFAULT_CHARS_PER_WINDOW);
    expect(rest.hasMore).toBe(false);
  });

  it("keeps JSON and Markdown verbatim", () => {
    const json = readDocumentWindow(Buffer.from('{"a": [1, 2]}'), "json");
    if (json.shape !== "text") return;
    expect(json.text).toBe('{"a": [1, 2]}');
    const md = readDocumentWindow(Buffer.from("# Title\n\n- item"), "md");
    if (md.shape !== "text") return;
    expect(md.format).toBe("md");
    expect(md.text).toBe("# Title\n\n- item");
  });
});
