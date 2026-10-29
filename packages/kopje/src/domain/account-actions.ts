import type { Db } from "../db/sql";
import {
  ACCOUNT_EMOJIS_BYTES,
  MAX_FIELDS,
  presentedCountSql,
  storedDisplayName,
  storedText,
} from "../platform/stored-bounds";
import {
  type CredentialAccount,
  type Visibility,
  type FieldSource,
  type RelationshipResult,
  resolveAccountId,
  relationshipResult,
  followLimit,
  type Present,
  fieldSources,
  credentialAccount,
} from "./accounts";
import { followActivity, followAnswerActivity, followUri, recordOutbound, undoFollowActivity } from "./activities";
import { actorSnapshot, recordActorUpdate } from "./actor-update";
import { availableSql, followableBySql, type QuotePolicyName } from "./audience";
import { userMediaDeleteOperation, userWriteOperation } from "./auth";
import { localEmojiSnapshot } from "./custom-emojis";
import { armFieldLinks } from "./field-links";
import { retractFollow } from "./inbox";
import { applyProfileImage, PROFILE_IMAGES, type ProfileImage, profileUploadReady } from "./media";
import { notify } from "./notifications";
import { plainTextToHtml } from "./plain-text";
import { accountSearchText } from "./search-text";

// The account operations that federate or notify: following and its answers, and the profile update. They build on
// the presenter and reads of accounts.ts, which import none of them.

export type CredentialChanges = {
  displayName?: string | undefined;
  note?: string | undefined;
  locked?: boolean | undefined;
  bot?: boolean | undefined;
  discoverable?: boolean | undefined;
  indexable?: boolean | undefined;
  hideCollections?: boolean | undefined;
  privacy?: Visibility | undefined;
  sensitive?: boolean | undefined;
  language?: string | null;
  quotePolicy?: QuotePolicyName;
  // Replaces every field; lengths and count are validated by the caller.
  fields?: FieldSource[] | undefined;
  // Replaces every attribution domain; normalized and validated by the caller.
  attributionDomains?: string[];
};

// The uploads (completed, unattached, media.ts) a credentials update makes the account's avatar or header.
export type ProfileImages = Partial<Record<ProfileImage, string>>;

export type CredentialsUpdated =
  // accepting: the update unlocked the account, so the unlock job has pending requests to accept (unlock-accepts.ts).
  | { status: "ok"; account: CredentialAccount; accepting: boolean }
  | { status: "not_found" }
  // An upload is no longer the viewer's own live upload (swept, deleted or attached since): nothing changed.
  | { status: "upload_gone" };

// In the transaction of a credentials update, after `locked` is applied: relocking clears the job, and unlocking with a
// pending request starts it. True when a job is (still) running for the account.
function unlockChanged(db: Db, accountId: string, wasLocked: boolean, locked: boolean | undefined): boolean {
  if (locked === true) {
    db.run("UPDATE local_accounts SET accept_requests_after = NULL WHERE account_id = ?", accountId);
    return false;
  }
  if (locked === false && wasLocked) {
    db.run(
      `UPDATE local_accounts SET accept_requests_after = 0 WHERE account_id = ?1
				AND EXISTS (SELECT 1 FROM follows WHERE target_account_id = ?1 AND state = 'pending')`,
      accountId,
    );
  }
  return (
    db.first(
      "SELECT 1 AS running FROM local_accounts WHERE account_id = ? AND accept_requests_after IS NOT NULL",
      accountId,
    ) !== undefined
  );
}

// Lengths and values are validated by the caller. display_name and the note are plain text: display_name is stored
// as is (JSON consumers escape it), the note is stored as escaped paragraphs. Everything applies in this transaction,
// images included, with one Update(Person), or nothing does (Mastodon's single update!). A media-delete operation:
// replacing an image dooms the upload behind it (MEDIA-2).
export const updateCredentials = userMediaDeleteOperation<
  { changes: CredentialChanges; images?: ProfileImages; present: Present; now: number },
  CredentialsUpdated
