import "server-only";

import type {
  ChatCompletionFunctionTool,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";

import type { Toolset } from "@/features/mcp-tools/server/service";
import type { LlmCallTrace, LlmConnection, ChatMessage } from "@/server/llm/client";
import { chatCompletionWithTools } from "@/server/llm/tool-loop";
import type { McpToolCallResult } from "@/server/mcp/tool-result";

import { START_AGENT_TOOL } from "../types";
import { BROWSER_AGENT_TOOLS, makeBrowserToolDispatcher, type BrowserToolContext } from "./tools";

/**
 * The agent proper: one goal, run to completion in one session by the agent
 * role's model over the shared tool loop. A run is the assistant working in
 * the background — its persona composed in, its whole toolset offered next to
 * the browser primitives (user decision, 2026-09-08). Deliberately
 * **unbounded** (recorded decision): no round or wall-clock cap — only the
 * loop's stall guard ends a run that stops progressing, and its forced
 * tools-free final round then salvages a report from what was gathered.
 */

/**
 * Strip tool-call special tokens that leaked into the model's prose. When the
 * loop takes tools away for the forced final answer, a model still "wanting" to
 * act sometimes emits its raw tool-call syntax as literal text
 * (e.g. `<|tool_call>call:browser_navigate{…}<tool_call|>`). That must never
 * reach the chat: remove any angle-bracket token carrying a pipe and any
 * leftover `call:name{…}` body. If nothing readable remains, return "" so the
 * caller falls back to a plain message instead of shipping fragments.
 */
export function sanitizeAgentReport(text: string): string {
  return text
    .replace(/<[^<>]*\|[^<>]*>/g, "")
    .replace(/\bcall:\w+\s*\{[^{}]*\}/gi, "")
    .trim();
}

export interface AgentRunResult {
  report: string;
}

/**
 * Browser tools whose result is a page-state snapshot (URL + page text +
 * interactive elements). Refs are re-assigned on every action, so every snapshot
 * but the latest is unusable by the agent's own rules — carrying them verbatim
 * is what let a run's prompt grow monotonically until it overflowed the context
 * window (2026-07-30 trace: 32k window spent, run died with the download URL
 * already found).
 */
const PAGE_STATE_TOOLS = new Set([
  "browser_navigate",
  "browser_back",
  "browser_click",
  "browser_type",
  "browser_scroll",
  "browser_read",
  "browser_wait",
]);

/** Raw-source chunks kept verbatim; a URL hunt reads adjacent chunks together. */
const SOURCE_CHUNKS_KEPT = 2;

const STALE_PAGE_STATE_STUB =
  "[superseded page state removed — its refs are stale; the latest page state is the current one. Call browser_read if you need the page again.]";
const STALE_SOURCE_STUB =
  "[superseded page-source chunk removed — call browser_source again if you still need it.]";
const STALE_SCREENSHOT_STUB =
  "[superseded screenshot removed — call browser_screenshot again if you need a current one.]";

/**
 * The per-round conversation rewrite for a run: every page-state snapshot but
 * the latest, every raw-source chunk but the latest {@link SOURCE_CHUNKS_KEPT},
 * and every tool-produced screenshot turn but the latest are replaced with a
 * one-line stub telling the model how to re-fetch. Search results, network
 * listings, download outcomes and every non-browser tool result are kept —
 * they are small and carry durable facts the model acts on rounds later.
 * Applied to what each round sends, never to the kept history (see
 * `RunToolLoopParams.compact`).
 */
export function compactAgentConversation(
  conversation: ChatCompletionMessageParam[],
): ChatCompletionMessageParam[] {
  // tool_call_id → tool name, from the assistant turns that requested the calls.
  const toolNameById = new Map<string, string>();
  for (const message of conversation) {
    if (message.role !== "assistant" || !message.tool_calls) continue;
    for (const call of message.tool_calls) {
      if (call.type === "function") toolNameById.set(call.id, call.function.name);
    }
  }

  const nameAt = (message: ChatCompletionMessageParam): string | undefined =>
    message.role === "tool" ? toolNameById.get(message.tool_call_id) : undefined;
  const isImageTurn = (message: ChatCompletionMessageParam): boolean =>
    message.role === "user" &&
    Array.isArray(message.content) &&
    message.content.some((part) => part.type === "image_url");

  let lastPageState = -1;
  const sourceChunks: number[] = [];
  let lastImageTurn = -1;
  conversation.forEach((message, index) => {
    const name = nameAt(message);
    if (name && PAGE_STATE_TOOLS.has(name)) lastPageState = index;
    if (name === "browser_source") sourceChunks.push(index);
    if (isImageTurn(message)) lastImageTurn = index;
  });
  const keptSourceChunks = new Set(sourceChunks.slice(-SOURCE_CHUNKS_KEPT));

  return conversation.map((message, index) => {
    const name = nameAt(message);
    if (name && PAGE_STATE_TOOLS.has(name) && index !== lastPageState) {
      return { ...message, content: STALE_PAGE_STATE_STUB };
    }
    if (name === "browser_source" && !keptSourceChunks.has(index)) {
      return { ...message, content: STALE_SOURCE_STUB };
    }
    if (isImageTurn(message) && index !== lastImageTurn) {
      return { role: "user", content: STALE_SCREENSHOT_STUB };
    }
    return message;
  });
}

/** The tools one run offers, and where each call goes. */
export interface AgentToolset {
  tools: ChatCompletionFunctionTool[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<McpToolCallResult>;
}

/**
 * Compose a run's toolset: the browser primitives, then the assistant's own
 * toolset — everything a chat turn of that assistant is offered, delivery
 * tool included — minus `start_agent` itself (a run does not spawn runs) and
 * minus any name the browser set already owns. Absent assistant tools (no
 * tool registered at all — tests) leave the browser set alone. Dispatch
 * follows ownership: a browser name goes to the browser dispatcher, anything
 * else to the assistant's toolset.
 */
export function composeAgentTools(
  browser: AgentToolset,
  assistant: Toolset | null,
): AgentToolset {
  const browserNames = new Set(browser.tools.map((tool) => tool.function.name));
  const extra = (assistant?.tools ?? []).filter(
    (tool) => tool.function.name !== START_AGENT_TOOL && !browserNames.has(tool.function.name),
  );
  return {
    tools: [...browser.tools, ...extra],
    callTool: (name, args) => {
      if (browserNames.has(name)) return browser.callTool(name, args);
      if (assistant) return assistant.callTool(name, args);
      return Promise.resolve({ text: `Unknown tool: ${name}`, isError: true });
    },
  };
}

/** What shapes the agent's system prompt beyond the browser rules. */
export interface AgentPromptOptions {
  /**
   * The assistant's persona block (identity line + persona); null only when
   * the assistant no longer exists.
   */
  persona: string | null;
  /** Whether the run holds the assistant's toolset next to the browser. */
  withAssistantTools: boolean;
  /** Whether the final report is posted only on failure. */
  quiet: boolean;
  /**
   * The assistant's collections as the run may see them, as a composed
   * prompt block — a run whose goal is filling gaps works by their ids.
   * Null/absent → no block.
   */
  collections?: string | null;
}

export function buildAgentSystemPrompt(
  toolContext: BrowserToolContext,
  requiredLanguage: string | null,
  options: AgentPromptOptions,
): string {
  const { isOwner } = toolContext;
  const urlFenced = toolContext.allowedDownloadUrls !== null;
  // The persona comes first, as in a chat turn: the agent is the assistant
  // working in the background, not a helper working for it (user decision,
  // 2026-09-08). Everything after it is the working method.
  const identity = options.persona
    ? `${options.persona}\n\n---\n` +
      `You are working in the background on a goal that your own chat turn handed to you. ` +
      `You have your usual tools plus a set of browser tools. Accomplish the goal step by step, ` +
      `then write a final report.\n\n`
    : `You are a web-browsing agent working in the background for a chat bot. ` +
      `You are given a goal and a set of browser tools. Accomplish the goal by ` +
      `navigating the web step by step, then write a final report.\n\n`;
  const collections = options.collections?.trim();
  return (
    identity +
    (collections ? `${collections}\n\n---\n` : "") +
    `Rules:\n` +
    `- Start with browser_navigate when the goal gives you a URL, and with browser_search ` +
    `when it does not — never guess a URL you were not given. After each action you get the page text plus a ` +
    `numbered list of interactive elements — each link shows its destination URL after "->". ` +
    `Click or type using the ref numbers.\n` +
    `- Refs are re-assigned on every action: always use refs from the LATEST page state.\n` +
    `- Check an element's "-> URL" before clicking, and avoid links that leave the ` +
    `site's domain unless they clearly serve the goal.\n` +
    `- Take the fewest steps needed. Do not loop or repeat the same action.\n` +
    (options.withAssistantTools
      ? // The goal is done only when its effect exists. A run asked to record
        // what it finds has not done so by describing it in the report.
        `- Besides the browser you hold the same tools you have in a chat turn. Use them whenever ` +
        `the goal asks you to record, remember, schedule, look something up in your own data, or ` +
        `tell someone something — the goal is not done until what it asks for has actually been ` +
        `done through a tool, never by describing it in the report.\n` +
        // The runner posts the report; a message tool call on top of it would
        // double-send. Mid-run notes are silent by the run's binding.
        `- Your final reply — the text you write when you stop calling tools — is posted to the ` +
        `chat for you as your report. Do not also send it with a message tool. Send a message ` +
        `mid-run only for a note worth interrupting for; it is delivered without a notification.\n`
      : "") +
    (options.quiet
      ? `- This is a quiet run: your final report is posted to the chat only if the goal failed. ` +
        `Say what you did in the report anyway — it is stored and shown on the dashboard.\n`
      : "") +
    (isOwner
      ? // The download rules are stated here as well as in the tool descriptions,
        // because the failure they address is a *decision* the agent makes before
        // it ever looks at a tool: on 2026-07-28 a run asked to download a track
        // reported back that the site has no download button and the owner should
        // use yt-dlp themselves, having never called a download tool at all.
        `- You CAN download files, and you are expected to. If the goal asks for a file, ` +
        `song, track, video or document, the run is not done until you have called a ` +
        `download tool. Never finish by telling the user how to download it themselves, ` +
        `naming a program for them to run, or pointing them at another site — either ` +
        `download it, or say exactly which tool you called and how it failed.\n` +
        `- On a video or music site (YouTube, YouTube Music, SoundCloud, Vimeo, TikTok, ` +
        `Bandcamp, a podcast page …), download with browser_download_media and the page ` +
        `URL — use mode "audio" for a song/track/podcast and "video" for a video. Those ` +
        `pages never expose a media file URL, so do not START by reading the source or ` +
        `the network looking for one, and do not conclude the download is impossible ` +
        `without having called browser_download_media.\n` +
        // One failed tool call is not a failed run (operator report, 2026-08-12:
        // a yt-dlp failure ended the run with no other route even attempted).
        // The escape hatch is scoped to the SAME content — the substitution
        // guard below still forbids delivering anything else.
        `- A failed download tool is not yet a failed run: before giving up, try the other ` +
        `routes to the SAME content. If browser_download_media fails, re-check you gave it ` +
        `the exact page URL (the verbatim URLs list wins over the goal text) and try once ` +
        `more; look for another official page of the very same content and try that. Once ` +
        `browser_download_media has actually failed, you may also open the page, play the ` +
        `media, and check browser_get_network for a direct media URL — many sites serve ` +
        `the video as a plain .mp4 (browser_download_file) or a .m3u8 stream ` +
        `(browser_download_stream). Only when those are exhausted has the run failed — ` +
        `then stop and report exactly what you tried and how each attempt failed.\n` +
        // Substitution guard (incident, 2026-08-01): a run that could not reach
        // the asked-for tweet searched up an unrelated music video and delivered
        // it as "similar". A failed goal must come back as a failure.
        `- Download ONLY what the goal names. NEVER download different or "similar" content ` +
        `as a substitute — not even if the goal seems to offer that option, and no matter ` +
        `how many attempts failed. A substitute file is a wrong result; an honest failure ` +
        `report is the correct one.\n` +
        (urlFenced
          ? `- This run may only download from the user's own link(s), listed under "URLs" ` +
            `in the goal message. A file too large to send to the chat cannot be delivered ` +
            `at all — if a download tool reports that, relay it as the outcome and never ` +
            `mention any server folder.\n`
          : "")
      : `- Downloads are disabled for this run (only the owner can download files) — never promise a file.\n`) +
    `- When you have achieved the goal (or determined it cannot be done), STOP calling tools ` +
    `and reply with a clear, concise report of what you found or did. ` +
    (requiredLanguage ? `Write the report in this required language: ${requiredLanguage}. ` : "") +
    `That reply is your report to the chat. Do not include raw HTML or tool syntax.`
  );
}

export interface RunAgentParams {
  goal: string;
  /**
   * Facts the starting turn gathered for the run (a run sees no transcript),
   * or null. Appended to the goal message verbatim.
   */
  context?: string | null;
  /** Whether the final report is posted only on failure. */
  quiet?: boolean;
  /**
   * The triggering message's URLs, extracted in code — appended to the goal
   * verbatim so the agent works from exact links even when the goal text (which
   * an LLM composed) mis-typed one. Empty → the goal stands alone.
   */
  sourceUrls?: string[];
  /** LLM connection + model (the agent role). */
  conn: LlmConnection;
  model: string;
  /** Everything the browser tools act through for this run. */
  toolContext: BrowserToolContext;
  /**
   * The assistant's own toolset, offered next to the browser tools and called
   * inside the run's bound turn context; null when nothing is registered.
   */
  assistantTools?: Toolset | null;
  /** The assistant's persona block, or null when the assistant is gone. */
  persona?: string | null;
  /** The assistant's collections block as the run may see them, or null. */
  collections?: string | null;
  /** Reply language required for the destination chat, or null for the default. */
  requiredLanguage: string | null;
  /** Recording options for the shared LLM tracing layer, forwarded to the loop. */
  trace?: LlmCallTrace;
}

/**
 * The user turn: the goal, then the context the starting turn gathered, then —
 * when the triggering message carried links — those links verbatim. The goal
 * text passed through an LLM, which has mis-typed a URL before (2026-08-01: one
 * flipped digit in a tweet id sent a run chasing a nonexistent post); the
 * code-extracted list is the authority.
 */
export function buildGoalMessage(
  goal: string,
  sourceUrls: string[],
  context: string | null = null,
): string {
  let message = `Goal: ${goal}`;
  if (context) {
    message += `\n\nContext from the conversation that started this run:\n${context}`;
  }
  if (sourceUrls.length === 0) return message;
  const list = sourceUrls.map((url, i) => `${i + 1}. ${url}`).join("\n");
  return (
    `${message}\n\n` +
    `URLs from the user's message, copied verbatim by the system:\n${list}\n` +
    `These are exact, character for character. If a URL in the goal text above differs, ` +
    `the goal mis-typed it — use the URLs from this list.`
  );
}

/**
 * Run one goal to completion. Throws on provider/config failure (the runner
 * records it and fails the run); a stall degrades to a forced report.
 */
export async function runAgent(params: RunAgentParams): Promise<AgentRunResult> {
  const assistantTools = params.assistantTools ?? null;
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: buildAgentSystemPrompt(params.toolContext, params.requiredLanguage, {
        persona: params.persona ?? null,
        withAssistantTools: assistantTools !== null,
        quiet: params.quiet === true,
        collections: params.collections ?? null,
      }),
    },
    {
      role: "user",
      content: buildGoalMessage(params.goal, params.sourceUrls ?? [], params.context ?? null),
    },
  ];
  const toolset = composeAgentTools(
    { tools: BROWSER_AGENT_TOOLS, callTool: makeBrowserToolDispatcher(params.toolContext) },
    assistantTools,
  );

  const result = await chatCompletionWithTools(params.conn, {
    model: params.model,
    messages,
    tools: toolset.tools,
    callTool: toolset.callTool,
    ...(params.trace ? { trace: params.trace } : {}),
    compact: compactAgentConversation,
    // Unbounded by decision — the stall guard is the only stop.
    maxRounds: Number.POSITIVE_INFINITY,
  });

  // A stall that still produced a forced report is indistinguishable from a
  // clean finish here, deliberately — the report is what the chat gets either way.
  return { report: sanitizeAgentReport(result.content) };
}
