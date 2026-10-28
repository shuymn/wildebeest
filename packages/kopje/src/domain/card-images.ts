import type { Db } from "../db/sql";
import { FILE_TOKEN } from "../platform/media-files";
import {
  blurhashPastBoundSql,
  CARD_IMAGE_DUE_INDEX,
  CARD_IMAGE_EXPIRY_INDEX,
  CARD_IMAGE_LINK_INDEX,
  CARD_IMAGE_MAX_ATTEMPTS,
  CARD_IMAGE_PENDING_INDEX,
  CARD_IMAGE_STORED_ID_INDEX,
  CARD_IMAGE_STORED_INDEX,
  cardImageEdgeSql,
  cardUrlPastSql,
  SAFE_INTEGER_MAX,
  storedCountSql,
} from "../platform/stored-bounds";
import { allocateLocalId } from "./ids";
import { MEDIA_TOKEN_FREE_SQL, ORPHAN_GRACE_MS } from "./media";
import { mediaDeleteOperation, writeOperation } from "./operation";

// Card images (Mastodon's PreviewCard image, app/models/preview_card.rb, v4.5.11): the Store's part, the only module
// that writes card_images (migration 0070_card_images). The Worker's part, a cron round that fetches, re-encodes and
// stores each image, is federation/card-images.ts. A row holds one image source URL, pending or stored; status_cards
// rows name it (image_id, no foreign key) as copies do (domain/link-cards.ts recordCard, the donor copy):
//
// - Record (link-cards.ts recordCard, linkCardImage): an attached card with an image_url takes a stored row of that URL
//   stored within CARD_FRESH_MS, else a pending one, else a new pending row: at most one row written.
// - A claim (claimCardImages, one per round, at every share, so the expiry and GC run at 0 too) first expires at most
//   CARD_IMAGE_EXPIRE_BATCH pending rows enqueued more than CARD_IMAGE_EXPIRE_MS ago (never an open hold), then, only
//   while fewer than CARD_IMAGE_GC_BACKLOG tombstones are due, collects at most CARD_IMAGE_GC_WALK stored rows from its
//   cursor (a row no status_cards row names gets a tombstone due at once and is deleted), then walks at most
//   CARD_IMAGE_CLAIM_WALK due rows by (due_at, id): each is deleted (unreferenced: C0; given up, expired or a counter
//   past its range: C1) or claimed with one of the Worker's tokens, until the round's claims, the tokens or the month's
//   share (C2) run out; a token any owner holds (MEDIA_TOKEN_FREE_SQL, C3) leaves its row due. The rows after that
//   point are untouched.
// - A claim inserts its tombstone (media_orphans: token, id, due CARD_IMAGE_HOLD_MS + ORPHAN_GRACE_MS after it), so a
//   put that lands after the claim ends is deleted by reconciliation (mastodon/media.ts reconcileMedia); a stored
//   record moves the token to the row and deletes the tombstone in one transaction.
// - The fence (FENCE): the row is pending with the claim's number and an open attempt, and the claim's tombstone (its
//   token and the row's id) exists. admitCardImage checks it as a write (the admissions before the preflight info() and
//   the put), startCardImage also charges one transformation to the month's card counter (images_card_transforms, apart
//   from IMAGES_MONTHLY_TRANSFORMS), once before each of a claim's two Images outputs (its WebP and its RGBA, which
//   Images may bill as one: the counter is a ceiling), recordCardImage records: stored, none (the row deleted, copies
//   keep their dangling id) or unattempted (released, its attempt given back).

export const CARD_IMAGE_HOLD_MS = 5 * 60 * 1000;
export const CARD_IMAGE_EXPIRE_MS = 24 * 60 * 60 * 1000;
export const CARD_IMAGE_EXPIRE_BATCH = 500;
export const CARD_IMAGE_CLAIM_WALK = 64;
export const CARD_IMAGE_GC_WALK = 64;
// Equal to media.ts RECONCILE_BATCH, one reconciliation run's tombstones (test/card-images.test.ts pins them equal).
export const CARD_IMAGE_GC_BACKLOG = 100;
export const CARD_IMAGE_ROUND_CLAIMS = 3;

