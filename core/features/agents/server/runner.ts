import "server-only";

import { rm } from "node:fs/promises";

import { getStoreDb, type StoreDb } from "@/server/store/db";
import { sourceOutbound } from "@/server/turn/source-outbound";
import {
  getBrowserDownloadLimitBytes,
  getBotPolicy,
  getAgentLlmRuntime,
} from "@/features/settings/server/service";
import { WEB_CHAT_SOURCE, parseScopedRef } from "@assistants-swarm-hub/contracts";

import { getAssistantPersona } from "@/features/assistants/server/service";
import { buildCollectionsBlock } from "@/features/collections/format";
import { getVisibleCollections } from "@/features/collections/server/service";
import { getChatLanguage } from "@/features/known-groups/server/service";
import { getToolset, type Toolset } from "@/features/mcp-tools/server/service";
import { FEATURES } from "@/lib/features";
import { resolveRequiredLanguage } from "@/lib/language";
import { chatCompletion, type LlmConnection } from "@/server/llm/client";
import { withAdvisoryLock } from "@/server/jobs/lock";
import { runWithToolContext } from "@/server/mcp/context";
import { publishEvent } from "@/server/realtime/hub";
import { startTrace, type TraceRecorder } from "@/server/trace";

import type { AgentRun, BrowserDownloadRecord } from "../types";
import { takeRunAck } from "./ack";
import { runAgent } from "./agent";
import {
  buildRunOutcomeMessages,
  parseRunOutcomeVerdict,
  type RunOutcomeVerdict,
} from "./outcome";
import { formatDownloadLine, formatRunReport } from "../format";
import { getDownloadStorageHealth } from "./download";
import { clearLiveState, setLiveAction, setLiveProgress } from "./live-state";
import {
  appendAgentRunStep,
  claimAgentRun,
  failStaleRunningRuns,
  insertAgentRunScreenshot,
  listQueuedAgentRuns,
  setAgentRunTrace,
  settleAgentRun,
} from "./repository";
import { BrowserSession } from "./session";
import { runTurnBinding, shouldPostReport } from "./run-binding";
import { setRunEnqueuedListener } from "./signal";
import {
  summarizeResult,
  type BrowserToolContext,
  type CollectedFile,
  type DownloadOutcome,
} from "./tools";

/**
 * The agent runner: an in-process queue pump, the same operating model as
 * the tasks poller (recorded background-job decision). A single run
 * executes at a time; the queue is the `agent_runs` table. Enqueuers
 * signal via `signal.ts`, and a crash-safety sweep at boot fails any run left
 * `running` by a previous process.
 *
 * A run is the assistant working in the background: the runner binds the
 * turn the run came from (assistant, chat, sender, owner rights, correlation
 * — `deliveryKind: "send"`, sends silent) around the agent loop, so every
 * tool call reads and writes as that turn would, and offers the assistant's
 * toolset next to the browser (user decision, 2026-09-08). Every run is a
 * chat turn's; nothing else starts one.
 *
 * Delivery: each downloaded file is staged and posted with the agent's final
 * report as one message; the report is mirrored into history. A quiet run
 * posts its report only when the goal failed or a file was downloaded.
 */

const FEATURE = FEATURES["agents"];
const JOB_NAME = "agents";

let started = false;
let pumping = false;
let active = false;

/**
 * The outbound port of the transport a chat ref names, or an audible failure
 * — the runner delivers through the owning transport's internal API, which
 * mirrors what it sends; an unregistered transport fails a delivery exactly
 * like v1's stopped poller did.
 */
function requireOutbound(chatRef: string) {
  const { source } = parseScopedRef(chatRef);
  const port = sourceOutbound(source);
  if (!port) {
    throw new Error(`the ${source} transport is not registered — nothing can deliver to ${chatRef}`);
  }
  return port;
}

/** The transport-local chat id a ref names. */
const chatIdOf = (chatRef: string): string => parseScopedRef(chatRef).id;

