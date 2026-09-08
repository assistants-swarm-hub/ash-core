import "server-only";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { scopedRef } from "@assistants-swarm-hub/contracts";

import { isGroupChat } from "@/features/known-groups/server/repository";
import { getToolContext } from "@/server/mcp/context";

import { MAX_CONTEXT_LENGTH, MAX_GOAL_LENGTH, START_AGENT_TOOL } from "../types";
import { enqueueAgentRun } from "./service";
import { emitRunEnqueued } from "./signal";

/**
 * The assistant's one background tool. `start_agent` hands a goal to a copy of
 * the assistant that works on it in the background: the same persona and the
 * same toolset as the chat turn that called it, plus a real browser, driven by
 * the agent role's model over the shared tool loop. It replaced `browse_web`
 * (user decision, 2026-09-08): that tool spawned a browser-only agent with no
 * turn context and no persona, which could read a page but record nothing
 * anywhere — and a background capability of its own deserves an explicit
 * name rather than a browsing tool that quietly grew.
 *
 * The chat model calls this and moves on — it does not do the work itself
 * (recorded decision: background run, not inline). The run posts its final
 * report to this chat when done; anything it sends mid-run goes out silent.
 * Anyone may start a run; the download tools inside it are gated to owner
 * rights, resolved here at enqueue time. The browser primitives the run drives
 * are never offered here — only this dispatch tool is.
 */

export { START_AGENT_TOOL };

export const AGENTS_TOOL_NAMES = [START_AGENT_TOOL];

const NO_ASSISTANT =
  "This turn has no assistant to act as, so no background agent was started. Nothing was done.";

const START_AGENT_DESCRIPTION =
  "Start a background agent: a copy of yourself that works on a goal on its own, with your usual " +
  "tools AND a REAL browser. It can SEARCH the web, open and read any page, follow links, click, " +
  "fill forms, read a page's LIVE rendered values, download files (documents, images, videos, " +
  "archives) to send to the user, and it can record, remember, schedule and update things through " +
  "the same tools you have. This is the ONLY way you can reach the internet, and the only way to " +
  "do work that takes many steps or minutes. " +
  "You CAN get a file for the user through this tool — when a user gives you a link and asks you " +
  "to download / save / grab / fetch it (or the video/image/file on it), call this tool: never " +
  "reply that you are 'just a language model' or 'cannot download files' — that refusal is wrong. " +
  "MUST call when the user: (a) asks you to look something up or check what is online; (b) shares " +
  "a URL, or asks about a page whose URL is in the conversation — read it instead of answering " +
  "from memory; (c) asks to download or save a file, video, image, or document; (d) names a site " +
  "or service to get data FROM ('on <site>', 'check <site>'); (e) wants a LIVE or CURRENT value — " +
  "weather, a price, a rate, live stats or counts, availability, today's news — your own " +
  "knowledge is stale; (f) needs any multi-step interaction on the web; (g) asks for a job that " +
  "has to act on what it finds — look something up and record it, fill in missing details, work " +
  "through a list — or that would take many steps or minutes. " +
  "Do NOT call for casual chat, an opinion, a stable fact you already know well and the user did " +
  "not ask you to verify (a definition, a historical date, arithmetic), or anything you can finish " +
  "right now with your own tools in this turn. " +
  "Write the goal as a clear, self-contained instruction and INCLUDE ALL links, site names, search " +
  "terms and ids the user gave, links copied character-for-character — the agent starts from " +
  "nothing but this text and the context you pass; it does not see this conversation. Put the " +
  "facts it needs (names, ids, what was already decided, how the result should look) into " +
  "`context`. Pass on what was actually asked and add NO easier alternative: never 'or describe " +
  "it' / 'or explain how to get it' — the agent takes any alternative as permission to stop " +
  "early, so a request for a file comes back as a paragraph about the file. A download goal must " +
  "say plainly that the file is to be downloaded, and whether audio or video. " +
  "The agent posts its final report to this chat itself when done (this may take a while), so " +
  "just tell the user you're on it; do not invent results. Set `quiet` only for batch work " +
  "nobody is waiting on: a quiet run posts its report only if the goal failed.";

