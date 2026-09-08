import "server-only";

import { documentFormatOf, type DocumentFormat } from "@assistants-swarm-hub/contracts";

import type { MediaRecord } from "@/features/vision/server/repository";
import { getMediaDetail } from "@/features/vision/server/service";

/**
 * Documents domain service — the read side of a file someone sent in a chat.
 * A document is a media row (a transport's or the web chat's) of kind
 * `document`, born described with its label and holding its bytes; this is
 * the one place that resolves such a row by id, wherever it lives, and hands
 * back what a reader needs: the record, the bytes, the format.
 */

export interface StoredDocument {
  record: MediaRecord;
  bytes: Buffer;
  format: DocumentFormat;
}

/**
 * A stored document by media id, or null when the id is unknown, is not a
 * document, or holds no bytes (refused at ingest). Which source holds it is
 * not the caller's concern — ids are unique across sources.
 */
export async function getDocument(id: string): Promise<StoredDocument | null> {
  const record = await getMediaDetail(id);
  if (!record || record.kind !== "document" || !record.dataBase64) return null;
  const format = documentFormatOf({ filename: record.filename, mimeType: record.mimeType });
  if (!format) return null;
  return { record, bytes: Buffer.from(record.dataBase64, "base64"), format };
}
