import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { describe, expect, it } from "vitest";

import type { ChatCompletionFunctionTool } from "openai/resources/chat/completions";

import type { BrowserToolContext } from "./tools";
import {
  buildAgentSystemPrompt,
  buildGoalMessage,
  compactAgentConversation,
  composeAgentTools,
} from "./agent";

/** The assistant turn that requested one tool call, as the loop appends it. */
function assistantCall(id: string, name: string): ChatCompletionMessageParam {
  return {
    role: "assistant",
    content: null,
    tool_calls: [{ id, type: "function", function: { name, arguments: "{}" } }],
  };
}

function toolResult(id: string, content: string): ChatCompletionMessageParam {
  return { role: "tool", tool_call_id: id, content };
}

/** One tool round: the assistant turn asking plus the tool turn answering. */
function round(id: string, name: string, content: string): ChatCompletionMessageParam[] {
  return [assistantCall(id, name), toolResult(id, content)];
}

const imageTurn = (url: string): ChatCompletionMessageParam => ({
  role: "user",
  content: [
    { type: "text", text: "Image(s) produced by the tool call(s) above:" },
    { type: "image_url", image_url: { url } },
  ],
});

const seed: ChatCompletionMessageParam[] = [
  { role: "system", content: "You are a web-browsing agent." },
  { role: "user", content: "Goal: find the file" },
];

const contentsOf = (conversation: ChatCompletionMessageParam[]) =>
  conversation.filter((m) => m.role === "tool").map((m) => m.content);

describe("compactAgentConversation", () => {
  it("stubs every page-state snapshot but the latest", () => {
    const conversation = [
      ...seed,
      ...round("c1", "browser_navigate", "PAGE STATE 1"),
      ...round("c2", "browser_click", "PAGE STATE 2"),
      ...round("c3", "browser_scroll", "PAGE STATE 3"),
    ];

    const compacted = compactAgentConversation(conversation);

    const [first, second, third] = contentsOf(compacted);
    expect(first).toMatch(/superseded page state/);
    expect(second).toMatch(/superseded page state/);
    expect(third).toBe("PAGE STATE 3");
  });

  it("keeps only the latest two page-source chunks", () => {
    const conversation = [
      ...seed,
      ...round("c1", "browser_navigate", "PAGE STATE"),
      ...round("c2", "browser_source", "SOURCE @0"),
      ...round("c3", "browser_source", "SOURCE @20000"),
      ...round("c4", "browser_source", "SOURCE @40000"),
    ];

    const compacted = compactAgentConversation(conversation);

    expect(contentsOf(compacted)).toEqual([
      "PAGE STATE",
      expect.stringMatching(/superseded page-source chunk/),
      "SOURCE @20000",
      "SOURCE @40000",
    ]);
  });

  it("keeps search results, network listings, and download outcomes verbatim", () => {
    const conversation = [
      ...seed,
      ...round("c1", "browser_search", "1. Title — https://example.com"),
      ...round("c2", "browser_navigate", "PAGE STATE 1"),
      ...round("c3", "browser_get_network", "GET https://cdn.example.com/v.m3u8 200"),
      ...round("c4", "browser_navigate", "PAGE STATE 2"),
      ...round("c5", "browser_download_stream", "Downloaded v.mp4 (12 MB)"),
    ];

    const compacted = compactAgentConversation(conversation);

    expect(contentsOf(compacted)).toEqual([
      "1. Title — https://example.com",
      expect.stringMatching(/superseded page state/),
      "GET https://cdn.example.com/v.m3u8 200",
      "PAGE STATE 2",
      "Downloaded v.mp4 (12 MB)",
    ]);
  });

  it("replaces every screenshot vision turn but the latest with a text stub", () => {
    const conversation = [
      ...seed,
      ...round("c1", "browser_screenshot", "screenshot 1 captured"),
      imageTurn("data:image/jpeg;base64,OLD"),
      ...round("c2", "browser_screenshot", "screenshot 2 captured"),
      imageTurn("data:image/jpeg;base64,NEW"),
    ];

    const compacted = compactAgentConversation(conversation);

    const userTurns = compacted.filter((m) => m.role === "user");
    // Goal turn untouched, old screenshot stubbed to text, latest kept as parts.
    expect(userTurns[0].content).toBe("Goal: find the file");
    expect(userTurns[1].content).toMatch(/superseded screenshot/);
    expect(Array.isArray(userTurns[2].content)).toBe(true);
  });

  it("leaves the conversation structurally intact for the provider", () => {
    const conversation = [
      ...seed,
      ...round("c1", "browser_navigate", "PAGE STATE 1"),
      ...round("c2", "browser_read", "PAGE STATE 2"),
    ];

    const compacted = compactAgentConversation(conversation);

    // Same shape: every tool turn keeps its id, and the input is not mutated.
    expect(compacted.map((m) => m.role)).toEqual(conversation.map((m) => m.role));
    const stubbed = compacted[3] as { tool_call_id: string };
    expect(stubbed.tool_call_id).toBe("c1");
    expect(contentsOf(conversation)).toEqual(["PAGE STATE 1", "PAGE STATE 2"]);
  });
});


