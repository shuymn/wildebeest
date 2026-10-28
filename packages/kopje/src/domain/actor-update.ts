import type { Db } from "../db/sql";
import { parseProfileUpdates, PROFILE_UPDATES } from "../platform/dump-catalog";
import { httpUrl } from "../platform/http-url";
import { ACCOUNT_EMOJIS_BYTES, presentedLocalFieldsSql } from "../platform/stored-bounds";
import { fieldSources } from "./accounts";
import { featuredUri, followersUri, recordOutbound } from "./activities";
import { PUBLIC_COLLECTION } from "./audience";
import { localEmojiTags } from "./custom-emojis";
import type { DeliveryEnvelope } from "./deliveries";
import { allocateLocalId } from "./ids";
import { renderFieldValue } from "./status-text";

// Profile changes reach other servers as Update(Person), as Mastodon's ActivityPub::UpdateDistributionWorker sends
// them: to Public, delivered to the followers' inboxes by domain/deliveries.ts. An Update supersedes earlier
// Updates of the same actor, so several quick edits deliver only the latest document. The object is the actor document
// with the fields Mastodon's ProcessAccountService reads from an Update; it matches what the actor endpoint publishes
// (federation.ts, which renders it through Fedify).

const CONTEXT = [
  "https://www.w3.org/ns/activitystreams",
  "https://w3id.org/security/v1",
  {
    manuallyApprovesFollowers: "as:manuallyApprovesFollowers",
    toot: "http://joinmastodon.org/ns#",
    featured: { "@id": "toot:featured", "@type": "@id" },
    featuredTags: { "@id": "toot:featuredTags", "@type": "@id" },
    discoverable: "toot:discoverable",
    indexable: "toot:indexable",
    schema: "http://schema.org#",
    PropertyValue: "schema:PropertyValue",
    value: "schema:value",
    alsoKnownAs: { "@id": "as:alsoKnownAs", "@type": "@id" },
    attributionDomains: { "@id": "toot:attributionDomains", "@container": "@set" },
    Emoji: "toot:Emoji",
  },
];

// The context of a suspended actor's Update, which names `suspended` (toot:suspended) as Mastodon's context does.
const SUSPENDED_CONTEXT = [CONTEXT[0], CONTEXT[1], { ...(CONTEXT[2] as object), suspended: "toot:suspended" }];

type ActorRow = {
  uri: string;
  username: string;
  actor_type: string;
  display_name: string;
  note: string;
  avatar_url: string | null;
  header_url: string | null;
  locked: number;
  discoverable: number | null;
  indexable: number | null;
  also_known_as: string;
  fields: string | null;
  attribution_domains: string;
  pubkey: string;
  created_at: string;
  suspended_at: string | null;
  emojis: string | null;
};

function image(stored: string | null): { type: "Image"; url: string } | undefined {
  const url = httpUrl(stored);
  return url === null ? undefined : { type: "Image", url: url.href };
}

function actorRow(db: Db, accountId: string): ActorRow | undefined {
  return db.first<ActorRow>(
    `SELECT a.uri, a.username, a.actor_type, a.display_name, a.note, a.avatar_url, a.header_url, a.locked,
			a.discoverable, a.indexable, l.also_known_as, ${presentedLocalFieldsSql("l.fields")} AS fields,
			l.attribution_domains, l.pubkey, a.created_at,
			l.suspended_at, a.emojis
		FROM accounts a JOIN local_accounts l ON l.account_id = a.id WHERE a.id = ?`,
    accountId,
  );
}

// The document of an actor row. A suspended actor is presented as the actor endpoint presents it (federation.ts, as
// Mastodon's ActivityPub::ActorSerializer): no name, summary, icon, image, aliases or fields, not locked or
// discoverable or indexable, and `suspended: true`; its keys, inboxes and collections stay.
function documentOf(db: Db, row: ActorRow): Record<string, unknown> {
  const origin = new URL(row.uri).origin;
  const suspended = row.suspended_at !== null;
  const emojis = suspended ? [] : localEmojiTags(db, row.emojis, origin, ACCOUNT_EMOJIS_BYTES);
  return {
    id: row.uri,
    type: row.actor_type,
    preferredUsername: row.username,
    ...(suspended ? {} : { name: row.display_name, summary: row.note }),
    url: `${origin}/@${row.username}`,
    inbox: `${row.uri}/inbox`,
    outbox: `${row.uri}/outbox`,
    followers: followersUri(row.uri),
    following: `${row.uri}/following`,
    featured: featuredUri(row.uri),
    featuredTags: `${row.uri}/collections/tags`,
    endpoints: { sharedInbox: `${origin}/inbox` },
    publicKey: { id: `${row.uri}#main-key`, owner: row.uri, publicKeyPem: row.pubkey },
    published: row.created_at,
    ...(suspended
      ? { manuallyApprovesFollowers: false, discoverable: false, indexable: false, suspended: true }
      : {
          manuallyApprovesFollowers: row.locked === 1,
          discoverable: row.discoverable === null ? undefined : row.discoverable === 1,
          indexable: row.indexable === 1,
          icon: image(row.avatar_url),
          image: image(row.header_url),
          alsoKnownAs: (JSON.parse(row.also_known_as) as string[]).flatMap((uri) => httpUrl(uri)?.href ?? []),
          attachment: fieldSources(row.fields).map((field) => ({
            type: "PropertyValue",
            name: field.name,
            value: renderFieldValue(field.value),
          })),
          ...(emojis.length === 0 ? {} : { tag: emojis }),
        }),
    ...attributionDomainsOf(row.attribution_domains),
  };
}

