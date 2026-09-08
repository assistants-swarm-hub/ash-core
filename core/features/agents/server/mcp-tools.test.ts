import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { runWithToolContext } from "@/server/mcp/context";

import { START_AGENT_TOOL, registerAgentsMcpTools } from "./mcp-tools";

/**
 * The `start_agent` gate and binding. Anyone may start a run; the download
 * tools *inside* the run are owner-only, and that is decided here, once, from
 * the turn's authority. The whole turn binding rides on the run, so the agent's
 * tool calls bind exactly as the starting turn's would.
 *
 * Authority is not the same as identity: a standing chat rule lends its author's
 * rights to the actions it calls for ("rule creator beats message source" —
 * user decision, 2026-07-29), so an owner's "download any media link posted
 * here" rule downloads everyone's links. The run's provenance must still record
 * the real sender.
 */

vi.mock("./service", () => ({ enqueueAgentRun: vi.fn() }));
vi.mock("./signal", () => ({ emitRunEnqueued: vi.fn() }));
// A "group" is a chat the directory holds a row for, and the tool asks the
// repository; stubbed so this unit test needs no database.
const { GROUP } = vi.hoisted(() => ({ GROUP: "-1001" }));
vi.mock("@/features/known-groups/server/repository", () => ({
  isGroupChat: vi.fn(async (_db: unknown, _source: string, chatId: string) => chatId === GROUP),
}));

const service = vi.mocked(await import("./service"));

const OWNER = "1";
const OTHER = "77";

type ToolArgs = { goal: string; context?: string; quiet?: boolean };
type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent: unknown;
  isError?: boolean;
};

/** Register the tool on a fake server and hand back its handler and description. */
function handler() {
  let registered: ((args: ToolArgs) => Promise<ToolResult>) | null = null;
  let description = "";
  const server = {
    registerTool: (_name: string, config: { description: string }, fn: unknown) => {
      registered = fn as (args: ToolArgs) => Promise<ToolResult>;
      description = config.description;
    },
  } as unknown as McpServer;
  registerAgentsMcpTools(server);
  return { run: registered!, description };
}

beforeEach(() => {
  vi.clearAllMocks();
  service.enqueueAgentRun.mockImplementation(async (input) => ({ id: "run-1", quiet: input.quiet ?? false }) as never);
});

/** The enqueued run's fields, after invoking the tool in the given context. */
async function enqueuedFrom(
  ctx: {
    userId: string | null;
    senderIsOwner?: boolean;
    authorityIsOwner?: boolean;
    messageUrls?: string[];
    chatId?: string;
    assistantId?: string;
    correlationId?: string;
  },
  args: ToolArgs = { goal: "Download the video at https://example.com/clip" },
) {
  const { run } = handler();
  await runWithToolContext({ source: "acme", chatId: GROUP, assistantId: "asst-0", ...ctx }, () =>
    run(args),
  );
  return vi.mocked(service.enqueueAgentRun).mock.calls[0][0];
}

describe(`${START_AGENT_TOOL} without an assistant`, () => {
  it("refuses a turn that names no assistant, and enqueues nothing", async () => {
    const { run } = handler();
    const result = await runWithToolContext({ source: "acme", chatId: GROUP, userId: OWNER }, () =>
      run({ goal: "Download the video at https://example.com/clip" }),
    );
    expect(result).toMatchObject({ structuredContent: { ok: false } });
    expect(result.content[0].text).toMatch(/no assistant/);
    expect(service.enqueueAgentRun).not.toHaveBeenCalled();
  });
});