const GC_CURSOR = "card_images_gc_cursor";
const CARD_TRANSFORMS = "images_card_transforms:";
const DOMAIN = /^[a-z0-9.-]{1,253}$/;
const SNOWFLAKE = /^\d{18}$/;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function state(db: Db, name: string): string | undefined {
  return db.first<{ value: string }>("SELECT value FROM kopje_state WHERE name = ?", name)?.value;
}

function setState(db: Db, name: string, value: string): void {
  db.run("INSERT OR REPLACE INTO kopje_state (name, value) VALUES (?, ?)", name, value);
}

const isTime = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;

// The card transformations charged in the month `now` is in (UTC).
function monthName(now: number): string {
  return `${CARD_TRANSFORMS}${iso(now).slice(0, 7)}`;
}

function used(db: Db, now: number): number {
  const value = Number(state(db, monthName(now)) ?? "0");
  return Number.isSafeInteger(value) && value >= 0 ? value : SAFE_INTEGER_MAX;
}

// ---- Record (domain/link-cards.ts recordCard)

// The image of the attached card of status ?1 linked in SQL from its image_url (never read into the Worker): a row of
// that URL stored after ?2 (now − CARD_FRESH_MS), the latest, else a pending one, else a new pending row ?2 due at
// ?3. Two seeks and at most one row written; nothing without an image_url.
export function linkCardImage(db: Db, statusId: string, fresh: number, now: number): void {
  const found = db.first<{ id: string }>(
    `SELECT i.id FROM status_cards c CROSS JOIN card_images i INDEXED BY ${CARD_IMAGE_STORED_INDEX}
			ON i.source_url = c.image_url AND i.stored_at > ?2
		WHERE c.status_id = ?1 AND c.image_url <> '' AND CAST(i.source_url AS BLOB) = CAST(c.image_url AS BLOB)
			AND i.stored_at IS NOT NULL
		ORDER BY i.stored_at DESC LIMIT 1`,
    statusId,
    fresh,
  );
  const pending =
    found ??
    db.first<{ id: string }>(
      `SELECT i.id FROM status_cards c CROSS JOIN card_images i INDEXED BY ${CARD_IMAGE_PENDING_INDEX}
				ON i.source_url = c.image_url
			WHERE c.status_id = ?1 AND c.image_url <> '' AND CAST(i.source_url AS BLOB) = CAST(c.image_url AS BLOB)
				AND i.due_at IS NOT NULL
			LIMIT 1`,
      statusId,
    );
  let id = pending?.id;
  if (id === undefined) {
    if (db.first("SELECT 1 AS x FROM status_cards WHERE status_id = ?1 AND image_url <> ''", statusId) === undefined) {
      return;
    }
    id = allocateLocalId(db, now);
    db.run(
      `INSERT INTO card_images (id, source_url, due_at, enqueued_at)
			SELECT ?2, image_url, ?3, ?3 FROM status_cards WHERE status_id = ?1 AND image_url <> ''`,
      statusId,
      id,
      now,
    );
  }
  db.run("UPDATE status_cards SET image_id = ?2 WHERE status_id = ?1 AND image_url <> ''", statusId, id);
}

// ---- The round's operations

export type CardImageClaim = { id: string; claim: number; token: string; sourceUrl: string };

export type CardImageClaims = {
  // The instance's domain, for the round's User-Agent; null: nothing was done.
  domain: string | null;
  claims: CardImageClaim[];
  expired: number;
  collected: number;
  // Whether the image GC paused for the reconciliation backlog.
  paused: boolean;
  dropped: number;
};

// A snowflake as read: 18 decimal digits as TEXT, else NULL.
const ID_SQL = `CASE WHEN typeof(id) = 'text' AND length(CAST(id AS BLOB)) = 18 AND id NOT GLOB '*[^0-9]*' THEN id END`;

type Walked = {
  id: string | null;
  url: string | null;
  attempts: number | null;
  claim: number | null;
  enqueued: number | null;
};

// The walk's projections: each NULL past its stored bound.
const WALKED = `${ID_SQL} AS id, CASE WHEN NOT (${cardUrlPastSql("source_url", false)}) THEN source_url END AS url,
	${storedCountSql("attempts", CARD_IMAGE_MAX_ATTEMPTS)} AS attempts, ${storedCountSql("claim")} AS claim,
	${storedCountSql("enqueued_at")} AS enqueued`;