/** A tool definition with just a name — what composition keys on. */
function tool(name: string): ChatCompletionFunctionTool {
  return { type: "function", function: { name, description: name, parameters: {} } };
}

describe("composeAgentTools", () => {
  const browser = {
    tools: [tool("browser_navigate"), tool("browser_read")],
    callTool: async (name: string) => ({ text: `browser:${name}` }),
  };
  const assistant = {
    tools: [tool("memory_save"), tool("start_agent"), tool("send_message"), tool("browser_read")],
    callTool: async (name: string) => ({ text: `assistant:${name}` }),
  };

  it("offers the browser tools, then the assistant's, minus start_agent and duplicates", () => {
    const composed = composeAgentTools(browser, assistant);
    expect(composed.tools.map((t) => t.function.name)).toEqual([
      "browser_navigate",
      "browser_read",
      "memory_save",
      "send_message",
    ]);
  });

  it("keeps the delivery tool: a run may speak mid-run", () => {
    const names = composeAgentTools(browser, assistant).tools.map((t) => t.function.name);
    expect(names).toContain("send_message");
  });

  it("never offers start_agent inside a run — a run does not spawn runs", () => {
    const names = composeAgentTools(browser, assistant).tools.map((t) => t.function.name);
    expect(names).not.toContain("start_agent");
  });

  it("dispatches by ownership: browser names to the browser, the rest to the assistant", async () => {
    const composed = composeAgentTools(browser, assistant);
    expect((await composed.callTool("browser_read", {})).text).toBe("browser:browser_read");
    expect((await composed.callTool("memory_save", {})).text).toBe("assistant:memory_save");
  });

  it("holds the browser tools only, and refuses the rest, without an assistant", async () => {
    const composed = composeAgentTools(browser, null);
    expect(composed.tools.map((t) => t.function.name)).toEqual(["browser_navigate", "browser_read"]);
    expect(await composed.callTool("memory_save", {})).toMatchObject({ isError: true });
  });
});

/** The browser context the prompt reads two facts from. */
function browserContext(overrides: Partial<BrowserToolContext> = {}): BrowserToolContext {
  return {
    isOwner: true,
    allowedDownloadUrls: null,
    ...overrides,
  } as BrowserToolContext;
}

describe("buildAgentSystemPrompt", () => {
  const persona = "You are Scout.\n\nYou are terse and precise.";

  it("puts the persona first when the run acts as an assistant", () => {
    const prompt = buildAgentSystemPrompt(browserContext(), null, {
      persona,
      withAssistantTools: true,
      quiet: false,
    });
    expect(prompt.startsWith(persona)).toBe(true);
    expect(prompt).toContain("your own chat turn handed to you");
    expect(prompt).not.toContain("web-browsing agent working in the background for a chat bot");
  });

  it("stays the browser-only helper for a run with no assistant", () => {
    const prompt = buildAgentSystemPrompt(browserContext(), null, {
      persona: null,
      withAssistantTools: false,
      quiet: false,
    });
    expect(prompt).toContain("web-browsing agent working in the background for a chat bot");
    expect(prompt).not.toContain("same tools you have in a chat turn");
    expect(prompt).not.toContain("quiet run");
  });

  it("binds the goal to tool effects and reserves the final reply as the report", () => {
    const prompt = buildAgentSystemPrompt(browserContext(), null, {
      persona,
      withAssistantTools: true,
      quiet: false,
    });
    expect(prompt).toContain("never by describing it in the report");
    expect(prompt).toContain("Do not also send it with a message tool");
    expect(prompt).toContain("delivered without a notification");
  });

  it("tells a quiet run its report is posted only on failure", () => {
    const prompt = buildAgentSystemPrompt(browserContext(), null, {
      persona,
      withAssistantTools: true,
      quiet: true,
    });
    expect(prompt).toContain("quiet run");
    expect(prompt).toContain("only if the goal failed");
  });

  it("keeps the download rules, gated on owner rights", () => {
    const owner = buildAgentSystemPrompt(browserContext(), null, {
      persona: null,
      withAssistantTools: false,
      quiet: false,
    });
    const guest = buildAgentSystemPrompt(browserContext({ isOwner: false }), null, {
      persona: null,
      withAssistantTools: false,
      quiet: false,
    });
    expect(owner).toContain("You CAN download files");
    expect(guest).toContain("Downloads are disabled for this run");
  });
});

describe("buildGoalMessage", () => {
  it("is the bare goal with nothing else", () => {
    expect(buildGoalMessage("find the pricing page", [])).toBe("Goal: find the pricing page");
  });

  it("appends the gathered context, then the verbatim links", () => {
    const message = buildGoalMessage("fill row 3", ["https://example.com/x"], "Row 3 is Inception (2010)");
    expect(message).toContain("Goal: fill row 3");
    expect(message.indexOf("Context from the conversation")).toBeGreaterThan(message.indexOf("Goal:"));
    expect(message.indexOf("Row 3 is Inception (2010)")).toBeLessThan(message.indexOf("URLs from the user's message"));
    expect(message).toContain("1. https://example.com/x");
  });
});
