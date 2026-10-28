import { ACCOUNTS_URI_INDEX } from "../db/indexes";
import type { Db } from "../db/sql";
import { hostDomain } from "../platform/domain-name";
import { ACCOUNT_EMOJIS_BYTES, isoTimeSql, nextDocumentRevisionSql } from "../platform/stored-bounds";
import { presentedRemoteFields } from "./accounts";
import { availableSql, deletingSql, domainCoveredSql, individuallySuspendedSql } from "./audience";
import { actorCollections, requestCollectionSync } from "./collection-requests";
import { type EmojiCandidate, emojiSnapshot } from "./custom-emojis";
import { insertWithFreshId, remoteId } from "./ids";
import { hostCovered } from "./instance-domain-blocks";
import { armRemoteFieldLinks, remoteLinkBack } from "./remote-field-links";
import { noteEmojiSnapshot, syncProfileFiles } from "./remote-media";
import { accountSearchText } from "./search-text";

// Remote actors as the Store keeps them: storing and refreshing one (upsertRemoteActor, applyRefresh), its stored
// revision, and whether an actor or an object was deleted or retracted. The inbox (inbox.ts), remote statuses and quotes
// build on it.

// A retraction (Undo or Delete) is kept this long; an activity it names that arrives later is ignored (ID-7).
export const RETRACTION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Expired retractions, finished jobs and expired mutes removed per call (RES-4), so the sweep stays bounded and
// keeps up.
export const SWEEP_BATCH = 100;
// A stored remote account whose document was stored this long ago (accounts.fetched_at, inclusive) is fetched again
// before a status Kopje fetched by it is stored (staleAccount): Mastodon's Account::STALE_THRESHOLD and
// possibly_stale? (account.rb:71,254-256), a policy separate from KEY_REFRESH_MS.
export const ACCOUNT_STALE_MS = 24 * 60 * 60 * 1000;
// A remote actor as the Worker extracted it from a fetched, origin-checked document (ID-2). Text is bounded,
// display_name is plain text, note is sanitized HTML (HTML-1) and URLs are http(s) or null (HTML-3). keys are the
// public keys the document lists whose owner is this actor and whose id has its origin.
export type RemoteActorInput = {
  uri: string;
  username: string;
  domain: string;
  actorType: string;
  displayName: string;
  note: string;
  url: string | null;
  avatarUrl: string | null;
  headerUrl: string | null;
  locked: boolean;
  discoverable: boolean | null;
  // The actor's toot:indexable, true only when the document says so (ProcessAccountService: `@json['indexable']`).
  indexable: boolean;
  inboxUrl: string | null;
  sharedInboxUrl: string | null;
  published: string | null;
  keys: { id: string; pem: string }[];
  // Emoji tags as read (federation/remote-emoji.ts); the snapshot is chosen when the account is written.
  emojiTags: EmojiCandidate[];
  // The document as received; followers, alsoKnownAs and fields are read from it.
  raw: string;
  // The actor id the document's movedTo names (Fedify's successorId), when Kopje stores such an id; else null.
  movedTo: string | null;
  // The canonical domain of the actor's address for this username, set by the search resolver only after the actor's
  // host declared it and that domain confirmed it (declaredDomain in federation/resolve.ts); the host itself when
  // the host's own answer names it there. Never set from a document.
  confirmedDomain?: string;
};

// A refusal that must leave no trace: thrown out of the operation, so its transaction rolls back (the actor's
// document and keys stored before the handler ran included), and turned into a retryable answer by the Store's RPC
// (store.ts), which the Worker answers 503.
export class RetryLater extends Error {
  constructor(readonly reason: string) {
    super(`retry later: ${reason}`);
  }
}

export function originOf(uri: string | null): string | null {
  if (uri === null) {
    return null;
  }
  try {
    return new URL(uri).origin;
  } catch {
    return null;
  }
}

export type RemoteRow = { id: string; uri: string; domain: string };

// What upsertRemoteActor stored.
export type StoredActor = RemoteRow & { syncWaiting: boolean; frozen: boolean };

