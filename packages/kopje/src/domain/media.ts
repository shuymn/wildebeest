import { selectSql } from "../db/columns";
import { MEDIA_ID_INDEX } from "../db/indexes";
import type { Db } from "../db/sql";
import { mediaUrl } from "../platform/media-files";
import {
  staticUrlPastBoundSql,
  storedBlurhash,
  storedMediaDescription,
  storedMediaMeta,
} from "../platform/stored-bounds";
import { type CredentialAccount, credentialAccount, type Present } from "./accounts";
import { actorSnapshot, recordActorUpdate } from "./actor-update";
import { userMediaDeleteOperation, userReadOperation, userWriteOperation } from "./auth";
import { allocateLocalId } from "./ids";
import { mediaDeleteOperation } from "./operation";
import { type MediaAttachment, type MediaRow, presentMedia } from "./status-presenter";
import { MEDIA_COLUMN_MAP } from "./status-rows";

// Local media attachments. An upload takes four Store calls, because re-encoding and R2 are external I/O the
// Store does not do:
//   1. reserveMedia: authorizes, counts the attempt, checks the Images budgets, and creates the row (processed = 0)
//      with its id and file token, so the R2 keys exist in the Store before anything is written to R2;
//   2. startTransforms, right before Images is called: revalidates the reservation with fresh time and charges the
//      transformations to the budgets of the month they run in;
//   3. the Worker re-encodes the image and writes the original and the served files to R2;
//   4. completeMedia records type, URLs, dimensions and the preview's blurhash; abandonMedia marks a failed upload for
//      deletion.
//
// The uploading request has a deadline, WRITE_WINDOW_MS after the reservation. startTransforms and completeMedia refuse
// after it, each judging the time the Worker took right before the call, in the transaction that would change the row;
// the Worker starts no R2 write after it either. What this does not guarantee: a write started before the deadline may
// still land after the sweep deleted the reservation (an HTTP Worker has no fixed wall-time limit). So the sweep leaves
// a tombstone (media_orphans) for every upload that never completed, and reconciliation deletes its keys again once the
// tombstone falls due, ORPHAN_GRACE_MS after the deadline. A write that lands later still is an orphan until an
// operator removes it. Reconciliation deletes only recorded tombstones, never an object because no row names it: an
// empty, reset, importing or restored Store must not delete the media it does not (yet) know.
//
// processed = 0 means the uploading request may still be at work; completion and abandonment both set it to 1.
// Completion is idempotent, so a request whose completion answer was lost can ask again, and abandonment never dooms a
// completed upload.
//
// Lifecycle: an unattached upload carries gc_at. It is attachable only while gc_at is in the future. Media an edit
// drops stays attached, no longer shown (shown 0), as long as the status: its earlier versions still show it, and
// only a later edit of the same status may show it again. Deleting the status detaches all of its media with a new
// grace period, so a redraft can attach it again; delete_media and deleting an unattached upload (deleteMedia) doom
// it at once. The sweep (expiredMedia, then R2 deletes, then purgeMedia) removes doomed rows and their R2 objects in
// bounded batches, objects first.
//
// A profile image (avatar or header, set by update_credentials or the settings page) is a completed upload that the
// account's avatar_url or header_url names, kept with neither status_id nor gc_at: it is never swept, and never
// attached, read or updated through the API. Replacing or removing it dooms it.
//
// Only the uploader reads, updates or attaches an upload, and only while it is unattached (MEDIA-1); Mastodon's
// MediaController finds `current_account.media_attachments.where(status_id: nil)`.

const HOUR = 60 * 60 * 1000;

// Media a status no longer uses may be attached again for a day (Mastodon vacuums unattached media after a day).
export const DETACHED_GRACE_MS = 24 * HOUR;

// The uploading request's deadline. A reservation that never completes (the Worker failed mid-upload) is swept after
// RESERVATION_MS.
export const WRITE_WINDOW_MS = 15 * 60 * 1000;
const RESERVATION_MS = HOUR;

// A tombstone of an upload that never completed falls due this long after its writer's deadline.
export const ORPHAN_GRACE_MS = 24 * HOUR;

