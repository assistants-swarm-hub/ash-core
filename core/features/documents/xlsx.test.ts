import { describe, expect, it } from "vitest";

import { buildWorkbook, buildZip } from "./test-workbook";
import { readXlsx } from "./xlsx";

/**
 * A workbook is a zip of XML parts. The reader is exercised against files
 * built from the same parts a spreadsheet application writes, with the
 * entries both deflated (as real files are) and stored, so both zip methods
 * are covered without a binary fixture nobody can read.
 */

describe("readXlsx", () => {
  it("reads every sheet's cells: shared, inline and rich strings, numbers, booleans, gaps", () => {
    const sheets = readXlsx(buildWorkbook());
    expect(sheets.map((s) => s.name)).toEqual(["Watchlist", "Notes & more"]);
    expect(sheets[0].rows).toEqual([
      ["Title", "Year", "Seen"],
      ["Heat & Cold", "1995", "TRUE"],
      [],
      ["Inception", "", "FALSE"],
    ]);
    expect(sheets[1].rows).toEqual([["only A note B"]]);
  });

  it("reads stored (uncompressed) entries as well as deflated ones", () => {
    expect(readXlsx(buildWorkbook(false))[0].rows[1]).toEqual(["Heat & Cold", "1995", "TRUE"]);
  });

  it("refuses bytes that are not a workbook", () => {
    expect(() => readXlsx(Buffer.from("title,year\nHeat,1995"))).toThrow(/not a zip/);
    expect(() => readXlsx(buildZip([{ name: "readme.txt", data: "hi" }]))).toThrow(/not an xlsx/);
  });
});
