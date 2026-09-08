import { describe, expect, it } from "vitest";

import { displayNameMatchable, messageNamesBot } from "./addressing";

// The structural half (direct chat, reply, mention, command) is the
// transport's and is tested in each transport's own repository; the core
// only ever sees its verdict. What is tested here is the core's half: does
// free text speak the assistant's name.

describe("messageNamesBot", () => {
  it("requires the name to stand as its own word", () => {
    expect(messageNamesBot("aria!", "Aria")).toBe(true);
    expect(messageNamesBot("arias and songs", "Aria")).toBe(false);
    expect(messageNamesBot("Arianna said hi", "Aria")).toBe(false);
  });

  it("does not match the name inside someone else's @handle", () => {
    expect(messageNamesBot("@ariafan hello", "Aria")).toBe(false);
    expect(messageNamesBot("@aria hello", "Aria")).toBe(false);
  });

  // `\b`/`\w` are ASCII-only, so an ASCII-boundary regex treats every Cyrillic
  // letter as a boundary: a bot named "Бот" would answer to "работа".
  it("applies word boundaries outside the ASCII range", () => {
    expect(messageNamesBot("работа не ждет", "Бот")).toBe(false);
    expect(messageNamesBot("Бот, привет", "Бот")).toBe(true);
  });

  it("does not match a name it was told not to look for", () => {
    expect(messageNamesBot("the bot is down", "Bot")).toBe(false);
    expect(messageNamesBot("hi al", "Al")).toBe(false);
  });
});

describe("displayNameMatchable", () => {
  it("rejects generic names and names too short to match cleanly", () => {
    expect(displayNameMatchable("Aria")).toBe(true);
    expect(displayNameMatchable("Bot")).toBe(false);
    expect(displayNameMatchable("ASSISTANT")).toBe(false);
    expect(displayNameMatchable("Al")).toBe(false);
    expect(displayNameMatchable("  ")).toBe(false);
  });
});