// Mastodon's rate limit for media uploads: 30 per 30 minutes per account (RES-6). Attempts are counted, not rows: a
// deleted or failed upload still counts, so upload-and-delete cannot loop.
export const UPLOAD_BUDGET = { count: 30, windowMs: 30 * 60 * 1000 };

// Images outputs an upload starts (the full image, the preview and the preview's RGBA, which Images may bill as one
// with the preview, so the count is a ceiling; platform/images.ts), charged to the instance budget and the account's
// share; a profile image is an upload, and the media rebuild charges a rebuilt upload's row the same to the instance
// budget.
export const TRANSFORMS_PER_UPLOAD = 3;
// Images outputs a custom emoji's image starts (the full image and the preview; no blurhash), charged to the instance
// budget (local-emojis.ts, and the media rebuild for an emoji's row).
export const TRANSFORMS_PER_EMOJI = 2;

// The attempt and transformation counters live in kopje_state, outside the dumped tables: each account's attempt times
// in the window (at most UPLOAD_BUDGET.count), and the transformations spent per UTC month, for the instance and for
// each account. Transformations are charged when they start, to the month they run in, so the monthly ceiling holds
// across midnight. Months before the previous one are pruned; the current and later months are never removed, so a
// request that reaches the Store late cannot reset newer counters.
const ATTEMPTS = "media_attempts:";
const TRANSFORMS = "images_transforms:";
const ACCOUNT_TRANSFORMS = "images_account_transforms:";

function state(db: Db, name: string): string | undefined {
  return db.first<{ value: string }>("SELECT value FROM kopje_state WHERE name = ?", name)?.value;
}

function setState(db: Db, name: string, value: string): void {
  db.run("INSERT OR REPLACE INTO kopje_state (name, value) VALUES (?, ?)", name, value);
}

// At most this many uploads are swept per run; each is three R2 keys.
export const SWEEP_BATCH = 100;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

// The gc_at of media an explicit deletion dooms (DELETE /api/v1/media/:id, delete_media, a replaced or removed profile
// image): the epoch, which every request reads as past whatever its own time, so a request that started before the
// deletion cannot attach the media again after it (liveMediaSql) while the sweep deletes its objects.
export const DOOMED_AT = iso(0);

// The condition for an unattached upload that may still be used: processed, not doomed, not the uploader's avatar or
// header, and not a custom emoji's image (MEDIA-1, MEDIA-5). `now` is a parameter expression.
export function liveMediaSql(m: string, now: string): string {
  return `(${m}.processed = 1 AND (${m}.gc_at IS NULL OR ${m}.gc_at > ${now})
		AND NOT EXISTS (SELECT 1 FROM accounts ${m}_pa WHERE ${m}_pa.id = ${m}.account_id
			AND ${m}.url IN (${m}_pa.avatar_url, ${m}_pa.header_url))
		AND ${notEmojiSql(m)})`;
}

// MEDIA-5: a custom emoji's image (migration 0055_local_custom_emojis) is kept for good, disabled or not, imported
// rows included. Every selection that may delete, doom, attach, read or update media excludes it: liveMediaSql, the
// sweep (expiredMedia, purgeMedia) and applyProfileImage's release. A primary-key probe of custom_emojis.
function notEmojiSql(m: string): string {
  return `NOT EXISTS (SELECT 1 FROM custom_emojis ${m}_e WHERE ${m}_e.id = ${m}.id)`;
}

function ownUpload(db: Db, accountId: string, id: string, now: number): MediaRow | undefined {
  return db.first<MediaRow>(
    `SELECT ${selectSql(MEDIA_COLUMN_MAP)} FROM media_attachments m
		WHERE m.id = ?1 AND m.account_id = ?2 AND m.status_id IS NULL AND ${liveMediaSql("m", "?3")}`,
    id,
    accountId,
    iso(now),
  );
}

export type Reserved =
  | { status: "ok"; id: string; deadline: number }
  | { status: "rate_limited" }
  | { status: "budget_exhausted"; scope: "account" | "instance" }
  // The Worker's token is taken: nothing is counted or reserved, and the request may be sent again.
  | { status: "retry" };

export type MonthlyTransforms = { instance: number; account: number };