// Whether no status_cards row names the image ?1: one seek of the link index.
const UNREFERENCED = `NOT EXISTS (SELECT 1 FROM status_cards INDEXED BY ${CARD_IMAGE_LINK_INDEX} WHERE image_id = ?1)`;

// The bounded count of due tombstones: at most CARD_IMAGE_GC_BACKLOG index entries of media_orphans_due.
const DUE_BACKLOG_SQL = `SELECT count(*) AS n FROM (SELECT 1 FROM media_orphans INDEXED BY media_orphans_due
	WHERE delete_after <= ?1 LIMIT ${CARD_IMAGE_GC_BACKLOG})`;

// The stored rows the image GC walks from cursor ?1 ('' from the start): at most CARD_IMAGE_GC_WALK by id, each with
// whether it is unreferenced.
const GC_WALK_SQL = `SELECT id, NOT EXISTS (SELECT 1 FROM status_cards INDEXED BY ${CARD_IMAGE_LINK_INDEX}
		WHERE image_id = i.id) AS orphan
	FROM card_images i INDEXED BY ${CARD_IMAGE_STORED_ID_INDEX}
	WHERE i.stored_at IS NOT NULL AND i.id > ?1 ORDER BY i.id LIMIT ${CARD_IMAGE_GC_WALK}`;

// The image GC: when fewer than CARD_IMAGE_GC_BACKLOG tombstones are due at `now`, at most CARD_IMAGE_GC_WALK
// stored rows from the cursor, each unreferenced one given a tombstone due at once (its token and id, copied in SQL)
// and deleted; the cursor moves to the last row walked, or back to the start when fewer were left. Null when paused.
function collect(db: Db, now: number): number | null {
  const due = db.first<{ n: number }>(DUE_BACKLOG_SQL, iso(now))?.n ?? CARD_IMAGE_GC_BACKLOG;
  if (due >= CARD_IMAGE_GC_BACKLOG) {
    return null;
  }
  const stored = state(db, GC_CURSOR) ?? "";
  const cursor = SNOWFLAKE.test(stored) ? stored : "";
  const rows = db.all<{ id: string; orphan: number }>(GC_WALK_SQL, cursor);
  let collected = 0;
  for (const row of rows) {
    if (row.orphan !== 1) {
      continue;
    }
    db.run(
      `INSERT OR REPLACE INTO media_orphans (file_token, media_id, delete_after)
			SELECT token, id, ?2 FROM card_images WHERE id = ?1 AND stored_at IS NOT NULL`,
      row.id,
      iso(now),
    );
    db.run("DELETE FROM card_images WHERE id = ?1 AND stored_at IS NOT NULL", row.id);
    collected++;
  }
  setState(db, GC_CURSOR, rows.length < CARD_IMAGE_GC_WALK ? "" : (rows.at(-1)?.id ?? ""));
  return collected;
}

// See the module's head. `tokens`: the Worker's fresh file tokens, one per claim it may start (at most
// CARD_IMAGE_ROUND_CLAIMS are used); `share`: IMAGES_CARD_MONTHLY_TRANSFORMS. At most CARD_IMAGE_EXPIRE_BATCH +
// 2 × CARD_IMAGE_GC_WALK + CARD_IMAGE_CLAIM_WALK + CARD_IMAGE_ROUND_CLAIMS rows written, and the cursor.
export const claimCardImages = mediaDeleteOperation<
  { now: number; tokens: readonly string[]; share: number },
  CardImageClaims
