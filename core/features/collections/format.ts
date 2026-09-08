import { ratingScale } from "./columns";
import type { Collection, CollectionColumn } from "./types";

/**
 * Pure prompt composition for collections. Client-safe (types only), so the
 * dashboard can preview exactly the block the assistant is given.
 *
 * The block is what makes the tools usable without a list tool: it names
 * every collection the turn may see with its id, its columns in one line
 * each, and how many rows still have gaps — the number a fill-the-gaps loop
 * ends on (user decision, 2026-09-08: code reports the gaps, the model ends
 * the task). The two instructions ride along verbatim; they are the
 * owner's own words about how to fill and how to present.
 */

/** One column as the model reads it: `key (type, key column, needed)`. */
function columnLine(column: CollectionColumn): string {
  const notes: string[] = [column.type];
  if (column.type === "enum" && column.options?.length) notes.push(`one of: ${column.options.join(" / ")}`);
  if (column.type === "rating") notes.push(`0-${ratingScale(column)}`);
  if (column.isKey) notes.push("KEY");
  if (column.requiredForComplete) notes.push("needed for complete");
  const label = column.label !== column.key ? ` "${column.label}"` : "";
  return `${column.key}${label} (${notes.join(", ")})`;
}

/** One collection as a compact paragraph. */
function collectionBlock(collection: Collection): string {
  const lines = [
    `- ${collection.name} — id ${collection.id}, ${collection.rowCount} rows` +
      (collection.gapCount > 0 ? `, ${collection.gapCount} with gaps` : ", no gaps") +
      (collection.visibility === "shared" ? ", shared with everyone in the chat" : ", private to the owner") +
      (collection.description.trim() ? `. ${collection.description.trim()}` : ""),
    `  columns: ${collection.columns.map(columnLine).join("; ")}`,
  ];
  if (collection.fillInstruction.trim()) {
    lines.push(`  how to fill gaps: ${collection.fillInstruction.trim()}`);
  }
  if (collection.presentationInstruction.trim()) {
    lines.push(`  how to present an item: ${collection.presentationInstruction.trim()}`);
  }
  return lines.join("\n");
}

/**
 * The collections block for a turn, or null when the turn sees none. The
 * closing lines bind the block to behaviour a small model gets wrong
 * otherwise: data is read and written through the tools, never recalled
 * from the block or the transcript, and a "gaps" number of zero is what
 * ends a fill loop.
 */
export function buildCollectionsBlock(
  collections: readonly Collection[],
  options: { ownerRights: boolean },
): string | null {
  if (collections.length === 0) return null;
  const rights = options.ownerRights
    ? "The sender holds owner rights: you may add, update and delete rows and change collections."
    : "The sender does not hold owner rights: you may only read and query; refuse writes politely.";
  return (
    "Your collections — structured data you keep (each row is one item; a row is complete when every " +
    "column marked \"needed for complete\" holds a value):\n" +
    collections.map(collectionBlock).join("\n") +
    "\n\nRead and write this data ONLY through the collection tools, by collection id — the counts above " +
    "are a summary, not the data, and the transcript is not the data either. A row's key column decides " +
    "identity: writing a row whose key already exists updates that row. Ask the owner before creating " +
    "a new collection or changing columns; confirm what you propose in plain words first. " +
    "A collection with no rows with gaps is filled: a job whose purpose was filling gaps is done and " +
    "should say so once, then end itself. " +
    rights
  );
}

/** A short line for lists and summaries: `Watchlist (312 rows, 40 with gaps)`. */
export function summarizeCollection(collection: Pick<Collection, "name" | "rowCount" | "gapCount">): string {
  const gaps = collection.gapCount > 0 ? `, ${collection.gapCount} with gaps` : "";
  return `${collection.name} (${collection.rowCount} rows${gaps})`;
}