>((db, { changes, images = {}, present, now }, { accountId }) => {
  const current = db.first<{
    username: string;
    display_name: string;
    actor_type: string;
    hide_collections: number;
    locked: number;
  }>(
    `SELECT a.username, a.display_name, a.actor_type, l.hide_collections, a.locked
		FROM accounts a JOIN local_accounts l ON l.account_id = a.id WHERE a.id = ?`,
    accountId,
  );
  if (current === undefined) {
    return { status: "not_found" };
  }
  const kinds = PROFILE_IMAGES.filter((kind) => images[kind] !== undefined);
  if (kinds.some((kind) => !profileUploadReady(db, accountId, images[kind]!, now))) {
    return { status: "upload_gone" };
  }
  const before = actorSnapshot(db, accountId);
  for (const kind of kinds) {
    applyProfileImage(db, accountId, kind, images[kind]!);
  }
  const changedName = changes.displayName === undefined ? null : storedDisplayName(changes.displayName);
  const displayName = changedName ?? current.display_name;
  const hide = bit(changes.hideCollections);
  const actorType =
    changes.bot === undefined || !["Person", "Service"].includes(current.actor_type)
      ? current.actor_type
      : changes.bot
        ? "Service"
        : "Person";
  // An unchanged display name stays as stored (RES-2): read into the Worker and bound again, a legacy value of lone
  // surrogate bytes would come back as three U+FFFD for each, past its bound.
  db.run(
    `UPDATE accounts SET display_name = COALESCE(?, display_name), note = COALESCE(?, note), locked = COALESCE(?, locked),
			discoverable = COALESCE(?, discoverable), indexable = COALESCE(?, indexable), actor_type = ?, search_text = ?
		WHERE id = ?`,
    changedName,
    changes.note === undefined ? null : plainTextToHtml(storedText(changes.note)),
    bit(changes.locked),
    bit(changes.discoverable),
    bit(changes.indexable),
    actorType,
    accountSearchText(current.username, null, displayName),
    accountId,
  );
  db.run(
    `UPDATE local_accounts SET default_visibility = COALESCE(?, default_visibility),
			default_sensitive = COALESCE(?, default_sensitive),
			default_language = CASE WHEN ? THEN ? ELSE default_language END,
			fields = COALESCE(?, fields), hide_collections = COALESCE(?, hide_collections),
			attribution_domains = COALESCE(?, attribution_domains),
			default_quote_policy = COALESCE(?, default_quote_policy)
		WHERE account_id = ?`,
    changes.privacy ?? null,
    bit(changes.sensitive),
    changes.language === undefined ? 0 : 1,
    changes.language ?? null,
    changes.fields === undefined ? null : JSON.stringify(changes.fields.slice(0, MAX_FIELDS)),
    hide,
    changes.attributionDomains === undefined ? null : JSON.stringify(changes.attributionDomains),
    changes.quotePolicy ?? null,
    accountId,
  );
  // Every save keeps the verification of the values it keeps and asks for a check of the others (Mastodon's
  // UpdateAccountService#check_links, app/services/update_account_service.rb:30-34; domain/field-links.ts).
  armFieldLinks(db, accountId, now);
  // Every save takes the profile's local emoji again (custom-emojis.ts localEmojiSnapshot), from the stored display
  // name, note and fields, as Mastodon's Account#emojis reads them (app/models/account.rb:450-451, 486-488).
  const profile = db.first<{ display_name: string; note: string; fields: string }>(
    "SELECT a.display_name, a.note, l.fields FROM accounts a JOIN local_accounts l ON l.account_id = a.id WHERE a.id = ?",
    accountId,
  );
  const texts =
    profile === undefined
      ? []
      : [
          profile.display_name,
          profile.note,
          ...fieldSources(profile.fields).flatMap((field) => [field.name, field.value]),
        ];
  db.run("UPDATE accounts SET emojis = ? WHERE id = ?", localEmojiSnapshot(db, texts, ACCOUNT_EMOJIS_BYTES), accountId);
  // Other servers learn of the change (Update(Person)), only if the published document changed, or if the account
  // shows or hides its network: the document does not carry that, but a server that receives the Update fetches the
  // collections again and learns it from them, as Mastodon's ProcessAccountService does.
  const hideChanged = hide !== null && hide !== current.hide_collections;
  recordActorUpdate(db, accountId, hideChanged ? null : before, now);
  const accepting = unlockChanged(db, accountId, current.locked === 1, changes.locked);
  const account = credentialAccount(db, accountId, present);
  return account === null ? { status: "not_found" } : { status: "ok", account, accepting };
});

