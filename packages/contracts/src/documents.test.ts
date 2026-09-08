import { describe, expect, it } from "vitest";

import {
  DOCUMENT_FORMATS,
  DOCUMENT_MAX_BYTES,
  documentExtension,
  documentFormatOf,
  isDocumentFile,
} from "./documents";

/**
 * The document predicate every side reads: a transport decides what to forward
 * with it, the core refuses the same things on ingest. Both must agree, so it
 * lives in the contract and is pinned here.
 */

describe("documentFormatOf", () => {
  it("names every carried format from its extension", () => {
    expect(documentFormatOf({ filename: "watchlist.csv" })).toBe("csv");
    expect(documentFormatOf({ filename: "rows.TSV" })).toBe("tsv");
    expect(documentFormatOf({ filename: "export.json" })).toBe("json");
    expect(documentFormatOf({ filename: "sheet.xlsx" })).toBe("xlsx");
    expect(documentFormatOf({ filename: "notes.txt" })).toBe("txt");
    expect(documentFormatOf({ filename: "README.md" })).toBe("md");
    expect(documentFormatOf({ filename: "README.markdown" })).toBe("md");
  });

  it("lets the extension win over a loosely guessed mime type", () => {
    // Platforms send text/plain for a .csv and octet-stream for a .xlsx.
    expect(documentFormatOf({ filename: "watchlist.csv", mimeType: "text/plain" })).toBe("csv");
    expect(
      documentFormatOf({ filename: "sheet.xlsx", mimeType: "application/octet-stream" }),
    ).toBe("xlsx");
  });

  it("falls back to the mime type when the name says nothing", () => {
    expect(documentFormatOf({ filename: "export", mimeType: "text/csv" })).toBe("csv");
    expect(documentFormatOf({ filename: null, mimeType: "application/json; charset=utf-8" })).toBe(
      "json",
    );
    expect(
      documentFormatOf({
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
    ).toBe("xlsx");
  });

  it("is null for anything it does not carry", () => {
    expect(documentFormatOf({ filename: "archive.zip", mimeType: "application/zip" })).toBeNull();
    expect(documentFormatOf({ filename: "paper.pdf", mimeType: "application/pdf" })).toBeNull();
    expect(documentFormatOf({ filename: "photo.jpg", mimeType: "image/jpeg" })).toBeNull();
    expect(documentFormatOf({ filename: "noext", mimeType: "application/octet-stream" })).toBeNull();
    expect(documentFormatOf({})).toBeNull();
  });

  it("agrees with isDocumentFile and the format list", () => {
    for (const format of DOCUMENT_FORMATS) {
      expect(isDocumentFile({ filename: `file.${format}` })).toBe(true);
    }
    expect(isDocumentFile({ filename: "file.exe" })).toBe(false);
  });
});

describe("documentExtension", () => {
  it("reads the last extension, lowercased, and none for a dotfile or a bare name", () => {
    expect(documentExtension("a.b.CSV")).toBe("csv");
    expect(documentExtension(".env")).toBeNull();
    expect(documentExtension("name.")).toBeNull();
    expect(documentExtension("name")).toBeNull();
    expect(documentExtension(null)).toBeNull();
  });
});

describe("DOCUMENT_MAX_BYTES", () => {
  it("is ten megabytes — a storage guard, not a quality choice", () => {
    expect(DOCUMENT_MAX_BYTES).toBe(10 * 1024 * 1024);
  });
});
