import { describe, expect, it } from "vitest";

import {
  checkColumns,
  gapsOf,
  isComplete,
  keyValueOf,
  normalizeValue,
  normalizeValues,
  renderRowForEmbedding,
  reshapeValues,
} from "./columns";
import { MAX_COLUMNS, type CollectionColumn } from "./types";

/**
 * The column rules: what a column list may declare and what a value may be.
 * These are what make "typed columns, code-enforced" true — a bad value is
 * refused with the column named, never coerced into something else.
 */

const columns: CollectionColumn[] = [
  { key: "url", label: "URL", type: "url", isKey: true, requiredForComplete: true },
  { key: "title", label: "Title", type: "text", isKey: false, requiredForComplete: true },
  { key: "year", label: "Year", type: "number", isKey: false, requiredForComplete: false },
  { key: "genres", label: "Genres", type: "list", isKey: false, requiredForComplete: false },
  { key: "kind", label: "Kind", type: "enum", options: ["Movie", "Series"], isKey: false, requiredForComplete: false },
  { key: "my_rating", label: "My rating", type: "rating", scale: 10, isKey: false, requiredForComplete: false },
  { key: "seen", label: "Seen", type: "boolean", isKey: false, requiredForComplete: false },
  { key: "released", label: "Released", type: "date", isKey: false, requiredForComplete: false },
  { key: "poster", label: "Poster", type: "image", isKey: false, requiredForComplete: false },
];

describe("checkColumns", () => {
  it("normalizes a valid list: labels default to keys, enum options deduplicated, rating scale defaulted", () => {
    const checked = checkColumns([
      { key: "id", type: "text", isKey: true },
      { key: "kind", type: "enum", options: [" a ", "b", "a"] },
      { key: "score", type: "rating" },
    ]);
    expect(checked).toMatchObject({ ok: true });
    if (!checked.ok) return;
    expect(checked.value[0]).toMatchObject({ key: "id", label: "id", isKey: true, requiredForComplete: false });
    expect(checked.value[1].options).toEqual(["a", "b"]);
    expect(checked.value[2].scale).toBe(10);
  });

  it.each([
    [[], "at least one column"],
    [[{ key: "Bad Key", type: "text", isKey: true }], 'key "Bad Key"'],
    [[{ key: "a", type: "text", isKey: true }, { key: "a", type: "text" }], "used twice"],
    [[{ key: "a", type: "money", isKey: true }], 'type "money"'],
    [[{ key: "a", type: "text" }], "exactly one column must be the key"],
    [[{ key: "a", type: "text", isKey: true }, { key: "b", type: "text", isKey: true }], "only one column may be the key"],
    [[{ key: "a", type: "list", isKey: true }], "key column must be text, number or url"],
    [[{ key: "a", type: "enum", isKey: false }, { key: "b", type: "text", isKey: true }], "needs its options"],
    [[{ key: "a", type: "rating", scale: 0 }, { key: "b", type: "text", isKey: true }], "rating scale"],
    [Array.from({ length: MAX_COLUMNS + 1 }, (_, i) => ({ key: `c${i}`, type: "text", isKey: i === 0 })), `at most ${MAX_COLUMNS}`],
  ])("refuses %j with %s", (input, reason) => {
    const checked = checkColumns(input);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.reason).toContain(reason);
  });
});