>((db, { now, tokens, share }) => {
  const out: CardImageClaims = { domain: null, claims: [], expired: 0, collected: 0, paused: false, dropped: 0 };
  const domain = db.first<{ value: SqlStorageValue }>(
    "SELECT value FROM instance_settings WHERE name = 'domain'",
  )?.value;
  if (
    typeof domain !== "string" ||
    !DOMAIN.test(domain) ||
    !isTime(now) ||
    now > SAFE_INTEGER_MAX - CARD_IMAGE_HOLD_MS
  ) {
    return out;
  }
  out.domain = domain;
  const cutoff = now - CARD_IMAGE_EXPIRE_MS;
  out.expired = db.run(
    `DELETE FROM card_images WHERE id IN (SELECT id FROM card_images INDEXED BY ${CARD_IMAGE_EXPIRY_INDEX}
				WHERE due_at IS NOT NULL AND enqueued_at < ?1 ORDER BY enqueued_at LIMIT ${CARD_IMAGE_EXPIRE_BATCH})
			AND NOT (attempts > 0 AND due_at > ?2)`,
    cutoff,
    now,
  );
  const collected = collect(db, now);
  out.paused = collected === null;
  out.collected = collected ?? 0;
  const shareLeft = Number.isSafeInteger(share) && share > 0 ? Math.max(0, share - used(db, now)) : 0;
  const given: unknown[] = (Array.isArray(tokens) ? tokens : []).slice(0, CARD_IMAGE_ROUND_CLAIMS);
  const claimable = Math.min(CARD_IMAGE_ROUND_CLAIMS, given.length, shareLeft);
  // C2: with no share left, nothing is walked or claimed.
  if (claimable === 0) {
    return out;
  }
  const walk = db.all<Walked>(
    `SELECT ${WALKED} FROM card_images INDEXED BY ${CARD_IMAGE_DUE_INDEX} WHERE due_at <= ?1
		ORDER BY due_at, id LIMIT ${CARD_IMAGE_CLAIM_WALK}`,
    now,
  );
  let next = 0;
  for (const row of walk) {
    const { id, url, attempts, claim, enqueued } = row;
    if (id === null) {
      continue;
    }
    const drop = () => {
      out.dropped++;
      db.run("DELETE FROM card_images WHERE id = ?1", id);
    };
    // C1: a counter past its range, given up or expired; C0: unreferenced.
    if (url === null || attempts === null || claim === null || enqueued === null) {
      drop();
      continue;
    }
    if (attempts >= CARD_IMAGE_MAX_ATTEMPTS || enqueued < cutoff || claim + 1 > SAFE_INTEGER_MAX) {
      drop();
      continue;
    }
    if (db.first(`SELECT 1 AS x WHERE ${UNREFERENCED}`, id) !== undefined) {
      drop();
      continue;
    }
    const token = given[next++];
    // C3: a token that is not a server token, or that any owner holds, claims nothing; the row stays due.
    if (
      typeof token !== "string" ||
      !FILE_TOKEN.test(token) ||
      db.first(`SELECT 1 AS x WHERE ${MEDIA_TOKEN_FREE_SQL}`, token) === undefined
    ) {
      if (next >= given.length) {
        break;
      }
      continue;
    }
    const claimed = db.first<{ claim: number }>(
      `UPDATE card_images SET claim = claim + 1, attempts = attempts + 1, due_at = ?2 WHERE id = ?1
			RETURNING claim`,
      id,
      now + CARD_IMAGE_HOLD_MS,
    )!.claim;
    db.run(
      "INSERT INTO media_orphans (file_token, media_id, delete_after) VALUES (?1, ?2, ?3)",
      token,
      id,
      iso(now + CARD_IMAGE_HOLD_MS + ORPHAN_GRACE_MS),
    );
    out.claims.push({ id, claim: claimed, token, sourceUrl: url });
    if (out.claims.length >= claimable || next >= given.length) {
      break;
    }
  }
  // A row whose id fails its projection (never, under the triggers) is deleted in SQL among the same walk.
  if (walk.some((row) => row.id === null)) {
    db.run(
      `DELETE FROM card_images WHERE id IN (SELECT id FROM card_images INDEXED BY ${CARD_IMAGE_DUE_INDEX}
				WHERE due_at <= ?1 ORDER BY due_at, id LIMIT ${CARD_IMAGE_CLAIM_WALK}) AND ${ID_SQL} IS NULL`,
      now,
    );
  }
  return out;
});

export type CardImageFence = { id: string; claim: number; token: string };

// The claim `fence` names is still open: see the module's head.
const FENCE = `SELECT 1 AS x FROM card_images WHERE id = ?1 AND claim = ?2 AND attempts > 0 AND due_at IS NOT NULL
	AND stored_at IS NULL AND EXISTS (SELECT 1 FROM media_orphans WHERE file_token = ?3 AND media_id = ?1)`;