/** Register the agents MCP tool on the shared server. */
export function registerAgentsMcpTools(server: McpServer): void {
  server.registerTool(
    START_AGENT_TOOL,
    {
      title: "Start a background agent",
      description: START_AGENT_DESCRIPTION,
      inputSchema: {
        goal: z
          .string()
          .min(4)
          .max(MAX_GOAL_LENGTH)
          .describe(
            "A clear, self-contained description of what to find or do. Include ALL links, ids and search terms the user gave. Keep the user's request intact — never add a weaker alternative such as 'or tell me about it', which lets the agent stop before doing the work.",
          ),
        context: z
          .string()
          .trim()
          .max(MAX_CONTEXT_LENGTH)
          .optional()
          .describe(
            "Facts from this conversation the agent needs and cannot see: names, ids, what was already decided, how the result should be presented. Omit when the goal says everything.",
          ),
        quiet: z
          .boolean()
          .optional()
          .describe(
            "True for batch work nobody is waiting on: the final report is posted to the chat only if the goal failed. Default false — the report is posted when the run finishes.",
          ),
      },
      outputSchema: {
        ok: z.boolean(),
        runId: z.string().optional(),
      },
      annotations: {
        readOnlyHint: false,
        // Queues background work that may act through the assistant's tools
        // and post to the chat; the work itself is bounded by those tools.
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ goal, context, quiet }) => {
      const ctx = getToolContext();
      // A run is the assistant working in the background; a turn that names
      // no assistant (a stale binding, a test) has nobody to be, so it is
      // refused rather than guessed — the same rule the task tools follow.
      if (!ctx.assistantId) {
        return {
          content: [{ type: "text" as const, text: NO_ASSISTANT }],
          structuredContent: { ok: false },
          isError: true as const,
        };
      }
      // Owner status gates the download tools for the whole run; resolve it
      // now. It is resolved from the turn's *authority* — the sender normally,
      // but the author of the standing task when a task drove this turn, so an
      // owner's "download any media link posted here" rule works for everyone's
      // links. Provenance stays the real sender either way. Both flags come
      // from the bound context (the source's `sender.isOwner` stamp and the
      // matched task's stamps) — no owner-id comparison here.
      const senderIsOwner = ctx.senderIsOwner === true;
      const authorityIsOwner = ctx.authorityIsOwner === true;
      const isOwner = senderIsOwner || authorityIsOwner;
      // A task drove this turn: `authorityIsOwner` is set only when a standing
      // task matched and its author had rights to lend (never on a direct
      // request, even the owner's own — the matcher is skipped there).
      const ruleDriven = authorityIsOwner;
      // Restricted = downloads are fenced to the message's own links and must
      // attach to the chat or be discarded (user decisions, 2026-08-01): every
      // rule-driven run in a group — the owner's own message included, since a
      // group's audience cannot reach the server's disk — and any run whose
      // rights were lent to a non-owner. The owner's direct requests and their
      // own DM rules stay unrestricted.
      const restricted =
        isOwner &&
        ruleDriven &&
        (!senderIsOwner || (await isGroupChat(undefined, ctx.source, ctx.chatId)));

      const run = await enqueueAgentRun({
        goal,
        context: context ?? null,
        quiet: quiet === true,
        chatRef: scopedRef(ctx.source, "chat", ctx.chatId),
        threadId: ctx.threadId ?? null,
        createdByUserRef: ctx.userId ? scopedRef(ctx.source, "user", ctx.userId) : null,
        // The whole turn binding rides on the run, so the agent's tool calls
        // bind exactly as this turn's do.
        assistantId: ctx.assistantId,
        isOwner,
        senderIsOwner,
        authorityIsOwner,
        correlationId: ctx.correlationId ?? null,
        restricted,
        sourceUrls: ctx.messageUrls ?? [],
      });
      // The turn's reply is now only an acknowledgement of this run — the
      // pipeline sends it silent and removes it once the run reports.
      ctx.onAgentRunEnqueued?.(run.id);
      emitRunEnqueued();

      return {
        content: [
          {
            type: "text" as const,
            text: run.quiet
              ? `Background agent started (quiet). It works on its own and reports here only if the goal fails; ` +
                `tell the user it is running. Do not make up results.`
              : `Background agent started. Tell the user you're on it and will report back here when ` +
                `it is done. Do not make up results — the agent posts them itself.`,
          },
        ],
        structuredContent: { ok: true, runId: run.id },
      };
    },
  );
}