describe("normalizeValue", () => {
  const by = Object.fromEntries(columns.map((c) => [c.key, c]));

  it("accepts empty for every type as null", () => {
    for (const column of columns) {
      expect(normalizeValue(column, "")).toEqual({ ok: true, value: null });
      expect(normalizeValue(column, null)).toEqual({ ok: true, value: null });
      expect(normalizeValue(column, [])).toEqual({ ok: true, value: null });
    }
  });

  it("types each kind and names the column on refusal", () => {
    expect(normalizeValue(by.year, "1995")).toEqual({ ok: true, value: 1995 });
    expect(normalizeValue(by.year, "nineteen")).toMatchObject({ ok: false, reason: '"year" must be a number' });
    expect(normalizeValue(by.genres, "Crime, Drama;Thriller")).toEqual({ ok: true, value: ["Crime", "Drama", "Thriller"] });
    expect(normalizeValue(by.genres, ["Crime", " "])).toEqual({ ok: true, value: ["Crime"] });
    expect(normalizeValue(by.kind, "movie")).toEqual({ ok: true, value: "Movie" });
    expect(normalizeValue(by.kind, "Short")).toMatchObject({ ok: false, reason: '"kind" must be one of Movie, Series' });
    expect(normalizeValue(by.my_rating, 11)).toMatchObject({ ok: false, reason: '"my_rating" must be a rating from 0 to 10' });
    expect(normalizeValue(by.my_rating, "7.5")).toEqual({ ok: true, value: 7.5 });
    expect(normalizeValue(by.seen, "yes")).toEqual({ ok: true, value: true });
    expect(normalizeValue(by.seen, "maybe")).toMatchObject({ ok: false });
    expect(normalizeValue(by.released, "1995-12-15")).toEqual({ ok: true, value: "1995-12-15" });
    expect(normalizeValue(by.released, "someday")).toMatchObject({ ok: false, reason: expect.stringContaining('"released" must be a date') });
    expect(normalizeValue(by.url, "https://example.com/title/tt1")).toEqual({ ok: true, value: "https://example.com/title/tt1" });
    expect(normalizeValue(by.url, "ftp://example.com")).toMatchObject({ ok: false, reason: '"url" must be an http(s) URL' });
    expect(normalizeValue(by.poster, "not a url")).toMatchObject({ ok: false });
    expect(normalizeValue(by.title, 42)).toEqual({ ok: true, value: "42" });
    expect(normalizeValue(by.title, { a: 1 })).toMatchObject({ ok: false, reason: '"title" must be text' });
  });
});

describe("normalizeValues", () => {
  it("refuses an unknown column, naming the known ones", () => {
    const checked = normalizeValues(columns, { url: "https://x.y/1", director: "Mann" }, { partial: false });
    expect(checked).toMatchObject({ ok: false });
    if (!checked.ok) expect(checked.reason).toContain('"director" is not a column');
  });

  it("fills every column on a full write and only the given ones on a partial", () => {
    const full = normalizeValues(columns, { url: "https://x.y/1", title: "Heat" }, { partial: false });
    expect(full.ok && Object.keys(full.value).length).toBe(columns.length);
    const partial = normalizeValues(columns, { title: "Heat" }, { partial: true });
    expect(partial).toEqual({ ok: true, value: { title: "Heat" } });
  });
});

describe("completeness and keys", () => {
  it("judges complete by the required columns and lists the gaps", () => {
    const values = { url: "https://x.y/1", title: null, year: 1995 };
    expect(isComplete(columns, values)).toBe(false);
    expect(gapsOf(columns, values)).toEqual(["title"]);
    expect(isComplete(columns, { ...values, title: "Heat" })).toBe(true);
  });

  it("reads the key as text and refuses an empty one", () => {
    expect(keyValueOf(columns, { url: " https://x.y/1 " })).toEqual({ ok: true, value: "https://x.y/1" });
    expect(keyValueOf(columns, { url: null })).toMatchObject({ ok: false, reason: 'the key column "url" is empty' });
  });

  it("reshapes stored values to a changed column list", () => {
    const next = columns.filter((c) => c.key !== "year");
    expect(reshapeValues(next, { url: "u", year: 1995, title: "Heat" })).toEqual({
      url: "u",
      title: "Heat",
      genres: null,
      kind: null,
      my_rating: null,
      seen: null,
      released: null,
      poster: null,
    });
  });

  it("renders a row for embedding as label: value lines of the filled cells", () => {
    expect(renderRowForEmbedding(columns, { url: "https://x.y/1", title: "Heat", genres: ["Crime", "Drama"], seen: true })).toBe(
      "URL: https://x.y/1\nTitle: Heat\nGenres: Crime, Drama\nSeen: yes",
    );
  });
});