// The local actor document of an account, or null for none (or a suspended one, which sends no profile Update).
export function actorDocument(db: Db, accountId: string): Record<string, unknown> | null {
  const row = actorRow(db, accountId);
  return row === undefined || row.suspended_at !== null ? null : documentOf(db, row);
}

// The Update of the account's actor that a suspension or an unsuspension sends (SuspendAccountService and
// UnsuspendAccountService#distribute_update_actor!): the document as it is now, redacted while the account is
// suspended. Its audience is not the followers alone (AccountReachFinder): the moderation jobs stage it
// (domain/suspension.ts), so the envelope names none. null for an account that is not local.
export function moderationUpdate(db: Db, accountId: string, now: number): DeliveryEnvelope | null {
  const row = actorRow(db, accountId);
  if (row === undefined) {
    return null;
  }
  return {
    activity: {
      "@context": row.suspended_at === null ? CONTEXT : SUSPENDED_CONTEXT,
      id: `${row.uri}#updates/${allocateLocalId(db, now)}`,
      type: "Update",
      actor: row.uri,
      to: [PUBLIC_COLLECTION],
      object: documentOf(db, row),
    },
    audience: { followers: false, accounts: [] },
  };
}

// `attributionDomains`, as ActivityPub::ActorSerializer adds it: only when the account has one.
function attributionDomainsOf(stored: string): { attributionDomains?: string[] } {
  const domains = JSON.parse(stored) as string[];
  return domains.length === 0 ? {} : { attributionDomains: domains };
}

// Records an Update of the account's actor if its document changed since `before` (actorDocument's earlier value,
// serialized; null records it in any case). Called in the transaction that changed the profile. Returns whether it
// recorded one.
export function recordActorUpdate(db: Db, accountId: string, before: string | null, now: number): boolean {
  const document = actorDocument(db, accountId);
  if (document === null || JSON.stringify(document) === before) {
    return false;
  }
  const actor = String(document.id);
  recordOutbound(
    db,
    accountId,
    {
      activity: {
        "@context": CONTEXT,
        id: `${actor}#updates/${allocateLocalId(db, now)}`,
        type: "Update",
        actor,
        to: [PUBLIC_COLLECTION],
        object: document,
      },
      audience: { followers: true, accounts: [] },
    },
    now,
  );
  // The document carries the featured collections, so the Add or Remove of a pin or a featured hashtag needs no
  // Update first (announceFeatured).
  db.run("UPDATE local_accounts SET featured_announced = 1 WHERE account_id = ? AND featured_announced = 0", accountId);
  return true;
}

// Announces the featured collections once, before the account's first Add or Remove of a pin or a featured hashtag:
// Mastodon's ActivityPub::Activity::Add and Remove act only when the target is the `featured` (or `featuredTags`) of
// the actor it has stored, so servers that stored the actor before it published them are sent an Update of the actor
// first, once (local_accounts.featured_announced; any Update of the actor sets it).
export function announceFeatured(db: Db, accountId: string, now: number): void {
  const announced = db.first<{ featured_announced: number }>(
    "SELECT featured_announced FROM local_accounts WHERE account_id = ?",
    accountId,
  );
  if (announced?.featured_announced === 0) {
    recordActorUpdate(db, accountId, null, now);
  }
}

// At publication, in its transaction: the local accounts whose avatar or header a cutover conversion changed
// (PROFILE_UPDATES) get the Update a profile edit sends, since other servers keep the old image URLs in their copy of
// the actor until they fetch it again. The list is deleted with it, so publishing again records nothing more. Returns
// how many Updates it recorded (none for a suspended or missing account), or null for a malformed list, which the
// caller refuses before anything is kept.
export function announceConvertedProfiles(db: Db, now: number): number | null {
  const row = db.first<{ value: string }>("SELECT value FROM kopje_state WHERE name = ?", PROFILE_UPDATES);
  if (row === undefined) {
    return 0;
  }
  const accountIds = parseProfileUpdates(row.value);
  if (accountIds === null) {
    return null;
  }
  db.run("DELETE FROM kopje_state WHERE name = ?", PROFILE_UPDATES);
  let recorded = 0;
  for (const accountId of accountIds) {
    if (recordActorUpdate(db, accountId, null, now)) {
      recorded++;
    }
  }
  return recorded;
}

// The serialized document before a change, for recordActorUpdate.
export function actorSnapshot(db: Db, accountId: string): string {
  return JSON.stringify(actorDocument(db, accountId));
}
