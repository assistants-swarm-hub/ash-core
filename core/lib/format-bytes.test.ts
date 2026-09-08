import { describe, expect, it } from "vitest";

import { formatBytes } from "./format-bytes";

describe("formatBytes", () => {
  it("picks the unit by magnitude and keeps small fractions where they matter", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(120 * 1024 * 1024)).toBe("120 MB");
    expect(formatBytes(Math.round(1.35 * 1024 * 1024 * 1024))).toBe("1.35 GB");
  });

  it("treats a negative or unreadable count as nothing", () => {
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
  });
});