function fenced(db: Db, fence: CardImageFence): boolean {
  const { id, claim, token } = fence;
  return (
    typeof id === "string" &&
    typeof token === "string" &&
    isTime(claim) &&
    db.first(FENCE, id, claim, token) !== undefined
  );
}

// Admissions #1 and #3 (before the preflight info() and before the put): a write, so the Store refuses it in any
// maintenance, under the fence. Charges nothing.
export const admitCardImage = writeOperation<CardImageFence, { held: boolean }>((db, fence) => ({
  held: fenced(db, fence),
}));

export type CardImageStart = { status: "ok" } | { status: "budget" } | { status: "lost" };

// Admission #2, right before each Images output (as media.ts startTransforms): under the fence, one transformation
// charged to the card counter of the month `now` is in while it stays within `share`; counters before the previous
// month pruned.
export const startCardImage = writeOperation<CardImageFence & { share: number; now: number }, CardImageStart>(
  (db, input) => {
    if (!fenced(db, input) || !isTime(input.now)) {
      return { status: "lost" };
    }
    const count = used(db, input.now);
    if (!Number.isSafeInteger(input.share) || count + 1 > input.share) {
      return { status: "budget" };
    }
    const date = new Date(input.now);
    const previous = iso(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1)).slice(0, 7);
    db.run(
      "DELETE FROM kopje_state WHERE substr(name, 1, ?1) = ?2 AND substr(name, ?1 + 1, 7) < ?3",
      CARD_TRANSFORMS.length,
      CARD_TRANSFORMS,
      previous,
    );
    setState(db, monthName(input.now), String(count + 1));
    return { status: "ok" };
  },
);

export type CardImageOutcome =
  | { kind: "stored"; width: number; height: number; blurhash: string | null }
  | { kind: "none" }
  | { kind: "unattempted" };

// A stored edge as bound: workerd binds every number as REAL, cast back before cardImageEdgeSql judges it.
const edgeOf = (value: unknown): number | null => (Number.isSafeInteger(value) ? (value as number) : null);

// The outcome of one claim, under its fence (see the module's head). A stored outcome takes the claim's token from its
// tombstone in SQL and deletes the tombstone; a size the stored rule refuses records none (the tombstone kept, so the
// object put is deleted by reconciliation), and a blurhash it refuses is dropped.
export const recordCardImage = writeOperation<
  CardImageFence & { outcome: CardImageOutcome; now: number },
  { held: boolean }
>((db, input) => {
  const { id, claim, token, now } = input;
  if (!fenced(db, input) || !isTime(now)) {
    return { held: false };
  }
  const outcome: CardImageOutcome =
    typeof input.outcome === "object" && input.outcome !== null ? input.outcome : { kind: "none" };
  if (outcome.kind === "unattempted") {
    db.run("UPDATE card_images SET due_at = ?2, attempts = attempts - 1 WHERE id = ?1", id, now);
    return { held: true };
  }
  const stored =
    outcome.kind === "stored" &&
    db.run(
      `UPDATE card_images SET token = (SELECT file_token FROM media_orphans WHERE file_token = ?3 AND media_id = ?1),
				width = ${cardImageEdgeSql("CAST(?4 AS INTEGER)")}, height = ${cardImageEdgeSql("CAST(?5 AS INTEGER)")},
				blurhash = CASE WHEN ${blurhashPastBoundSql("?6")} THEN NULL ELSE ?6 END,
				stored_at = ?7, due_at = NULL, attempts = 0
			WHERE id = ?1 AND claim = ?2 AND ${cardImageEdgeSql("CAST(?4 AS INTEGER)")} IS NOT NULL
				AND ${cardImageEdgeSql("CAST(?5 AS INTEGER)")} IS NOT NULL`,
      id,
      claim,
      token,
      edgeOf(outcome.width),
      edgeOf(outcome.height),
      typeof outcome.blurhash === "string" ? outcome.blurhash : null,
      now,
    ) > 0;
  if (stored) {
    db.run("DELETE FROM media_orphans WHERE file_token = ?1 AND media_id = ?2", token, id);
  } else {
    db.run("DELETE FROM card_images WHERE id = ?1", id);
  }
  return { held: true };
});