function bit(value: boolean | undefined): number | null {
  return value === undefined ? null : value ? 1 : 0;
}

export type FollowInput = {
  target: string;
  reblogs?: boolean | undefined;
  notify?: boolean | undefined;
  languages?: string[] | null | undefined;
  now: number;
};

export type FollowResult = RelationshipResult | { status: "invalid"; errors: string[] };

// The validator's error for a new follow or request past the limit, or null while under it. It applies where Mastodon
// creates a Follow or FollowRequest without bypass_limit: the follow API only. Authorizing a request (local or a remote
// Accept) and a Move's follower transfer bypass it, as there. The following count is derived from the viewer's accepted
// follows (the partial index follows_accepted, the viewer's own rows only), not the cached following_count, so a stale
// cache cannot let a follow through; followers_count, for the ratio, is read from the row.
function followLimitError(db: Db, accountId: string): string | null {
  const counts = db.first<{ following_count: number; followers_count: number }>(
    `SELECT (SELECT COUNT(*) FROM follows WHERE account_id = ?1 AND state = 'accepted') AS following_count,
			${presentedCountSql("followers_count")} AS followers_count
		FROM accounts WHERE id = ?1`,
    accountId,
  );
  if (counts === undefined) {
    return null;
  }
  const limit = followLimit(counts);
  return counts.following_count >= limit ? `You cannot follow more than ${limit} people` : null;
}

type TargetRow = {
  id: string;
  domain: string | null;
  locked: number;
  available: number;
  followable: number;
};

function followTarget(db: Db, viewerId: string, target: string): TargetRow | null {
  const id = resolveAccountId(db, target);
  if (id === null) {
    return null;
  }
  return (
    db.first<TargetRow>(
      `SELECT a.id, a.domain, a.locked, ${availableSql("a.id")} AS available,
				${followableBySql("a.id", "?1")} AS followable
			FROM accounts a WHERE a.id = ?2`,
      viewerId,
      id,
    ) ?? null
  );
}