// Step 1. `token` is the file token the Worker generated (32 random bytes). `monthlyTransforms` holds the instance's
// Images budget and each account's share of it (IMAGES_MONTHLY_TRANSFORMS, IMAGES_ACCOUNT_MONTHLY_TRANSFORMS), so one
// account (R4) cannot use up the instance's budget for everyone. The attempt is counted here and the budgets checked,
// so an over-budget request reads no body; startTransforms checks them again and charges them, in its transaction, so
// concurrent uploads cannot overshoot them and nothing reaches Images past them (RES-6).
export const reserveMedia = userWriteOperation<
  { token: string; monthlyTransforms: MonthlyTransforms; now: number },
  Reserved
>((db, { token, monthlyTransforms, now }, { accountId }) => {
  const attemptsName = `${ATTEMPTS}${accountId}`;
  const since = now - UPLOAD_BUDGET.windowMs;
  const attempts = (JSON.parse(state(db, attemptsName) ?? "[]") as number[]).filter((at) => at > since);
  if (attempts.length >= UPLOAD_BUDGET.count) {
    return { status: "rate_limited" };
  }
  const refused = budgetRefusal(db, accountId, monthlyTransforms, now);
  if (refused !== null) {
    return refused;
  }
  if (mediaTokenTaken(db, token)) {
    return { status: "retry" };
  }
  setState(db, attemptsName, JSON.stringify([...attempts, now]));
  const reserved = insertReservation(db, accountId, token, now);
  return "retry" in reserved ? { status: "retry" } : { status: "ok", id: reserved.ok, deadline: now + WRITE_WINDOW_MS };
});

// A file token is unique across every owner of an R2 key under files/<token>/: uploads and emoji, finished or reserved
// (media_attachments.file_token, UNIQUE), stored card images (card_images.token, a UNIQUE index) and tombstones, a card
// image claim's included (media_orphans.file_token, its key). The SQL condition that ?1 is free.
export const MEDIA_TOKEN_FREE_SQL = `NOT EXISTS (SELECT 1 FROM media_attachments WHERE file_token = ?1)
	AND NOT EXISTS (SELECT 1 FROM card_images WHERE token = ?1)
	AND NOT EXISTS (SELECT 1 FROM media_orphans WHERE file_token = ?1)`;

// Whether `token` is held by any owner (MEDIA_TOKEN_FREE_SQL): three key seeks.
export function mediaTokenTaken(db: Db, token: string): boolean {
  return db.first(`SELECT 1 AS free WHERE ${MEDIA_TOKEN_FREE_SQL}`, token) === undefined;
}

// The row of a new reservation (step 1, and a custom emoji's, local-emojis.ts): processed = 0 with the Worker's token,
// swept after RESERVATION_MS unless completed. Its id, or retry when the token is taken (inserted only while
// MEDIA_TOKEN_FREE_SQL holds, so the database enforces the uniqueness, whatever the caller checked).
export function insertReservation(
  db: Db,
  accountId: string,
  token: string,
  now: number,
): { ok: string } | { retry: true } {
  const id = allocateLocalId(db, now);
  const inserted = db.run(
    `INSERT INTO media_attachments (id, account_id, type, url, file_token, processed, gc_at, created_at)
		SELECT ?2, ?3, 'image', '', ?1, 0, ?4, ?5 WHERE ${MEDIA_TOKEN_FREE_SQL}`,
    token,
    id,
    accountId,
    iso(now + RESERVATION_MS),
    iso(now),
  );
  return inserted > 0 ? { ok: id } : { retry: true };
}

// YYYY-MM of the month before the one `now` is in (UTC).
function previousMonth(now: number): string {
  const date = new Date(now);
  return iso(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1)).slice(0, 7);
}

function budgetNames(accountId: string, now: number): { instance: string; account: string } {
  const month = iso(now).slice(0, 7);
  return { instance: `${TRANSFORMS}${month}`, account: `${ACCOUNT_TRANSFORMS}${month}:${accountId}` };
}

// Whether one more upload's transformations fit the budgets of the month `now` is in.
function budgetRefusal(
  db: Db,
  accountId: string,
  monthlyTransforms: MonthlyTransforms,
  now: number,
): { status: "budget_exhausted"; scope: "account" | "instance" } | null {
  const names = budgetNames(accountId, now);
  if (Number(state(db, names.account) ?? "0") + TRANSFORMS_PER_UPLOAD > monthlyTransforms.account) {
    return { status: "budget_exhausted", scope: "account" };
  }
  if (Number(state(db, names.instance) ?? "0") + TRANSFORMS_PER_UPLOAD > monthlyTransforms.instance) {
    return { status: "budget_exhausted", scope: "instance" };
  }
  return null;
}

