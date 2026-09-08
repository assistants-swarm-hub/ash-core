import { describe, expect, it } from "vitest";

import { buildCollectionsBlock, summarizeCollection } from "./format";
import type { Collection } from "./types";

/**
 * The prompt block: every collection the turn sees by id with its columns
 * in one line, the gap count a fill loop ends on, the two instructions
 * verbatim, and the rights the sender holds.
 */

function collection(over: Partial<Collection> = {}): Collection {
  return {
    id: "c1",
    assistantId: "assistant-1",
    name: "Watchlist",
    description: "Films to watch.",
    visibility: "private",
    fillInstruction: "Look the title up on the usual site; record the plot and the cast.",
    presentationInstruction: "Title (year), one line of plot, the poster.",
    columns: [
      { key: "url", label: "URL", type: "url", isKey: true, requiredForComplete: true },
      { key: "title", label: "Title", type: "text", isKey: false, requiredForComplete: true },
      { key: "kind", label: "Kind", type: "enum", options: ["Movie", "Series"], isKey: false, requiredForComplete: false },
      { key: "my_rating", label: "My rating", type: "rating", scale: 5, isKey: false, requiredForComplete: false },
    ],
    rowCount: 312,
    gapCount: 40,
    createdAt: "2026-09-08T00:00:00.000Z",
    updatedAt: "2026-09-08T00:00:00.000Z",
    ...over,
  };
}

describe("buildCollectionsBlock", () => {
  it("is null when the turn sees no collection", () => {
    expect(buildCollectionsBlock([], { ownerRights: true })).toBeNull();
  });

  it("names each collection by id with its counts, columns and instructions", () => {
    const block = buildCollectionsBlock([collection()], { ownerRights: true })!;
    expect(block).toContain("- Watchlist — id c1, 312 rows, 40 with gaps, private to the owner. Films to watch.");
    expect(block).toContain('columns: url "URL" (url, KEY, needed for complete); title "Title" (text, needed for complete); kind "Kind" (enum, one of: Movie / Series); my_rating "My rating" (rating, 0-5)');
    expect(block).toContain("how to fill gaps: Look the title up");
    expect(block).toContain("how to present an item: Title (year)");
    expect(block).toContain("owner rights: you may add, update and delete");
  });

  it("says when a collection is filled, and what a non-owner may do", () => {
    const block = buildCollectionsBlock([collection({ gapCount: 0, visibility: "shared", fillInstruction: "", presentationInstruction: "" })], {
      ownerRights: false,
    })!;
    expect(block).toContain("312 rows, no gaps, shared with everyone in the chat");
    expect(block).not.toContain("how to fill gaps");
    expect(block).toContain("does not hold owner rights");
  });

  it("summarizes for lists", () => {
    expect(summarizeCollection(collection())).toBe("Watchlist (312 rows, 40 with gaps)");
    expect(summarizeCollection(collection({ gapCount: 0 }))).toBe("Watchlist (312 rows)");
  });
});
