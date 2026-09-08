import { documentFormatOf } from "@assistants-swarm-hub/contracts";

import { formatBytes } from "@/lib/format-bytes";

/**
 * Pure formatting for documents: how a stored document is named in a
 * transcript and on the dashboard. Client-safe.
 */

/**
 * The one-line label a document carries as its "description": the name the
 * person gave the file, its format and its size — what a transcript line and
 * a gallery card both show. Stored on the media row at ingest, so a document
 * reads the same everywhere without anyone re-deriving it.
 */
export function documentLabel(file: {
  filename: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
}): string {
  const name = file.filename?.trim() || "document";
  const format = documentFormatOf({ filename: file.filename, mimeType: file.mimeType });
  const parts = [format ? format.toUpperCase() : null, file.sizeBytes != null ? formatBytes(file.sizeBytes) : null]
    .filter((part): part is string => part !== null)
    .join(", ");
  return parts ? `${name} (${parts})` : name;
}

/**
 * What the turn is told about a document on the message it answers: the
 * label and the id it is read by. The tool that reads it self-describes;
 * this names no tool.
 */
export function documentTurnNote(document: { label: string; mediaId: string }): string {
  return (
    `The user sent a document with this message: ${document.label}, id ${document.mediaId}. ` +
    `Its content is not in this message — read the document by that id when the request needs it.`
  );
}

/** The note when the document could not be kept (too large, or not a carried format). */
export const DOCUMENT_UNAVAILABLE_NOTE =
  "The user sent a document with this message, but it could not be kept (too large, or not a " +
  "format that can be read), so its content is not available. Say so if it matters.";