// Charges `count` transformations that are not an upload's (the /setup Images check) to the instance budget of the
// month `now` is in. False, and nothing charged, when they do not fit (RES-6).
export function chargeInstanceTransforms(db: Db, count: number, limit: number, now: number): boolean {
  const name = budgetNames("", now).instance;
  const used = Number(state(db, name) ?? "0");
  if (used + count > limit) {
    return false;
  }
  setState(db, name, String(used + count));
  return true;
}

export type Started =
  | { status: "ok" }
  | { status: "expired" }
  | { status: "budget_exhausted"; scope: "account" | "instance" };

// Step 2, right before Images is called. The reservation must still be open (not completed, abandoned or past its
// deadline at `now`), and the transformations are charged to the budgets of the month `now` is in.
export const startTransforms = userWriteOperation<
  { id: string; monthlyTransforms: MonthlyTransforms; now: number },
  Started
>((db, { id, monthlyTransforms, now }, { accountId }) => {
  const open = db.first<{ id: string }>(
    "SELECT id FROM media_attachments WHERE id = ? AND account_id = ? AND processed = 0 AND created_at > ?",
    id,
    accountId,
    iso(now - WRITE_WINDOW_MS),
  );
  if (open === undefined) {
    return { status: "expired" };
  }
  const refused = budgetRefusal(db, accountId, monthlyTransforms, now);
  if (refused !== null) {
    return refused;
  }
  // Counters of months before the previous one go (at most ten local accounts, so this stays small).
  db.run(
    `DELETE FROM kopje_state WHERE (substr(name, 1, ?1) = ?2 AND substr(name, ?1 + 1, 7) < ?5)
			OR (substr(name, 1, ?3) = ?4 AND substr(name, ?3 + 1, 7) < ?5)`,
    TRANSFORMS.length,
    TRANSFORMS,
    ACCOUNT_TRANSFORMS.length,
    ACCOUNT_TRANSFORMS,
    previousMonth(now),
  );
  const names = budgetNames(accountId, now);
  for (const name of [names.instance, names.account]) {
    setState(db, name, String(Number(state(db, name) ?? "0") + TRANSFORMS_PER_UPLOAD));
  }
  return { status: "ok" };
});

type Size = { width: number; height: number };

// The meta of a local upload's row: its served sizes, and `"animated": true` when its served file is animated
// (platform/images.ts isAnimated), which makes its still preview the account's static image (profileAssignSql).
// presentMedia ignores the flag. About 100 bytes, within MEDIA_META_BYTES.
export function uploadMediaMeta(original: Size, small: Size, animated: boolean): string | null {
  return storedMediaMeta(JSON.stringify({ original, small, ...(animated ? { animated: true } : {}) }));
}

export type CompleteMediaInput = {
  id: string;
  contentType: string;
  original: Size;
  small: Size;
  animated: boolean;
  // The preview's blurhash (platform/images.ts processImage), or null; stored as storedBlurhash keeps it.
  blurhash: string | null;
  description: string;
  focus: { x: number; y: number };
  now: number;
};

// Step 3. The URLs are made here, on the instance origin of the uploader's actor URI (as status URIs are), from the
// row's own token. Completing an upload that is already complete answers with it (the first answer may have been lost).
// Null when the reservation is gone or its writer deadline has passed: the Worker then abandons it.
export const completeMedia = userWriteOperation<CompleteMediaInput, MediaAttachment | null>(
  (db, input, { accountId }) => {
    const row = db.first<{ token: string | null; uri: string; processed: number; url: string; created_at: string }>(
      `SELECT m.file_token AS token, a.uri, m.processed, m.url, m.created_at
			FROM media_attachments m JOIN accounts a ON a.id = m.account_id WHERE m.id = ? AND m.account_id = ?`,
      input.id,
      accountId,
    );
    if (row === undefined || row.token === null) {
      return null;
    }
    if (row.processed === 1) {
      const done = row.url === "" ? undefined : ownUpload(db, accountId, input.id, input.now);
      return done === undefined ? null : presentMedia(done);
    }
    if (row.created_at <= iso(input.now - WRITE_WINDOW_MS)) {
      return null;
    }
    const origin = new URL(row.uri).origin;
    db.run(
      `UPDATE media_attachments SET url = ?, preview_url = ?, content_type = ?, meta = ?, blurhash = ?, description = ?,
				focus_x = ?, focus_y = ?, processed = 1, gc_at = ?
			WHERE id = ?`,
      mediaUrl(origin, row.token, "full", input.contentType),
      mediaUrl(origin, row.token, "small", input.contentType),
      input.contentType,
      uploadMediaMeta(input.original, input.small, input.animated),
      storedBlurhash(input.blurhash),
      storedMediaDescription(input.description),
      input.focus.x,
      input.focus.y,
      iso(input.now + DETACHED_GRACE_MS),
      input.id,
    );
    const done = ownUpload(db, accountId, input.id, input.now);
    return done === undefined ? null : presentMedia(done);
  },
);