// ID-1's revision fence. accounts.document_revision changes with every store of a remote actor's document (its profile,
// keys, movedTo or routing), the Move handler's movedTo included (nextDocumentRevisionSql, migration 0073). A writer
// that fetches a document reads the revision first, in the Store, and passes it as its expectation: the stored
// revision, or null when no remote row of the uri was stored. Read before the fetch on purpose: it is no credential
// but the state the document must still find, so a document fetched before another store committed is never stored
// over it, however late it arrives. The comparison (revisionHolds), in the transaction that would store it:
//   expectation   row absent              row present with revision g
//   null          stored (a new row)      superseded, g = 0 included
//   n             superseded              stored only when n = g
//   (none)        stored                  stored
// A writer without one (none) stores what it fetched as Mastodon's ProcessAccountService does, guarded instead by its
// own absence check in the same transaction: a boosted or quoted author Kopje does not know. It still issues a new
// revision, so a fenced document fetched before it is superseded.
export type DocumentRevision = number | null;

// The remote row of `uri` with its revision (the trigger of migration 0073 holds it to an integer), if any.
function storedRevision(db: Db, uri: string): { revision: number | null } | undefined {
  return db.first<{ revision: number | null }>(
    `SELECT CASE WHEN typeof(document_revision) = 'integer' THEN document_revision END AS revision
		FROM accounts INDEXED BY ${ACCOUNTS_URI_INDEX} WHERE uri = ? AND domain IS NOT NULL`,
    uri,
  );
}

// The stored revision of the remote actor `uri`, or null when it has no remote row. A local row reads as null too: no
// document of it is ever stored (ID-3).
export function actorRevision(db: Db, uri: string): DocumentRevision {
  return storedRevision(db, uri)?.revision ?? null;
}

// Whether a document of `uri` fetched under the expectation `expected` may be stored (the table at DocumentRevision).
export function revisionHolds(db: Db, uri: string, expected: DocumentRevision | undefined): boolean {
  if (expected === undefined) {
    return true;
  }
  const row = storedRevision(db, uri);
  return expected === null ? row === undefined : row !== undefined && row.revision === expected;
}

// The stored remote account of `uri` (none for a local one), available or not.
export function remoteAccount(db: Db, uri: string): RemoteRow | undefined {
  return db.first<RemoteRow>("SELECT id, uri, domain FROM accounts WHERE uri = ? AND domain IS NOT NULL", uri);
}

// Whether the actor deleted itself: its purge job is its tombstone while it lasts (ID-7, independent of the
// retraction cap and TTL).
export function isDeletedActor(db: Db, uri: string, now: number): boolean {
  return (
    db.first(
      "SELECT 1 AS x FROM inbound_jobs WHERE kind = 'purge' AND key = ? AND (expires_at IS NULL OR expires_at > ?)",
      uri,
      now,
    ) !== undefined
  );
}

// The domain of a remote account's address (its acct), decided here for every path that stores an actor. A domain
// other than the actor's host holds only for the (username, domain, actor id) it was confirmed for: the actor id is
// the row's own, and confirmed_username the username. So:
//   - a confirmation in hand (confirmedDomain) sets it: another domain with this username, or the host (clearing any);
//   - otherwise a stored confirmation is kept while the username is unchanged;
//   - otherwise, a changed username included, the address falls back to the actor's host until it is confirmed again.
// Inbound documents never carry a confirmation (Gap: inbound processing does not look up WebFinger), so they keep a
// confirmed address while the username is unchanged and never set one. Domain blocks also match the actor's host
// (inDomainSql in audience.ts).
function accountDomain(
  stored: { domain: string; confirmed_username: string | null } | undefined,
  actor: RemoteActorInput,
): { domain: string; confirmedUsername: string | null } {
  const host = hostDomain(actor.uri);
  if (actor.confirmedDomain !== undefined) {
    return actor.confirmedDomain === host
      ? { domain: host, confirmedUsername: null }
      : { domain: actor.confirmedDomain, confirmedUsername: actor.username };
  }
  if (stored !== undefined && stored.confirmed_username !== null && stored.confirmed_username === actor.username) {
    return { domain: stored.domain, confirmedUsername: stored.confirmed_username };
  }
  return { domain: host, confirmedUsername: null };
}