describe(`${START_AGENT_TOOL} download rights`, () => {
  it("grants them to the owner's own request, unrestricted", async () => {
    expect(await enqueuedFrom({ userId: OWNER, senderIsOwner: true })).toMatchObject({
      isOwner: true,
      restricted: false,
      createdByUserRef: `acme:user:${OWNER}`,
    });
  });

  it("withholds them from anyone else's own request", async () => {
    expect(await enqueuedFrom({ userId: OTHER })).toMatchObject({
      isOwner: false,
      createdByUserRef: `acme:user:${OTHER}`,
    });
  });

  it("grants them when a rule the owner set drove the turn, whoever sent the message", async () => {
    const enqueued = await enqueuedFrom({ userId: OTHER, authorityIsOwner: true });

    // Borrowed rights restrict the run: downloads are fenced to the triggering
    // message's own links and must attach to the chat or be discarded.
    expect(enqueued).toMatchObject({ isOwner: true, restricted: true });
    // Authority is permission, never identity: the run is still recorded as
    // started by the person whose message triggered it.
    expect(enqueued).toMatchObject({ createdByUserRef: `acme:user:${OTHER}` });
  });

  it("restricts the owner's own rule-driven run in a group", async () => {
    // "It has to be the same for the owner in a group chat" (user decision,
    // 2026-08-01): a rule-driven download in a group is limited to what
    // the chat can take, whoever posted the link — the group's audience cannot
    // reach the server's disk either way.
    expect(
      await enqueuedFrom({ userId: OWNER, senderIsOwner: true, authorityIsOwner: true }),
    ).toMatchObject({
      isOwner: true,
      restricted: true,
    });
  });

  it("leaves the owner's own rule-driven run in their DM unrestricted", async () => {
    expect(
      await enqueuedFrom({
        userId: OWNER,
        senderIsOwner: true,
        authorityIsOwner: true,
        chatId: OWNER,
      }),
    ).toMatchObject({ isOwner: true, restricted: false });
  });

  it("carries the message's code-extracted URLs onto the run verbatim", async () => {
    const urls = ["https://youtu.be/oh9VTJFPzHo?si=7OBKm0Ft5918u0yd"];

    expect(await enqueuedFrom({ userId: OTHER, authorityIsOwner: true, messageUrls: urls })).toMatchObject(
      { sourceUrls: urls },
    );
  });

  it("withholds them when the matched rule's author had none to lend", async () => {
    // `taskLendsOwnerRights` is false for a rule an ordinary user wrote, and
    // that must not be read as "no check needed".
    expect(await enqueuedFrom({ userId: OTHER, authorityIsOwner: false })).toMatchObject({
      isOwner: false,
    });
  });
});

describe(`${START_AGENT_TOOL} turn binding`, () => {
  it("stamps the whole turn onto the run: assistant, both owner flags, correlation", async () => {
    expect(
      await enqueuedFrom({
        userId: OTHER,
        senderIsOwner: false,
        authorityIsOwner: true,
        assistantId: "asst-1",
        correlationId: "corr-1",
      }),
    ).toMatchObject({
      assistantId: "asst-1",
      senderIsOwner: false,
      authorityIsOwner: true,
      correlationId: "corr-1",
      chatRef: `acme:chat:${GROUP}`,
    });
  });

  it("carries the gathered context and the quiet flag, defaulting both", async () => {
    expect(
      await enqueuedFrom(
        { userId: OWNER, senderIsOwner: true },
        { goal: "Fill the gaps in the watchlist", context: "Rows 1-5 lack a description", quiet: true },
      ),
    ).toMatchObject({ context: "Rows 1-5 lack a description", quiet: true });

    vi.clearAllMocks();
    expect(await enqueuedFrom({ userId: OWNER, senderIsOwner: true })).toMatchObject({
      context: null,
      quiet: false,
    });
  });

  it("tells a quiet run's turn that only a failure will be reported", async () => {
    const { run } = handler();
    const result = await runWithToolContext(
      { source: "acme", chatId: GROUP, assistantId: "asst-0", userId: OWNER },
      () => run({ goal: "Fill the gaps in the watchlist", quiet: true }),
    );
    expect(result.content[0].text).toMatch(/quiet/);
    expect(result.content[0].text).toMatch(/only if the goal fails/);
    expect(result.structuredContent).toEqual({ ok: true, runId: "run-1" });
  });
});

describe(`${START_AGENT_TOOL} description`, () => {
  // The description carries what browse_web's earned in production and the
  // one case a browsing tool never had: work that has to act through tools.
  it("keeps the must-call cases and adds the act-on-it case", () => {
    const { description } = handler();
    for (const phrase of [
      "ONLY way you can reach the internet",
      "asks you to look something up",
      "shares a URL",
      "asks to download or save a file",
      "names a site or service",
      "LIVE or CURRENT value",
      "multi-step interaction on the web",
      "has to act on what it finds",
      "many steps or minutes",
    ]) {
      expect(description).toContain(phrase);
    }
  });

  it("forbids the refusal, the weaker alternative, and invented results", () => {
    const { description } = handler();
    expect(description).toContain("that refusal is wrong");
    expect(description).toContain("add NO easier alternative");
    expect(description).toContain("do not invent results");
  });

  it("explains context and quiet without naming any other tool", () => {
    const { description } = handler();
    expect(description).toContain("does not see this conversation");
    expect(description).toContain("`context`");
    expect(description).toContain("`quiet`");
    expect(description).not.toMatch(/browse_web|send_message|rows_|tasks_create/);
  });
});

describe(`${START_AGENT_TOOL} acknowledgement wiring`, () => {
  it("reports the enqueued run to the turn, so its reply becomes the deletable ack", async () => {
    const runIds: string[] = [];
    const { run } = handler();

    await runWithToolContext(
      {
        source: "acme",
        chatId: GROUP,
        assistantId: "asst-0",
        userId: OWNER,
        onAgentRunEnqueued: (id) => runIds.push(id),
      },
      () => run({ goal: "Download the video at https://example.com/clip" }),
    );

    expect(runIds).toEqual(["run-1"]);
  });
});