// abandoned: the reservation is doomed (or already was) and its objects may go; kept: the upload completed, so its
// objects stay; gone: there is no such row, so nothing refers to its objects.
export type Abandoned = "abandoned" | "kept" | "gone";

// A failed upload: doomed at once and released from its writer, so the sweep takes it right away. A completed upload is
// never doomed here.
export const abandonMedia = userMediaDeleteOperation<{ id: string; now: number }, Abandoned>(
  (db, { id, now }, { accountId }) => {
    const row = db.first<{ processed: number; url: string }>(
      "SELECT processed, url FROM media_attachments WHERE id = ? AND account_id = ?",
      id,
      accountId,
    );
    if (row === undefined) {
      return "gone";
    }
    if (row.processed === 1 && row.url !== "") {
      return "kept";
    }
    db.run("UPDATE media_attachments SET processed = 1, gc_at = ? WHERE id = ? AND status_id IS NULL", iso(now), id);
    return "abandoned";
  },
);

export const getMedia = userReadOperation<{ id: string; now: number }, MediaAttachment | null>(
  (db, { id, now }, { accountId }) => {
    const row = ownUpload(db, accountId, id, now);
    return row === undefined ? null : presentMedia(row);
  },
);

export type ProfileImage = "avatar" | "header";

// In the order a request applies them.
export const PROFILE_IMAGES: readonly ProfileImage[] = ["avatar", "header"];

const PROFILE_COLUMNS: Record<ProfileImage, { own: string; still: string; other: string }> = {
  avatar: { own: "avatar_url", still: "avatar_static_url", other: "header_url" },
  header: { own: "header_url", still: "header_static_url", other: "avatar_url" },
};

// Whether `id` may become a profile image of the viewer: the viewer's own live, completed, unattached upload, not held
// by a scheduled status (scheduled-statuses.ts).
export function profileUploadReady(db: Db, accountId: string, id: string, now: number): boolean {
  const upload = ownUpload(db, accountId, id, now);
  const held = db.first("SELECT 1 AS held FROM media_attachments WHERE id = ? AND scheduled_status_id IS NOT NULL", id);
  return upload !== undefined && upload.url !== "" && held === undefined;
}

// The release of the upload behind the account's `kind` image (?1 the account, ?2 the doom time): applyProfileImage.
export function profileReleaseSql(kind: ProfileImage): string {
  const { own, other } = PROFILE_COLUMNS[kind];
  return `UPDATE media_attachments SET gc_at = ?2
		WHERE account_id = ?1 AND status_id IS NULL AND gc_at IS NULL
			AND url = (SELECT ${own} FROM accounts WHERE id = ?1)
			AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = ?1 AND a.${other} = media_attachments.url)
			AND ${notEmojiSql("media_attachments")}`;
}