// R38 (Mastodon's set_immediate_protocol_attributes!): a verified document of an individually suspended account updates
// its inbox and shared inbox only, so that moderation's Rejects reach a current inbox. Its profile, keys and stored
// domain stay frozen; the values passed remote-actor.ts's checks as any refresh's. An account an instance domain block
// covers takes no refresh at all (its documents are not fetched).
// A change of the routing issues a new revision (DocumentRevision); the caller has compared the expectation first.
export function refreshRouting(db: Db, accountId: string, actor: RemoteActorInput): void {
  db.run(
    `UPDATE accounts SET inbox_url = ?2, shared_inbox_url = ?3,
			document_revision = ${nextDocumentRevisionSql("document_revision")}
		WHERE id = ?1 AND ${individuallySuspendedSql("accounts")} AND (inbox_url IS NOT ?2 OR shared_inbox_url IS NOT ?3)
			AND NOT ${domainCoveredSql("accounts")}`,
    accountId,
    actor.inboxUrl,
    actor.sharedInboxUrl,
  );
}

// The stored remote account of `uri` when it is unavailable (R1): the account the instance suspended (R38).
export function unavailableRemote(db: Db, uri: string): RemoteRow | undefined {
  return db.first<RemoteRow>(
    `SELECT a.id, a.uri, a.domain FROM accounts a WHERE a.uri = ? AND a.domain IS NOT NULL AND NOT ${availableSql("a.id")}`,
    uri,
  );
}

