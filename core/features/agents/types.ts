/**
 * Client-safe shared types for the agents feature. Imported by the server
 * service/repository/runner, the Route Handlers, and the dashboard UI — so it
 * must stay free of any server-only import.
 */

/** The one tool a chat turn starts a background agent with. */
export const START_AGENT_TOOL = "start_agent";
/** Bounds on what a turn may hand a run. */
export const MAX_GOAL_LENGTH = 4000;
export const MAX_CONTEXT_LENGTH = 4000;

/** Lifecycle of a run: queued → running → done | failed. */
export const AGENT_RUN_STATUSES = ["queued", "running", "done", "failed"] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

/**
 * One download completed by a run (structural twin of the jsonb shape on
 * `agent_runs.downloads`).
 */
export interface BrowserDownloadRecord {
  /** The page the file came from (the link the agent was on). */
  sourceUrl: string;
  filename: string;
  sizeBytes: number;
  /**
   * True when the file itself reached the chat — in which case the server copy was
   * removed. False means it is still in the downloads folder: too large to attach,
   * or the delivery failed.
   *
   * Runs recorded before 2026-07-29 carry the older `inline` flag instead and so
   * read as false here — correct for them, since back then every file was kept.
   */
  deliveredToChat: boolean;
  /**
   * True when the file was deleted instead of kept: a restricted run's
   * download that was too large to attach. The chat's audience has no access
   * to the server's downloads folder, so keeping it would strand a file nobody
   * can reach (user decision, 2026-08-01 — attach or fail).
   */
  discarded?: boolean;
}

/**
 * One completed browser action within a run, for the live activity feed. Appended
 * as each tool finishes, so the operator sees exactly what the agent did and in
 * what order (and where it failed).
 */
export interface AgentRunStep {
  /** Order within the run, starting at 1. */
  seq: number;
  /** The tool that ran, e.g. `browser_navigate`, `browser_get_network`. */
  tool: string;
  /** Human action label, e.g. "navigate example.com", "download stream …". */
  action: string;
  /** Page URL at the time of the action, or null. */
  url: string | null;
  /** Whether the action succeeded. */
  ok: boolean;
  /** Short one-line outcome (page title, "5 m3u8 found", an error message, …). */
  summary: string;
  /** ISO timestamp the action finished. */
  at: string;
}

/**
 * Ephemeral live state of a run in flight (never persisted): what the agent is
 * doing *right now* and, during a download, its progress. Held in memory by the
 * runner and merged into the run detail while `status = 'running'`.
 */
export interface AgentRunLiveState {
  /** The in-flight action label ("downloading stream …"), or null between steps. */
  currentAction: string | null;
  /** Live download progress line (bytes/speed, or ffmpeg size/time), or null. */
  progress: string | null;
}

/**
 * One search source's standing on the scoreboard the cascade sorts itself by.
 * Client-safe: the dashboard can show why the agent tries them in this order.
 */
export interface EngineStat {
  /** Source name (`DuckDuckGo`, `Google`, `Bing`, `Tavily`). */
  engine: string;
  successes: number;
  failures: number;
  /** Smoothed success rate in [0, 1] — what the ordering is actually sorted on. */
  successRate: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  /** Why the last failure failed, or null. */
  lastError: string | null;
}

/** A agent run as returned to clients (no secrets — all fields are safe). */
export interface AgentRun {
  id: string;
  /** Scoped ref of the chat the run acts in and reports to (`acme:chat:42`). */
  chatRef: string;
  /** Source-local forum-topic thread, or null (chat root) — the platform's own id. */
  threadId: string | null;
  createdByUserRef: string | null;
  /**
   * The assistant the run acts as — persona composed, its toolset offered,
   * its tool calls bound as a turn's. Every run has one: a run is only ever
   * started by a chat turn (user decision, 2026-09-08).
   */
  assistantId: string;
  /** Whether the run carries owner rights (download tools enabled). */
  isOwner: boolean;
  /** The sender's own owner rights, as the source stamped the starting turn. */
  senderIsOwner: boolean;
  /** Owner permissions lent by the standing task that drove the starting turn. */
  authorityIsOwner: boolean;
  /** The starting turn's trace correlation, or null (the run id then stands). */
  correlationId: string | null;
  /**
   * True when a standing chat rule drove the run in a group chat (the owner's
   * own message included), or lent the sender rights they did not hold. A
   * restricted run's downloads are constrained to `sourceUrls` and must attach
   * to the chat or be discarded — a group chat's audience cannot reach the
   * server's downloads folder. The owner's direct requests and their own DM
   * rules stay unrestricted.
   */
  restricted: boolean;
  /**
   * The http(s) URLs of the triggering chat message, extracted in code —
   * verbatim, never re-typed by a model. Empty for a message without links.
   */
  sourceUrls: string[];
  goal: string;
  /** Facts the starting turn gathered for the agent, or null. */
  context: string | null;
  /** Whether the final report is posted to the chat only when the goal failed. */
  quiet: boolean;
  status: AgentRunStatus;
  /**
   * The agent's final report, or null while unfinished. A run failed by the
   * outcome verdict (the report itself said the goal failed) keeps its report;
   * a run failed by a thrown error has none.
   */
  report: string | null;
  /** Failure reason when `status = 'failed'`. */
  error: string | null;
  /** Browser actions performed. */
  steps: number;
  downloads: BrowserDownloadRecord[];
  /** Trace id of the run's execution trace, for Debug drill-down. */
  traceId: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** Run detail: the run plus its activity feed, screenshots, and live state. */
export interface AgentRunDetail extends AgentRun {
  /** Every completed action, in order — the activity feed. */
  activity: AgentRunStep[];
  /** Capture-order sequence numbers of stored screenshots. */
  screenshotSeqs: number[];
  /** Live state while running (current action + download progress); null when settled. */
  live: AgentRunLiveState | null;
}