// Follows or updates the options of an existing follow. A local unlocked target is followed at once; a locked or
// remote target gets a pending request (a remote Accept arrives over federation). A local target is notified
// (follow, or follow_request when locked) in the same transaction; a remote target is sent a Follow (its id kept in
// follows.uri, which the remote Accept must match) and stays pending until that Accept arrives (VIS-8, VIS-9). As
// in Mastodon's FollowService, a suspended target is not found, and a block either way or a domain block of the
// viewer forbids the follow. A new follow or request past the follow limit is refused (422); changing the options of
// an existing one is not, as the validator runs on create only. The follow API and /authorize_interaction's follow
// (domain/interaction.ts) both run it.
export function followAccount(db: Db, input: FollowInput, viewerId: string): FollowResult {
  const target = followTarget(db, viewerId, input.target);
  if (target === null || target.available === 0) {
    return { status: "not_found" };
  }
  if (target.followable === 0) {
    return { status: "forbidden" };
  }
  // undefined keeps the current filter; null or an empty list means every language (no filter).
  const languages =
    input.languages === undefined
      ? undefined
      : input.languages === null || input.languages.length === 0
        ? null
        : JSON.stringify(input.languages);
  const existing = db.first(
    "SELECT 1 AS found FROM follows WHERE account_id = ? AND target_account_id = ?",
    viewerId,
    target.id,
  );
  if (existing === undefined) {
    const limitError = followLimitError(db, viewerId);
    if (limitError !== null) {
      return { status: "invalid", errors: [limitError] };
    }
    const state = target.domain === null && target.locked === 0 ? "accepted" : "pending";
    const edge = db.first<{ id: string }>(
      `INSERT INTO follows (account_id, target_account_id, state, show_reblogs, notify, languages, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING CAST(id AS TEXT) AS id`,
      viewerId,
      target.id,
      state,
      bit(input.reblogs ?? true),
      bit(input.notify ?? false),
      languages ?? null,
      new Date(input.now).toISOString(),
    );
    if (target.domain === null) {
      const type = state === "accepted" ? "follow" : "follow_request";
      notify(db, { recipientId: target.id, type, fromId: viewerId, statusId: null, now: input.now });
    } else if (edge !== undefined) {
      const activity = remoteFollow(db, viewerId, target, edge.id, null);
      db.run("UPDATE follows SET uri = ? WHERE id = CAST(? AS INTEGER)", activity.followUri, edge.id);
      recordOutbound(db, viewerId, followActivity(activity), input.now);
    }
  } else {
    db.run(
      `UPDATE follows SET show_reblogs = COALESCE(?, show_reblogs), notify = COALESCE(?, notify),
				languages = CASE WHEN ? THEN ? ELSE languages END
			WHERE account_id = ? AND target_account_id = ?`,
      bit(input.reblogs),
      bit(input.notify),
      languages === undefined ? 0 : 1,
      languages ?? null,
      viewerId,
      target.id,
    );
  }
  recountFollows(db, viewerId, target);
  return relationshipResult(db, viewerId, target.id, input.now);
}

export const follow = userWriteOperation<FollowInput, FollowResult>((db, input, { accountId }) =>
  followAccount(db, input, accountId),
);

export const unfollow = userWriteOperation<{ target: string; now: number }, RelationshipResult>(
  (db, { target: targetId, now }, { accountId: viewerId }) => {
    const target = followTarget(db, viewerId, targetId);
    if (target === null) {
      return { status: "not_found" };
    }
    const removed = db.first<{ id: string; uri: string | null }>(
      "DELETE FROM follows WHERE account_id = ? AND target_account_id = ? RETURNING CAST(id AS TEXT) AS id, uri",
      viewerId,
      target.id,
    );
    // A remote follow, accepted or still requested, is undone there too (UnfollowService).
    if (removed !== undefined && target.domain !== null) {
      recordOutbound(
        db,
        viewerId,
        undoFollowActivity(remoteFollow(db, viewerId, target, removed.id, removed.uri)),
        now,
      );
    }
    // The follow's notification goes with it, as Mastodon destroys a notification with its activity.
    db.run(
      "DELETE FROM notifications WHERE account_id = ? AND from_account_id = ? AND type IN ('follow', 'follow_request')",
      target.id,
      viewerId,
    );
    recountFollows(db, viewerId, target);
    return relationshipResult(db, viewerId, target.id, now);
  },
);

// The Follow of a remote follow edge. Migrated edges may have no stored uri; they get the id this instance would
// have given them (a remote server matches an Undo by actor and object as well).
function remoteFollow(db: Db, viewerId: string, target: TargetRow, edgeId: string, uri: string | null) {
  const actorUri = db.first<{ uri: string }>("SELECT uri FROM accounts WHERE id = ?", viewerId)?.uri ?? "";
  const targetUri = db.first<{ uri: string }>("SELECT uri FROM accounts WHERE id = ?", target.id)?.uri ?? "";
  return { followUri: uri ?? followUri(actorUri, edgeId), actorUri, targetUri, targetId: target.id };
}

