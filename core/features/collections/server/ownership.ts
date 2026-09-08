import "server-only";

import { ApiError } from "@/lib/api-error";
import { requireAssistantOwnership, type Actor } from "@/server/ownership";
import { getStoreDb } from "@/server/store/db";

import type { Collection } from "../types";
import { getCollectionById } from "./repository";

/**
 * The dashboard's gate on one collection: it exists, and the acting account
 * owns its assistant (an admin owns everything). An unknown id and another
 * account's collection read the same — `not_found` — through the shared
 * ownership helper. Every collection Route Handler starts here.
 */
export async function requireOwnCollection(account: Actor | null, id: string): Promise<Collection> {
  const collection = await getCollectionById(getStoreDb(), id);
  if (!collection) throw ApiError.notFound("Unknown collection");
  await requireAssistantOwnership(account, collection.assistantId);
  return collection;
}