// Inserts or refreshes a remote account and its keys from its document. Never touches a local row (ID-3): a URI on
// this instance's origin, or one a local account holds, is refused, and so is a deleted actor. An unavailable account
// (R38, VIS-30) is never refreshed: its stored row is returned unchanged (frozen), but for a routing refresh
// (refreshRouting), as Mastodon leaves a suspended account's key and attributes as they were. No account is stored, and
// none moves, under an instance domain block: a document whose actor host or domain is covered stores nothing, and
// leaves a stored row unchanged (Mastodon's ProcessAccountService stores nothing on a blocked domain), so the set of
// accounts a block covers is fixed when it commits. A refresh stores only an account no block covers, by its stored
// keys or its new ones, so it clears a domain mark left from a lifted block (R38) in its own transaction: the mark
// never outlives the account's move to another domain. A document that names
// any of its collections asks for them to be read (remote-collections.ts, as ActivityPub::ProcessAccountService
// schedules its syncs each time it processes the account); syncWaiting: a request waits for a round.
// expected: the revision the writer read before it fetched the document (DocumentRevision). When it no longer holds,
// nothing of the document is stored, the routing of a frozen row included, and the answer is 'superseded': the caller
// decides what the stored row is worth to it. Every store issues a new revision.
export function upsertRemoteActor(
  db: Db,
  actor: RemoteActorInput,
  origin: string,
  now: number,
): StoredActor | undefined;
export function upsertRemoteActor(
  db: Db,
  actor: RemoteActorInput,
  origin: string,
  now: number,
  expected: DocumentRevision,
): StoredActor | "superseded" | undefined;
export function upsertRemoteActor(
  db: Db,
  actor: RemoteActorInput,
  origin: string,
  now: number,
  expected?: DocumentRevision,
): StoredActor | "superseded" | undefined {
  if (
    originOf(actor.uri) === origin ||
    db.first("SELECT 1 AS x FROM accounts WHERE uri = ? AND domain IS NULL", actor.uri) !== undefined ||
    isDeletedActor(db, actor.uri, now)
  ) {
    return undefined;
  }
  if (!revisionHolds(db, actor.uri, expected)) {
    return "superseded";
  }
  const frozen = unavailableRemote(db, actor.uri);
  if (frozen !== undefined) {
    refreshRouting(db, frozen.id, actor);
    return { ...frozen, syncWaiting: false, frozen: true };
  }
  const published = actor.published === null ? NaN : Date.parse(actor.published);
  const createdAt = new Date(Number.isNaN(published) || published > now ? now : published).toISOString();
  const stored = db.first<{ domain: string; confirmed_username: string | null }>(
    "SELECT domain, confirmed_username FROM accounts WHERE uri = ? AND domain IS NOT NULL",
    actor.uri,
  );
  const { domain, confirmedUsername } = accountDomain(stored, actor);
  if (hostCovered(db, hostDomain(actor.uri)) || hostCovered(db, domain)) {
    const row = remoteAccount(db, actor.uri);
    return row === undefined ? undefined : { ...row, syncWaiting: false, frozen: true };
  }
  // The snapshot of the emoji the stored name, bio and presented fields reference (custom-emojis.ts), replaced by
  // every refresh and Update(Person).
  const { fields, links } = presentedRemoteFields(db, actor.raw, domain);
  const emojis = emojiSnapshot(
    actor.emojiTags,
    [actor.displayName, actor.note, ...fields.flatMap((field) => [field.name, field.value])],
    ACCOUNT_EMOJIS_BYTES,
  );
  const values = [
    actor.uri,
    actor.username,
    domain,
    actor.actorType,
    actor.displayName,
    actor.note,
    actor.url,
    actor.avatarUrl,
    actor.headerUrl,
    actor.locked ? 1 : 0,
    actor.discoverable === null ? null : actor.discoverable ? 1 : 0,
    actor.indexable ? 1 : 0,
    actor.inboxUrl,
    actor.sharedInboxUrl,
    actor.raw,
    new Date(now).toISOString(),
    accountSearchText(actor.username, domain, actor.displayName),
    createdAt,
    confirmedUsername,
    emojis,
  ];
  insertWithFreshId(
    "accounts",
    () => remoteId(actor.published ?? "", now),
    (id) =>
      db.run(
        `INSERT INTO accounts (id, uri, username, domain, actor_type, display_name, note, url, avatar_url, header_url,
					locked, discoverable, indexable, inbox_url, shared_inbox_url, raw, fetched_at, search_text, created_at,
					confirmed_username, emojis, document_revision)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${nextDocumentRevisionSql(null)})
				ON CONFLICT (uri) DO UPDATE SET username = excluded.username,
					document_revision = ${nextDocumentRevisionSql("accounts.document_revision")}, actor_type = excluded.actor_type,
					display_name = excluded.display_name, note = excluded.note, url = excluded.url,
					avatar_url = excluded.avatar_url, header_url = excluded.header_url, locked = excluded.locked,
					discoverable = excluded.discoverable, indexable = excluded.indexable, inbox_url = excluded.inbox_url,
					shared_inbox_url = excluded.shared_inbox_url, raw = excluded.raw, fetched_at = excluded.fetched_at,
					search_text = excluded.search_text, domain = excluded.domain,
					confirmed_username = excluded.confirmed_username, emojis = excluded.emojis,
					suspended_at = CASE WHEN accounts.suspension_source = 'domain' THEN NULL ELSE accounts.suspended_at END,
					suspension_source = CASE WHEN accounts.suspension_source = 'domain' THEN NULL
						ELSE accounts.suspension_source END
				WHERE accounts.domain IS NOT NULL`,
        id,
        ...values,
      ),
  );
  const row = remoteAccount(db, actor.uri);
  if (row !== undefined) {
    // The account's move as its document states it, set or cleared by every store (Mastodon's
    // ProcessAccountService: process_account_service.rb:166), written once the row is stored, by its id: an account
    // other than itself, stored and not being purged, by its actor id; one Kopje does not know reads as none, as it is
    // not fetched (process_account_service.rb:310-314 fetches it).
    db.run(
      `UPDATE accounts SET moved_to_account_id = (SELECT m.id FROM accounts m INDEXED BY ${ACCOUNTS_URI_INDEX}
				WHERE m.uri = ?2 AND m.id <> ?1 AND NOT ${deletingSql("m")})
			WHERE id = ?1 AND domain IS NOT NULL`,
      row.id,
      actor.movedTo,
    );
    // The links of its fields to verify, from the same projection (remote-field-links.ts).
    armRemoteFieldLinks(db, row.id, remoteLinkBack(actor.uri, actor.url), links, now);
    // Its avatar and header to cache, from the same projection (remote-media.ts).
    syncProfileFiles(db, row.id, { avatar: actor.avatarUrl, header: actor.headerUrl }, now);
    // Its custom emoji to cache, from the snapshot just stored (remote-media.ts).
    noteEmojiSnapshot(db, emojis, domain, now);
    // The document lists the actor's current keys; keys it no longer lists are not trusted any more.
    db.run("DELETE FROM remote_keys WHERE account_id = ?", row.id);
    for (const key of actor.keys) {
      if (originOf(key.id) !== originOf(actor.uri)) {
        continue;
      }
      db.run(
        `INSERT INTO remote_keys (key_id, account_id, pem, fetched_at) VALUES (?, ?, ?, ?)
				ON CONFLICT (key_id) DO UPDATE SET account_id = excluded.account_id, pem = excluded.pem,
					fetched_at = excluded.fetched_at`,
        key.id,
        row.id,
        key.pem,
        now,
      );
    }
  }
  if (row === undefined) {
    return undefined;
  }
  const collections = actorCollections(actor.raw);
  const named = Object.values(collections).some((url) => url !== null);
  return { ...row, syncWaiting: named && requestCollectionSync(db, row.id, now), frozen: false };
}

