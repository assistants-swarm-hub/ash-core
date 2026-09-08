import { AlertTriangle, Bug, Database } from "lucide-react";
import Link from "next/link";

import { Button, EmptyState, PageHeader } from "@/components/ui";
import { LiveIndicator } from "@/components/realtime/LiveIndicator";
import { getDownloadStorageHealth } from "@/features/agents/server/download";
import { getAgentRuns } from "@/features/agents/server/service";
import { getAssistants } from "@/features/assistants/server/service";
import {
  getYtDlpJobInfo,
  type YtDlpJobInfo,
} from "@/features/agents/server/ytdlp-scheduler";
import { NewRunForm } from "@/features/agents/ui/NewRunForm";
import { RunsList } from "@/features/agents/ui/RunsList";
import { YtDlpJobCard } from "@/features/agents/ui/YtDlpJobCard";
import type { AgentRun } from "@/features/agents/types";
import { featureDebugHref } from "@/lib/features";

// Runs are read from the database at request time.
export const dynamic = "force-dynamic";

/**
 * Agents dashboard page. Server Component: lists runs and lets the operator
 * start a browser-only one directly. A chat-started run is an assistant working
 * in the background with its tools and a real browser, reporting to its chat; a
 * dashboard-started run has no chat and no assistant, so its report is read
 * here. Live-updates on the `agents` SSE topic.
 */
export default async function AgentsPage() {
  let runs: AgentRun[] | null = null;
  // Display names for the "as …" line of each chat-started run.
  let assistantNames: Record<string, string> = {};
  let dbError: string | null = null;
  try {
    runs = await getAgentRuns();
    assistantNames = Object.fromEntries((await getAssistants()).map((a) => [a.id, a.name]));
  } catch (err) {
    dbError = err instanceof Error ? err.message : "Could not read runs from the database";
  }

  // A real create/unlink probe of the downloads directory. Surfaced here — the page
  // whose runs it breaks — as well as on Overview, because a run only reports the
  // failure once someone has already asked for a file.
  const downloads = await getDownloadStorageHealth();

  // The media downloader's yt-dlp, which goes stale on upstream's schedule rather
  // than this app's. Read independently of the runs above: it needs no database,
  // so it must still be visible on the page that says the database is down.
  const ytdlp: YtDlpJobInfo | null = await getYtDlpJobInfo().catch(() => null);

  return (
    <>
      <PageHeader
        title="Agents"
        description="Background agent runs. An assistant hands a goal to a copy of itself that holds its tools and a real browser, then reports back to the chat. A run started here has no assistant and browses only."
        actions={
          <div className="flex items-center gap-2">
            <LiveIndicator topic="agents" />
            <Button asChild variant="outline" size="sm">
              <Link href={featureDebugHref("agents")}>
                <Bug className="h-4 w-4" aria-hidden />
                Debug
              </Link>
            </Button>
          </div>
        }
      />

      {downloads.ok ? null : (
        <div
          role="alert"
          className="rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-sm"
        >
          <div className="flex items-center gap-2 font-medium text-warning">
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
            Downloads directory is not writable — every download will fail
          </div>
          <p className="mt-1 text-warning/90">{downloads.detail}</p>
          <p className="mt-1 text-muted">
            Browsing and reporting still work; only saving a file does not. Make the
            downloads directory writable by the app user — for a Docker bind mount, fix
            the host directory&apos;s ownership.
          </p>
        </div>
      )}

      {ytdlp ? <YtDlpJobCard initial={ytdlp} /> : null}

      {runs ? (
        <div className="space-y-6">
          <NewRunForm />
          <RunsList runs={runs} assistantNames={assistantNames} />
        </div>
      ) : (
        <EmptyState
          icon={Database}
          title="Database unavailable"
          description={dbError ?? "The agents database could not be reached."}
        />
      )}
    </>
  );
}