// The assignment of upload ?1 as the account ?2's `kind` image, in one UPDATE: the image is the upload's URL, and its
// static (migration 0061_account_static_images) the upload's still preview when its served file is animated (the
// meta's "animated", completeMedia), else NULL (the image itself). A preview URL 0061's trigger would refuse is not
// copied (staticUrlPastBoundSql), so the account shows its image. Both are copied within SQL, byte for byte; meta's
// json_valid CHECK (0000_initial) keeps json_extract from failing. The upload is read by its key.
export function profileAssignSql(kind: ProfileImage): string {
  const { own, still } = PROFILE_COLUMNS[kind];
  return `UPDATE accounts SET (${own}, ${still}) = (
		SELECT m.url, CASE WHEN json_extract(m.meta, '$.animated') IS 1
			AND NOT (${staticUrlPastBoundSql("m.preview_url")}) THEN m.preview_url END
		FROM media_attachments m INDEXED BY ${MEDIA_ID_INDEX} WHERE m.id = ?1)
	WHERE id = ?2`;
}

// Sets (an upload id) or clears (null) the account's avatar or header, with its static. Before the account changes,
// the upload behind the image it replaces is doomed, so the sweep deletes it and its files, unless the account's
// other image still names it; the static is that upload's own preview, so it goes with it. The old and new URLs are
// compared and copied within SQL (RES-2): read into the Worker and bound again, an imported URL of malformed UTF-8
// would come back changed and match nothing. The release reads the account's own media through
// media_attachments_account and probes the account row by key (test/profile-images.test.ts shows the plan).
export function applyProfileImage(db: Db, accountId: string, kind: ProfileImage, id: string | null): void {
  const { own, still } = PROFILE_COLUMNS[kind];
  db.run(profileReleaseSql(kind), accountId, DOOMED_AT);
  if (id === null) {
    db.run(`UPDATE accounts SET ${own} = NULL, ${still} = NULL WHERE id = ?`, accountId);
    return;
  }
  db.run(profileAssignSql(kind), id, accountId);
  db.run("UPDATE media_attachments SET gc_at = NULL WHERE id = ?", id);
}

// DELETE /api/v1/profile/avatar and /api/v1/profile/header (Mastodon's Profile::AvatarsController and
// HeadersController#destroy): the account shows the default image again, the upload behind the removed one is doomed
// as a replaced one is, and other servers receive the Update a profile edit sends. Answers the CredentialAccount.
export const removeProfileImage = userMediaDeleteOperation<
  { kind: ProfileImage; present: Present; now: number },
  CredentialAccount | null
>((db, { kind, present, now }, { accountId }) => {
  const before = actorSnapshot(db, accountId);
  applyProfileImage(db, accountId, kind, null);
  recordActorUpdate(db, accountId, before, now);
  return credentialAccount(db, accountId, present);
});

export type MediaChanges = { description?: string | undefined; focus?: { x: number; y: number } | undefined };

export const updateMedia = userWriteOperation<
  { id: string; changes: MediaChanges; now: number },
  MediaAttachment | null
>((db, { id, changes, now }, { accountId }) => {
  if (ownUpload(db, accountId, id, now) === undefined) {
    return null;
  }
  db.run(
    `UPDATE media_attachments SET description = COALESCE(?, description), focus_x = COALESCE(?, focus_x),
				focus_y = COALESCE(?, focus_y)
			WHERE id = ?`,
    changes.description === undefined ? null : storedMediaDescription(changes.description),
    changes.focus?.x ?? null,
    changes.focus?.y ?? null,
    id,
  );
  const row = ownUpload(db, accountId, id, now);
  return row === undefined ? null : presentMedia(row);
});

export type MediaDeleted = "deleted" | "in_use" | "not_found";

// DELETE /api/v1/media/:id (Mastodon's MediaController#destroy): the uploader's own media only. Media a status uses
// is refused, and so is media a scheduled status holds (scheduled-statuses.ts); a live unattached upload is doomed at
// once, as delete_media dooms a status's media, and the sweep deletes it and its R2 objects. A profile image, a
// reservation still being written and an upload already doomed are not found, as they are for GET and PUT.
//
// Media an edit dropped is attached (shown 0), so it is in use. An unattached row with no gc_at that is not a profile
// image is one the cutover kept for good (cli/lib/cutover/convert.js) and could not link to a status: an image legacy
// kept unattached, or one that earlier versions of no single status name (migration 0015_media_shown links the
// others). No Kopje write leaves such a row, so it is refused as in use too.
export const deleteMedia = userMediaDeleteOperation<{ id: string; now: number }, MediaDeleted>(
  (db, { id, now }, { accountId }) => {
    const row = db.first<{ used: number; kept: number }>(
      `SELECT status_id IS NOT NULL OR scheduled_status_id IS NOT NULL AS used, gc_at IS NULL AS kept
			FROM media_attachments WHERE id = ? AND account_id = ?`,
      id,
      accountId,
    );
    if (row === undefined) {
      return "not_found";
    }
    if (row.used === 1) {
      return "in_use";
    }
    if (ownUpload(db, accountId, id, now) === undefined) {
      return "not_found";
    }
    if (row.kept === 1) {
      return "in_use";
    }
    db.run("UPDATE media_attachments SET gc_at = ? WHERE id = ?", DOOMED_AT, id);
    return "deleted";
  },
);