// Whether the remote account `id` is fetched again before a status Kopje fetched by it is stored (ACCOUNT_STALE_MS,
// Mastodon's possibly_stale?): a remote row that is available (R38, VIS-30: never refetched) and whose fetched_at is
// ACCOUNT_STALE_MS old or older, or not a stored time (NULL, or an imported value isoTimeSql does not read).
export function staleAccount(db: Db, id: string, now: number): boolean {
  return (
    db.first(
      `SELECT 1 AS x FROM accounts a
			WHERE a.id = ?1 AND a.domain IS NOT NULL AND ${availableSql("a.id")}
				AND COALESCE(${isoTimeSql("a.fetched_at")} <= ?2, 1)`,
      id,
      new Date(now - ACCOUNT_STALE_MS).toISOString(),
    ) !== undefined
  );
}

// The outcome of refetching a stale stored author (staleAccount), applied in the transaction that stores its status.
// Applied only while the row is still stale, so the first outcome to commit wins: a row refreshed, stamped or made
// unavailable meanwhile is kept as it is ('current'). Staleness is the refresh policy, not the fence: a Move's movedTo
// changes the revision but not fetched_at, so the document is also compared with `expected`, the author's revision read
// when the refetch was decided (DocumentRevision), and a superseded one stores nothing ('current', the stored row).
// While it is stale:
//   - a usable document of this actor (ok) is stored (upsertRemoteActor) while `expected` holds: 'refreshed', frozen if
//     it stored nothing;
//   - 'gone' (404 or 410) writes nothing, and nothing is stored under the account ('refused'), as for an author that
//     cannot be fetched;
//   - any other failure (null: unusable, another id, or one that may pass, budget and deadline included) stamps
//     fetched_at only ('stamped'): the stored row is used, and refetched a day later. remote_keys are not touched,
//     so key trust (ID-1) is not extended.
// Limitation: a 'gone' that commits after another request's stamp finds the row fresh and is not applied.
export function applyRefresh(
  db: Db,
  author: RemoteRow,
  document: RemoteActorInput | null | "gone",
  origin: string,
  now: number,
  expected: DocumentRevision,
): { kind: "current" | "refreshed" | "stamped"; author: RemoteRow; frozen: boolean } | { kind: "refused" } {
  const current = { kind: "current", author, frozen: false } as const;
  if (!staleAccount(db, author.id, now)) {
    return current;
  }
  if (document === "gone") {
    return { kind: "refused" };
  }
  if (document === null || document.uri !== author.uri) {
    db.run(
      "UPDATE accounts SET fetched_at = ?2 WHERE id = ?1 AND domain IS NOT NULL",
      author.id,
      new Date(now).toISOString(),
    );
    return { kind: "stamped", author, frozen: false };
  }
  const stored = upsertRemoteActor(db, document, origin, now, expected);
  if (stored === "superseded") {
    return current;
  }
  return stored === undefined ? { kind: "refused" } : { kind: "refreshed", author: stored, frozen: stored.frozen };
}

export function isRetracted(db: Db, actorUri: string, targetUri: string, now: number): boolean {
  return (
    db.first(
      "SELECT 1 AS x FROM inbound_retractions WHERE actor_uri = ? AND target_uri = ? AND expires_at > ?",
      actorUri,
      targetUri,
      now,
    ) !== undefined
  );
}

// The actor_uri of a deletion that holds for every actor: a status or boost that was stored and deleted by its author
// is not created again under that uri by anyone, its author or another actor of the same origin (ID-6, ID-7). A Delete
// of an unknown object stays the actor's own (it cannot suppress another actor's objects never seen here).
export const ANY_ACTOR = "*";

// Whether `uri` may not be created by `actorUri`: the actor retracted it, or it was stored and deleted.
export function isDeleted(db: Db, actorUri: string, uri: string, now: number): boolean {
  return isRetracted(db, actorUri, uri, now) || isRetracted(db, ANY_ACTOR, uri, now);
}
