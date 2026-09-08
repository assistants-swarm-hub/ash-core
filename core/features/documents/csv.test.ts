import { describe, expect, it } from "vitest";

import { parseDelimited } from "./csv";

describe("parseDelimited", () => {
  it("splits records and fields, LF or CRLF, with or without a trailing newline", () => {
    expect(parseDelimited("a,b\n1,2\n", ",")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(parseDelimited("a,b\r\n1,2", ",")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("keeps commas, doubled quotes and newlines inside a quoted field", () => {
    expect(parseDelimited('title,note\n"Heat, 1995","he said ""go""\nnow"\n', ",")).toEqual([
      ["title", "note"],
      ["Heat, 1995", 'he said "go"\nnow'],
    ]);
  });

  it("reads tab-separated text with the tab delimiter, commas untouched", () => {
    expect(parseDelimited("a\tb,c\n1\t2,3", "\t")).toEqual([
      ["a", "b,c"],
      ["1", "2,3"],
    ]);
  });

  it("drops a leading byte-order mark and keeps empty fields", () => {
    expect(parseDelimited("﻿a,,c\n,,\n", ",")).toEqual([
      ["a", "", "c"],
      ["", "", ""],
    ]);
  });

  it("is empty for empty text", () => {
    expect(parseDelimited("", ",")).toEqual([]);
  });
});
