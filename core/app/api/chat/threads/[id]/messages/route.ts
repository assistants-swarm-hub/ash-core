import { DOCUMENT_MAX_BYTES } from "@assistants-swarm-hub/contracts";
import { z } from "zod";

import { ApiError } from "@/lib/api-error";
import { defineRoute, ok, parseJson } from "@/server/http";
import { postChatMessage } from "@/features/web-chat/server/service";

/**
 * Saying something in a thread. The route does not run the turn: the service
 * stores the message and enqueues it, and the answer arrives the same way
 * every other source's does — through the pipeline and back over the bus.
 */

/**
 * Text, an image, a voice note, or a document. The payload arrives base64
 * from the browser and is capped here: the service normalizes an image down
 * to a bounded JPEG and holds a document to the contract's cap, but the route
 * should refuse an upload nobody could want before it is buffered.
 */
const MAX_IMAGE_BASE64 = 16 * 1024 * 1024;
/** The contract's document cap, as base64 (4/3 of the bytes, rounded up). */
const MAX_DOCUMENT_BASE64 = Math.ceil(DOCUMENT_MAX_BYTES / 3) * 4;

const postSchema = z
  .object({
    text: z.string().trim().max(10_000).default(""),
    image: z
      .object({
        dataBase64: z.string().min(1).max(MAX_IMAGE_BASE64),
        mimeType: z.string().max(200).nullable().optional(),
      })
      .optional(),
    audio: z
      .object({
        dataBase64: z.string().min(1).max(MAX_IMAGE_BASE64),
        mimeType: z.string().max(200).nullable().optional(),
      })
      .optional(),
    document: z
      .object({
        dataBase64: z.string().min(1).max(MAX_DOCUMENT_BASE64),
        mimeType: z.string().max(200).nullable().optional(),
        filename: z.string().trim().min(1).max(255),
      })
      .optional(),
  })
  .refine(
    (value) =>
      value.text.length > 0 ||
      value.image !== undefined ||
      value.audio !== undefined ||
      value.document !== undefined,
    { message: "a message needs text, an image, a voice note, a document, or some of each" },
  );

export const POST = defineRoute(async ({ request, params, account }) => {
  if (!account) throw ApiError.unauthorized("Sign in to chat");
  const input = await parseJson(request, postSchema);
  return ok(await postChatMessage(params.id, input, { accountId: account.id }));
}, { access: "account" });