/** Deliver text to the run's chat (the transport mirrors the sent message). */
async function deliverText(
  run: AgentRun,
  text: string,
  opts: { silent?: boolean } = {},
): Promise<string | null> {
  if (!text.trim()) return null;
  // Sent whole — the report is already concise, and a run recap rarely
  // exceeds one message.
  const { sourceMessageId } = await requireOutbound(run.chatRef).sendMessage(
    chatIdOf(run.chatRef),
    {
      text,
      threadId: run.threadId,
      ...(opts.silent ? { silent: true } : {}),
    },
  );
  return sourceMessageId;
}

/**
 * How long a file's caption may be before the report travels as a separate
 * message. Every platform the core has met caps captions well below a
 * message; the transport still cuts whatever it must — this only picks the
 * nicer of two honest shapes.
 */
const CAPTION_MAX = 1024;

/** One attachable file held until the end of the run, delivered with the report. */
interface StagedFile {
  record: BrowserDownloadRecord;
  file: CollectedFile;
}

/**
 * Send one staged file to the chat, as playable media where the container
 * allows. On success the record is marked delivered and the server copy removed
 * — the chat is now the file's home. Resolves the delivered message id, or null
 * when the send failed (the file then stays in the downloads folder and the
 * recap points there).
 */
async function sendStagedFile(
  run: AgentRun,
  staged: StagedFile,
  caption: string,
): Promise<string | null> {
  try {
    const { sourceMessageId } = await requireOutbound(run.chatRef).sendFile(chatIdOf(run.chatRef), {
      buffer: staged.file.buffer,
      filename: staged.file.filename,
      mime: staged.file.mime,
      caption,
      threadId: run.threadId,
    });
    staged.record.deliveredToChat = true;
    // A failed unlink leaves a stray file, not a wrong answer — the chat still
    // has it, so the record stays truthful and only the disk hygiene is off.
    await rm(staged.file.filePath, { force: true }).catch((err: unknown) => {
      console.error(
        `agents: delivered "${staged.file.filename}" but could not remove the server copy:`,
        err instanceof Error ? err.message : String(err),
      );
    });
    return sourceMessageId;
  } catch (err) {
    console.error(
      `agents: failed to deliver "${staged.file.filename}" for run ${run.id}:`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/**
 * Deliver the end of a run as ONE message wherever possible: a single staged
 * file rides with the report as its caption; with several files (or a report
 * over the caption cap) each file goes out under its own line and the report
 * follows. The recap only lists files that did NOT reach the chat — a delivered
 * attachment speaks for itself. Resolves what was sent as the report-bearing
 * message (for history + trace), or null when nothing could be delivered.
 */
async function deliverRunOutcome(
  run: AgentRun,
  report: string,
  staged: StagedFile[],
  downloads: BrowserDownloadRecord[],
): Promise<{ content: string; sourceMessageId: string; hasMedia: boolean } | null> {
  if (staged.length === 1) {
    const others = downloads.filter((d) => d !== staged[0].record && !d.deliveredToChat);
    const caption = formatRunReport(report, others);
    if (caption.length <= CAPTION_MAX) {
      const sourceMessageId = await sendStagedFile(run, staged[0], caption);
      if (sourceMessageId != null) return { content: caption, sourceMessageId, hasMedia: true };
      // Fall through: the file could not be sent, so it is undelivered and the
      // text recap below names it in the downloads folder.
    } else {
      await sendStagedFile(
        run,
        staged[0],
        formatDownloadLine({ ...staged[0].record, deliveredToChat: true }),
      );
    }
  } else {
    for (const one of staged) {
      await sendStagedFile(run, one, formatDownloadLine({ ...one.record, deliveredToChat: true }));
    }
  }
  const recap = formatRunReport(report, downloads.filter((d) => !d.deliveredToChat));
  // A report that only announces an undeliverable file is sent without a ping
  // (user decision, 2026-08-01) — there is nothing for the user to act on.
  const silent = downloads.some((d) => d.discarded);
  const sourceMessageId = await deliverText(run, recap, { silent }).catch((err) => {
    console.error(
      `agents: failed to deliver the report for run ${run.id}:`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  });
  return sourceMessageId != null ? { content: recap, sourceMessageId, hasMedia: false } : null;
}

/**
 * Remove the chat's "on it" acknowledgement now that the run has spoken for
 * itself (the ack was sent silent and exists only to bridge the wait). Marks the
 * run settled in the ack store either way, so an acknowledgement that arrives
 * *after* the run finished is deleted at registration instead of surviving
 * forever. Best-effort — a message the platform refuses to delete (too old, say)
 * just stays.
 */
async function removeRunAck(runId: string): Promise<void> {
  const ack = takeRunAck(runId);
  if (!ack) return;
  for (const sourceMessageId of ack.sourceMessageIds) {
    try {
      // The source deletes and soft-deletes its mirror row together;
      // `deleted: false` (older than 48h) just leaves the ack standing.
      await requireOutbound(ack.chatRef).deleteMessage(chatIdOf(ack.chatRef), sourceMessageId);
    } catch (err) {
      console.error(
        `agents: could not remove the acknowledgement message ${sourceMessageId} for run ${runId}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

/** Cap on the outcome verdict answer — a tiny JSON object, not an essay. */
const OUTCOME_CHECK_MAX_TOKENS = 500;

/**
 * Ask the classifier whether the report states the goal failed, recording the
 * exchange on the run trace. Never throws: a provider failure here abstains and
 * the run settles `done` — the check reclassifies failures, it must not create
 * a new way for successful runs to break.
 */
async function judgeRunOutcome(
  conn: LlmConnection,
  model: string,
  goal: string,
  report: string,
  trace: TraceRecorder,
): Promise<RunOutcomeVerdict> {
  const messages = buildRunOutcomeMessages({ goal, report });
  try {
    const result = await chatCompletion(conn, {
      model,
      messages,
      reasoning: "off",
      maxTokens: OUTCOME_CHECK_MAX_TOKENS,
      trace: { recorder: trace, callKind: "run-outcome-check", label: "run outcome check" },
    });
    return parseRunOutcomeVerdict(result.content, { report });
  } catch (err) {
    await trace.event({
      type: "error",
      level: "warn",
      message: "run outcome check failed — run settles as done",
      data: { error: err instanceof Error ? err.message : String(err) },
    });
    return {
      goalFailed: false,
      outcome: null,
      quote: null,
      reason: "outcome check call failed",
    };
  }
}

/** Execute one claimed run to completion. Never throws — always settles the run. */
async function runOne(run: AgentRun, db: StoreDb): Promise<void> {
  active = true;
  publishEvent(FEATURE.realtimeTopic);

  const trace = await startTrace({
    feature: FEATURE.id,
    action: "run",
    trigger: {
      kind: parseScopedRef(run.chatRef).source === WEB_CHAT_SOURCE ? "chat" : "transport",
      actor: run.chatRef,
      correlationId: run.id,
    },
    inputSummary: run.goal,
  });
  await setAgentRunTrace(db, run.id, trace.id).catch(() => undefined);

  const session = new BrowserSession();
  const downloads: BrowserDownloadRecord[] = [];
  /** Attachable files held for the end-of-run combined message (file + report). */
  const staged: StagedFile[] = [];
  let screenshotSeq = 0;

  try {
    const runtime = await getAgentLlmRuntime();
    if (!runtime) {
      await trace.skip("LLM not configured");
      await settleAgentRun(db, run.id, {
        status: "failed",
        error: "No LLM is configured.",
        downloads: [],
      });
      return;
    }

    const [downloadLimitBytes, storedLanguage] = await Promise.all([
      getBrowserDownloadLimitBytes(),
      getChatLanguage(parseScopedRef(run.chatRef).source, chatIdOf(run.chatRef)).catch(
        () => null,
      ),
    ]);

    const toolContext: BrowserToolContext = {
      session,
      isOwner: run.isOwner,
      // A rule lends the owner's rights only for the links that triggered it;
      // an owner-started run downloads without a URL fence.
      allowedDownloadUrls: run.restricted ? run.sourceUrls : null,
      // The core sets no platform ceiling (user decision, 2026-09-02): a file
      // is attachable up to the operator's own download limit, and the
      // transport decides what its platform can carry.
      downloadMaxMb: Math.max(1, Math.floor(downloadLimitBytes / (1024 * 1024))),
      downloadLimitBytes,
      downloads,
      onAction: (action, url) => {
        // Reflect the in-flight action immediately for the live "current action"
        // indicator; the completed-step record (with outcome) follows in onStep.
        setLiveAction(run.id, url ? `${action} — ${url}` : action);
      },
      onStep: async (step) => {
        setLiveAction(run.id, null);
        await appendAgentRunStep(db, run.id, {
          tool: step.tool,
          action: step.action,
          url: step.url,
          ok: step.ok,
          summary: step.summary,
          at: new Date().toISOString(),
        }).catch(() => undefined);
        await trace.event({
          type: "external_call",
          level: step.ok ? "info" : "warn",
          message: `browser: ${step.action}`,
          data: { tool: step.tool, url: step.url, ok: step.ok, summary: step.summary },
        });
        // A completed step is a discrete, low-frequency event — refresh the list
        // (step count) and any open detail. Live progress within a download is not
        // published here; the detail view polls for that.
        publishEvent(FEATURE.realtimeTopic);
      },
      onProgress: (line) => setLiveProgress(run.id, line),
      onScreenshot: async ({ buffer, url, title }) => {
        const seq = screenshotSeq++;
        await insertAgentRunScreenshot(db, { runId: run.id, seq, url, title, data: buffer }).catch(
          () => undefined,
        );
        return seq;
      },
      onDownload: async (record, file) => {
        let outcome: DownloadOutcome = "kept";
        if (file) {
          // Held for the end of the run: the file goes out together with the
          // report as one combined message instead of two.
          staged.push({ record, file });
          outcome = "staged";
        } else if (run.restricted) {
          // Attach or fail (user decision, 2026-08-01): a restricted run's
          // audience cannot reach the server's disk, so a file the chat cannot
          // take is deleted by the dispatcher, not archived. No announcement —
          // the final report carries the failure.
          outcome = "discarded";
        } else {
          // Owner's run, too large to attach — announce it by name as it lands
          // (silent); the recap points at the downloads folder.
          await deliverText(run, formatDownloadLine(record), { silent: true }).catch((err: unknown) => {
            console.error(
              `agents: failed to announce a download for run ${run.id}:`,
              err instanceof Error ? err.message : String(err),
            );
          });
        }
        await trace.event({
          type: "db",
          message: "download",
          data: {
            filename: record.filename,
            sizeBytes: record.sizeBytes,
            sourceUrl: record.sourceUrl,
            staged: outcome === "staged",
            discarded: outcome === "discarded",
          },
        });
        publishEvent(FEATURE.realtimeTopic);
        return outcome;
      },
    };

    const conn: LlmConnection = {
      baseUrl: runtime.baseUrl,
      apiKey: runtime.apiKey,
      backend: runtime.backend,
    };
    // The run acts as its assistant: its persona composed in, its toolset
    // offered next to the browser, every tool call bound to the turn the run
    // came from. Each non-browser call is recorded on the activity feed like
    // a browser action (the call's own trace is the registry's). A persona
    // resolves to null only when the assistant was deleted mid-flight.
    const binding = runTurnBinding(run);
    const persona = await getAssistantPersona(run.assistantId).catch(() => null);
    // The run sees the assistant's collections with the rights its turn
    // carried — the same gate its tool calls take.
    const ownerRights = run.senderIsOwner || run.authorityIsOwner;
    const collections = await getVisibleCollections(
      { kind: "chat", assistantId: run.assistantId, ownerRights },
      db,
    )
      .then((list) => buildCollectionsBlock(list, { ownerRights }))
      .catch(() => null);
    const assistantToolset = await getToolset({
      delivery: "send",
      source: binding.source,
      assistantId: binding.assistantId,
      db,
    }).catch(() => null);
    const assistantTools: Toolset | null = assistantToolset
      ? {
          tools: assistantToolset.tools,
          callTool: async (name, args) => {
            setLiveAction(run.id, name);
            const result = await assistantToolset.callTool(name, args);
            setLiveAction(run.id, null);
            const summary = summarizeResult(result);
            await appendAgentRunStep(db, run.id, {
              tool: name,
              action: name,
              url: null,
              ok: !result.isError,
              summary,
              at: new Date().toISOString(),
            }).catch(() => undefined);
            await trace.event({
              type: "external_call",
              level: result.isError ? "warn" : "info",
              message: `tool: ${name}`,
              data: { tool: name, ok: !result.isError, summary },
            });
            publishEvent(FEATURE.realtimeTopic);
            return result;
          },
        }
      : null;
    await trace.event({
      type: "step",
      message: "acting as the assistant",
      data: {
        assistantId: run.assistantId,
        personaComposed: persona !== null,
        collectionsComposed: collections !== null,
        assistantTools: assistantTools?.tools.map((tool) => tool.function.name) ?? [],
        quiet: run.quiet,
      },
    });

    const execute = () =>
      runAgent({
        goal: run.goal,
        context: run.context,
        quiet: run.quiet,
        sourceUrls: run.sourceUrls,
        conn,
        model: runtime.model,
        toolContext,
        assistantTools,
        persona,
        collections,
        requiredLanguage: resolveRequiredLanguage(storedLanguage) ?? null,
        trace: {
          recorder: trace,
          callKind: "agent-report",
          toolTurnCallKind: "agent-turn",
          label: "agent",
        },
      });
    const result = await runWithToolContext(binding, execute);

    const report = result.report || "I browsed but couldn't find anything useful.";

    // Outcome verdict — the report's own language decides done vs failed. The
    // agent is instructed to end an unachievable goal with an honest failure
    // report, and settling that as `done` is how failed runs sat green on the
    // dashboard. The model judges the language; code records the enum and
    // verifies the citation (see `outcome.ts`). Fails open: an unreadable or
    // unbacked verdict settles `done`, exactly as before the check existed.
    const verdict = await judgeRunOutcome(conn, runtime.model, run.goal, report, trace);

    // Deliver the outcome — file(s) + report, combined where possible. The
    // owning source mirrors what it delivers (caption or text), so there is
    // nothing to record here beyond the trace. A failed goal delivers the
    // same way: the report IS the honest failure message.
    if (shouldPostReport(run, verdict, staged.length)) {
      const delivered = await deliverRunOutcome(run, report, staged, downloads);
      if (delivered != null) {
        await trace.event({
          type: "output",
          level: "success",
          message: delivered.hasMedia ? "send report with file" : "send report",
          data: { content: delivered.content, sourceMessageId: delivered.sourceMessageId },
        });
      }
    } else {
      await trace.event({
        type: "step",
        message: "quiet run: report stored, not posted",
        data: { report },
      });
    }
    // The run has spoken for itself (or was asked not to) — the silent
    // "on it" ack can go.
    await removeRunAck(run.id);

    if (verdict.goalFailed) {
      await settleAgentRun(db, run.id, {
        status: "failed",
        report,
        error: `The agent reported the goal failed: "${verdict.quote}"`,
        downloads,
      });
      // Failed, not succeeded: a run that did not achieve its goal must be
      // findable on the Debug page — a green trace over a failure report is
      // exactly how these sat unnoticed.
      await trace.fail(new Error(`goal not achieved — ${verdict.reason}`), {
        relatedIds: { [FEATURE.relatedIdsKey!]: [run.id] },
      });
      return;
    }

    await settleAgentRun(db, run.id, {
      status: "done",
      report,
      downloads,
    });
    await trace.succeed({
      outputSummary: report.slice(0, 200),
      relatedIds: { [FEATURE.relatedIdsKey!]: [run.id] },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A file the run did download must still reach the chat, failure or not —
    // delivered before the settle so the persisted records say what happened.
    for (const one of staged) {
      await sendStagedFile(run, one, formatDownloadLine({ ...one.record, deliveredToChat: true }));
    }
    await settleAgentRun(db, run.id, {
      status: "failed",
      error: message,
      downloads,
    }).catch(() => undefined);
    // Tell the chat the run failed, so a user is never left waiting on a promise.
    await deliverText(run, "I hit a problem while working on this and had to stop.").catch(
      () => undefined,
    );
    await removeRunAck(run.id);
    await trace.fail(err);
  } finally {
    clearLiveState(run.id);
    await session.close();
    active = false;
    publishEvent(FEATURE.realtimeTopic);
  }
}

/**
 * Drain the queue: one run at a time, paused during maintenance. Guarded so
 * overlapping triggers (a poll + an enqueue signal) don't double-drain. The
 * advisory lock additionally guards cross-process overlap during a redeploy.
 */
async function pump(db: StoreDb): Promise<void> {
  if (!started || pumping || active) return;
  pumping = true;
  try {
    for (;;) {
      if (!started) break;
      const policy = await getBotPolicy().catch(() => null);
      if (policy?.maintenanceModeEnabled) break;

      const queued = await listQueuedAgentRuns(db).catch(() => []);
      if (queued.length === 0) break;

      const outcome = await withAdvisoryLock(
        JOB_NAME,
        async () => {
          // Re-claim under the lock: the row must still be queued (another process
          // in a redeploy overlap may have taken it).
          const claimed = await claimAgentRun(db, queued[0].id);
          if (!claimed) return false;
          publishEvent(FEATURE.realtimeTopic);
          await runOne(claimed, db);
          return true;
        },
        db,
      );
      // Lock held elsewhere, or the row was already taken — stop this drain; the
      // holder will finish the queue (or the next signal re-triggers us).
      if (!outcome.ran || outcome.result === false) break;
    }
  } finally {
    pumping = false;
  }
}

/** Start the runner (boot): sweep stale runs, then drain any backlog. Idempotent. */
export function startAgentRunner(db: StoreDb = getStoreDb()): void {
  if (started) return;
  started = true;
  setRunEnqueuedListener(() => void pump(db));
  void (async () => {
    // Probe the download write path at boot so an unwritable mount screams in the
    // server log immediately — not on the first user who asks for a file. The
    // dashboard reads the same health (Overview card, /api/health, this page's
    // notice); this is only the log line. Never gates the runner: a run that needs
    // no download still works, and one that does reports its own failure.
    const storage = await getDownloadStorageHealth().catch(() => null);
    if (storage && !storage.ok) {
      console.error(
        `Agent downloads directory is NOT writable (${storage.detail}). Downloads will fail until this is fixed; for a Docker bind mount, fix the host directory's ownership.`,
      );
    }
    await failStaleRunningRuns(db).catch(() => undefined);
    void pump(db);
  })();
}

/** Stop the runner (shutdown). A run in flight finishes; no new runs are claimed. */
export function stopAgentRunner(): void {
  started = false;
  setRunEnqueuedListener(null);
}

/** Whether a run is currently executing (for the dashboard status card). */
export function isAgentRunning(): boolean {
  return active;
}
