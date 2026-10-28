import type { Db } from "../db/sql";
import { httpUrl } from "../platform/http-url";

// The collections a remote actor's document names, and the request to sync them, which storing an actor makes
// (remote-actors.ts). The sync itself is remote-collections.ts.

// Asks for a sync of the account's collections (ProcessAccountService#check_featured_collection! and
// #check_featured_tags_collection!, and the hide_collections it sets). One request per account waits at a time, as
// Sidekiq's until_executed lock keeps one job; a request while a round holds it is a new generation, which the round's
// end leaves due (endRound), so the round reading the older document does not end it. Whether a request is
// due (no round holds it).
export function requestCollectionSync(db: Db, accountId: string, now: number): boolean {
  // A new request has its own MAX_SYNC_ATTEMPTS, and is due at once unless a round holds the sync (whose end leaves it
  // due, endRound): rounds that failed for the older one neither drop nor delay it.
  const row = db.first<{ due: number }>(
    `INSERT INTO collection_syncs (account_id, due_at) VALUES (?1, ?2)
		ON CONFLICT (account_id) DO UPDATE SET generation = generation + 1, parts_read = 0, attempts = 0,
			due_at = CASE WHEN token IS NOT NULL AND due_at > ?2 THEN due_at ELSE min(due_at, ?2) END
		RETURNING due_at <= ?2 AS due`,
    accountId,
    now,
  );
  return row?.due === 1;
}

// The collections a stored actor document names, http(s) only, as strings (an id given as an object with an id too).
export type ActorCollections = {
  featured: string | null;
  featuredTags: string | null;
  followers: string | null;
  following: string | null;
  outbox: string | null;
};

function idOf(value: unknown): string | null {
  const id =
    typeof value === "string"
      ? value
      : typeof value === "object" && value !== null && typeof (value as { id?: unknown }).id === "string"
        ? (value as { id: string }).id
        : null;
  return httpUrl(id)?.href ?? null;
}

export function actorCollections(raw: string | null): ActorCollections {
  let document: Record<string, unknown> = {};
  try {
    const parsed = raw === null ? null : (JSON.parse(raw) as unknown);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      document = parsed as Record<string, unknown>;
    }
  } catch {
    // A stored document always parses; an unreadable one names no collection.
  }
  return {
    featured: idOf(document.featured),
    featuredTags: idOf(document.featuredTags),
    followers: idOf(document.followers),
    following: idOf(document.following),
    outbox: idOf(document.outbox),
  };
}