// token is null for rows with no R2 files (migrated media), which are only deleted.
export type ExpiredMedia = { id: string; token: string | null };

// Background work that deletes R2 objects runs only in a set-up Store: it is a write operation, so the kernel refuses
// it during maintenance, a dump or an import, and a Store without its domain (fresh, reset, or being bootstrapped)
// answers with nothing to do.
function setUp(db: Db): boolean {
  return db.first("SELECT 1 AS found FROM instance_settings WHERE name = 'domain'") !== undefined;
}

// Doomed uploads, oldest first. They cannot be attached or read any more (liveMediaSql), so the R2 objects can go
// before the rows.
export const expiredMedia = mediaDeleteOperation<{ now: number; limit: number }, ExpiredMedia[]>(
  (db, { now, limit }) =>
    setUp(db)
      ? db.all<ExpiredMedia>(
          `SELECT id, file_token AS token FROM media_attachments
				WHERE status_id IS NULL AND gc_at IS NOT NULL AND gc_at <= ? AND ${notEmojiSql("media_attachments")}
				ORDER BY gc_at LIMIT ?`,
          iso(now),
          Math.min(limit, SWEEP_BATCH),
        )
      : [],
);

// Deletes swept rows whose R2 objects are gone; a row attached again meanwhile cannot match (it has no gc_at). A row
// that never completed leaves a tombstone: its writer may still put an object after this, and reconciliation deletes
// the keys again once the tombstone falls due, ORPHAN_GRACE_MS after the later of now and the writer's deadline.
export const purgeMedia = mediaDeleteOperation<{ ids: string[]; now: number }, number>((db, { ids, now }) => {
  const swept = db.all<{ id: string; token: string | null; url: string; created_at: string }>(
    `SELECT id, file_token AS token, url, created_at FROM media_attachments
		WHERE id IN (SELECT value FROM json_each(?)) AND status_id IS NULL AND gc_at IS NOT NULL AND gc_at <= ?
			AND ${notEmojiSql("media_attachments")}`,
    JSON.stringify(ids.slice(0, SWEEP_BATCH)),
    iso(now),
  );
  for (const row of swept) {
    if (row.token !== null && row.url === "") {
      const deadline = Date.parse(row.created_at) + WRITE_WINDOW_MS;
      db.run(
        "INSERT OR REPLACE INTO media_orphans (file_token, media_id, delete_after) VALUES (?, ?, ?)",
        row.token,
        row.id,
        iso(Math.max(now, deadline) + ORPHAN_GRACE_MS),
      );
    }
    db.run("DELETE FROM media_attachments WHERE id = ?", row.id);
  }
  return swept.length;
});

// At most this many tombstones are handled per reconciliation run.
export const RECONCILE_BATCH = 100;

export type Orphan = { id: string; token: string };

// Reconciliation (the cron, mastodon/media.ts): tombstones that fell due. Nothing else is ever deleted by it; an R2
// object no row names but no tombstone records stays.
export const dueOrphans = mediaDeleteOperation<{ now: number }, Orphan[]>((db, { now }) =>
  setUp(db)
    ? db.all<Orphan>(
        `SELECT media_id AS id, file_token AS token FROM media_orphans WHERE delete_after <= ?
				ORDER BY delete_after LIMIT ?`,
        iso(now),
        RECONCILE_BATCH,
      )
    : [],
);

export const forgetOrphans = mediaDeleteOperation<{ tokens: string[] }, number>((db, { tokens }) =>
  db.run(
    "DELETE FROM media_orphans WHERE file_token IN (SELECT value FROM json_each(?))",
    JSON.stringify(tokens.slice(0, RECONCILE_BATCH)),
  ),
);
