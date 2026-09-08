import { describe, expect, it } from "vitest";

import { DOCUMENT_UNAVAILABLE_NOTE, documentLabel, documentTurnNote } from "./format";

describe("documentLabel", () => {
  it("names the file with its format and size", () => {
    expect(documentLabel({ filename: "watchlist.csv", mimeType: "text/csv", sizeBytes: 12_288 })).toBe(
      "watchlist.csv (CSV, 12 KB)",
    );
  });

  it("falls back to the mime type for the format and copes with no size or no name", () => {
    expect(documentLabel({ filename: "export", mimeType: "application/json", sizeBytes: null })).toBe(
      "export (JSON)",
    );
    expect(documentLabel({ filename: null, mimeType: null, sizeBytes: 5 })).toBe("document (5 B)");
    expect(documentLabel({ filename: "  ", mimeType: null, sizeBytes: null })).toBe("document");
  });
});

describe("the turn notes", () => {
  it("name the document and its id, and never a tool", () => {
    const note = documentTurnNote({ label: "watchlist.csv (CSV, 12 KB)", mediaId: "m-1" });
    expect(note).toContain("watchlist.csv (CSV, 12 KB)");
    expect(note).toContain("id m-1");
    expect(note).not.toMatch(/read_document/);
    expect(DOCUMENT_UNAVAILABLE_NOTE).toContain("could not be kept");
  });
});