// Counts are recomputed from the edges in the transaction that changed them. A remote account's counts are the ones
// its collections report (remote-collections.ts completeCollectionRead) and are left alone.
function recountFollows(db: Db, viewerId: string, target: Pick<TargetRow, "id" | "domain">): void {
  db.run(
    `UPDATE accounts SET following_count =
			(SELECT COUNT(*) FROM follows WHERE account_id = ?1 AND state = 'accepted') WHERE id = ?1`,
    viewerId,
  );
  if (target.domain === null) {
    db.run(
      `UPDATE accounts SET followers_count =
				(SELECT COUNT(*) FROM follows WHERE target_account_id = ?1 AND state = 'accepted') WHERE id = ?1`,
      target.id,
    );
  }
}

// Authorizes or rejects a pending follow of the viewer. A remote requester gets the Accept or Reject at its personal
// inbox, named after its Follow (followAnswerActivity). The follow_request notification goes either way. An
// unavailable requester (R1, R38) is not found, read in this transaction: a request authorized after its requester's
// suspension would leave a follower its suspension never severed.
export const answerFollowRequest = userWriteOperation<
  { account: string; decision: "authorize" | "reject"; now: number },
  RelationshipResult
>((db, { account, decision, now }, { accountId: viewerId }) => {
  const requesterId = resolveAccountId(db, account);
  if (requesterId === null) {
    return { status: "not_found" };
  }
  const answered = answerPendingFollow(db, viewerId, requesterId, decision, now);
  return answered === "ok" ? relationshipResult(db, viewerId, requesterId, now) : { status: answered };
});

// The answer to one pending follow of `viewerId` by `requesterId`, as POST /api/v1/follow_requests/:id/authorize and
// /reject run it, and as the unlock job (unlock-accepts.ts) authorizes each request.
export function answerPendingFollow(
  db: Db,
  viewerId: string,
  requesterId: string,
  decision: "authorize" | "reject",
  now: number,
): "ok" | "not_found" | "unavailable" {
  const request = db.first<{ id: string; uri: string | null; requester_uri: string; remote: number }>(
    `SELECT CAST(f.id AS TEXT) AS id, f.uri, a.uri AS requester_uri, a.domain IS NOT NULL AS remote
		FROM follows f JOIN accounts a ON a.id = f.account_id
		WHERE f.account_id = ?1 AND f.target_account_id = ?2 AND f.state = 'pending' AND ${availableSql("?1")}`,
    requesterId,
    viewerId,
  );
  if (request === undefined) {
    return "not_found";
  }
  if (decision === "authorize") {
    db.run("UPDATE follows SET state = 'accepted' WHERE id = CAST(? AS INTEGER)", request.id);
  } else {
    // A rejected remote Follow is recorded as retracted (retractFollow), so a redelivery of it does not ask again
    // (ID-7); a Misskey pair id is not recorded, and its redelivery asks again (the pair limit). If it
    // cannot be recorded (the requester's retraction cap), nothing changes.
    if (request.remote === 1 && request.uri !== null && !retractFollow(db, request.requester_uri, request.uri, now)) {
      return "unavailable";
    }
    db.run("DELETE FROM follows WHERE id = CAST(? AS INTEGER)", request.id);
  }
  db.run(
    "DELETE FROM notifications WHERE account_id = ? AND from_account_id = ? AND type = 'follow_request'",
    viewerId,
    requesterId,
  );
  if (request.remote === 1) {
    const viewerUri = db.first<{ uri: string }>("SELECT uri FROM accounts WHERE id = ?", viewerId)?.uri ?? "";
    recordOutbound(
      db,
      viewerId,
      followAnswerActivity(decision === "authorize" ? "Accept" : "Reject", {
        localActorUri: viewerUri,
        followerUri: request.requester_uri,
        followerId: requesterId,
        followUri: request.uri,
        edgeId: request.id,
      }),
      now,
    );
  }
  // The viewer's followers changed; an authorized local requester also follows one more account now.
  if (decision === "authorize" && request.remote === 0) {
    recountFollows(db, requesterId, { id: viewerId, domain: null });
  } else {
    db.run(
      `UPDATE accounts SET followers_count =
				(SELECT COUNT(*) FROM follows WHERE target_account_id = ?1 AND state = 'accepted') WHERE id = ?1`,
      viewerId,
    );
  }
  return "ok";
}
