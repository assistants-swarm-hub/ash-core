/**
 * Human-readable byte size (KB/MB/GB), one way everywhere a size is shown: a
 * download's progress line, a run's file list, a document's transcript
 * annotation. Client-safe (no node imports). Moved here from the agents
 * feature's filename helpers when documents became its second consumer.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(gb < 10 ? 2 : 1)} GB`;
}
