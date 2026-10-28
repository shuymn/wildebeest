import { expect } from "vitest";

import { MAX_RETRACTIONS_PER_ACTOR } from "../src/domain/inbox";
import type { StoreStub } from "../src/platform/store-client";
import { sha256Hex } from "../src/security/tokens";
import { sql } from "./api-helpers";
import { harness, NOW } from "./app-helpers";
import { fixtureKeyGen, LEGACY_EMPTY_KEK, seedLocalAccount } from "./federation-helpers";
import { completeSetup, migratedStore } from "./helpers";
import { LOCAL, MISSKEY, RemoteWeb, type SignOptions, signedInit, type TestActor } from "./inbox-helpers";

// Fixtures for inbound statuses: an app with two local accounts (alice and dave, with keys and tokens) over a synthetic
// remote web, Mastodon- and Misskey-shaped objects, and the activities about them.

export const AS = "https://www.w3.org/ns/activitystreams";
export const PUBLIC = `${AS}#Public`;
export const ALICE = "111111111111111111";
export const ALICE_URI = `${LOCAL}/ap/users/alice`;
export const DAVE = "222222222222222222";
export const DAVE_URI = `${LOCAL}/ap/users/dave`;
export const OTHER = "https://other.example";

// The account search of each endpoint that resolves an address (AccountSearchService, which both reach): its path for
// the given parameters, the accounts of its answer, and its answer when nothing is found.
export type Acct = { id: string; acct: string };
export const ACCOUNT_SEARCHES = [
  {
    name: "v2",
    path: (params: string) => `/api/v2/search?type=accounts&${params}`,
    accounts: (body: unknown) => (body as { accounts: Acct[] }).accounts,
    empty: { accounts: [], statuses: [], hashtags: [] },
  },
  {
    name: "v1",
    path: (params: string) => `/api/v1/accounts/search?${params}`,
    accounts: (body: unknown) => body as Acct[],
    empty: [],
  },
] as const;

export async function token(store: StoreStub, accountId: string): Promise<string> {
  await sql(
    store,
    `INSERT OR IGNORE INTO oauth_clients (id, secret, name, redirect_uris, scopes)
		VALUES ('test', 'secret', 'test', 'urn:ietf:wg:oauth:2.0:oob', 'read write follow')`,
  );
  const value = `token-${accountId}`;
  await sql(
    store,
    "INSERT INTO oauth_tokens (token_hash, kind, client_id, account_id, scopes) VALUES (?, 'access', 'test', ?, 'read write follow')",
    await sha256Hex(value),
    accountId,
  );
  return value;
}

// clock: the app's time (NOW unless a test moves it); requests are signed at it.
export async function setup(clock: { now: number } = { now: NOW }) {
  const store = await migratedStore();
  await completeSetup(store);
  await seedLocalAccount(store, "kopje.test", { id: ALICE, username: "alice", key: LEGACY_EMPTY_KEK });
  await seedLocalAccount(store, "kopje.test", { id: DAVE, username: "dave", key: LEGACY_EMPTY_KEK });
  const web = new RemoteWeb();
  const h = harness(store, {}, undefined, { keygen: fixtureKeyGen, loader: web.loader }, () => clock.now);
  const tokens = { alice: await token(store, ALICE), dave: await token(store, DAVE) };
  const post = async (actor: TestActor, activity: unknown, options: SignOptions & { path?: string } = {}) => {
    const path = options.path ?? "/inbox";
    return (await h.request(path, await signedInit(actor, path, activity, { at: clock.now, ...options }))).status;
  };
  const api = async <T = unknown>(path: string, as: "alice" | "dave" | null = "alice") => {
    const response = await h.request(path, as === null ? {} : { headers: { authorization: `Bearer ${tokens[as]}` } });
    return { status: response.status, body: await response.json<T>() };
  };
  return { store, web, ...h, post, api, tokens };
}

export type Setup = Awaited<ReturnType<typeof setup>>;

let sequence = 0;
export function nextId(): number {
  return ++sequence;
}

export type Note = Record<string, unknown> & { id: string; to: string[]; cc: string[] };

// A Note as Mastodon 4.x's ActivityPub::NoteSerializer renders it.
export function mastodonNote(actor: TestActor, extra: Record<string, unknown> = {}): Note {
  const n = ++sequence;
  const id = `${actor.uri}/statuses/${n}`;
  return {
    id,
    type: "Note",
    summary: null,
    inReplyTo: null,
    published: "2026-10-11T12:00:00Z",
    url: `${new URL(actor.uri).origin}/@${actor.uri.split("/").at(-1)}/${n}`,
    attributedTo: actor.uri,
    to: [PUBLIC],
    cc: [`${actor.uri}/followers`],
    sensitive: false,
    atomUri: id,
    inReplyToAtomUri: null,
    conversation: `tag:mastodon.example,2026-10-11:objectId=${n}:objectType=Conversation`,
    content: `<p>note ${n}</p>`,
    contentMap: { en: `<p>note ${n}</p>` },
    attachment: [],
    tag: [],
    replies: { id: `${id}/replies`, type: "Collection", first: { type: "CollectionPage", items: [] } },
    likes: { id: `${id}/likes`, type: "Collection", totalItems: 0 },
    shares: { id: `${id}/shares`, type: "Collection", totalItems: 0 },
    ...extra,
  } as Note;
}

// A Note as Misskey's ApRendererService#renderNote renders it: MFM source in _misskey_content and source, quotes in
// _misskey_quote, quoteUrl and quoteUri.
export function misskeyNote(actor: TestActor, extra: Record<string, unknown> = {}): Note {
  const id = `${MISSKEY}/notes/9n${++sequence}`;
  return {
    id,
    type: "Note",
    attributedTo: actor.uri,
    summary: null,
    content: "<p><span>にゃーん $[x2 big]</span></p>",
    _misskey_content: "にゃーん $[x2 big]",
    source: { content: "にゃーん $[x2 big]", mediaType: "text/x.misskeymarkdown" },
    _misskey_quote: `${MISSKEY}/notes/9quoted`,
    quoteUrl: `${MISSKEY}/notes/9quoted`,
    quoteUri: `${MISSKEY}/notes/9quoted`,
    published: "2026-10-11T12:00:00.000Z",
    to: [PUBLIC],
    cc: [`${actor.uri}/followers`],
    inReplyTo: null,
    attachment: [],
    sensitive: false,
    tag: [],
    ...extra,
  } as Note;
}

export function create(actor: TestActor, object: Note, context: unknown = AS) {
  return {
    "@context": context,
    id: `${object.id}/activity`,
    type: "Create",
    actor: actor.uri,
    published: object.published,
    to: object.to,
    cc: object.cc,
    object,
  };
}

export function update(actor: TestActor, object: Note, updated: string) {
  return {
    "@context": AS,
    id: `${object.id}#updates/${Date.parse(updated)}`,
    type: "Update",
    actor: actor.uri,
    to: object.to,
    cc: object.cc,
    object: { ...object, updated },
  };
}

export function remove(actor: TestActor, object: string) {
  return {
    "@context": AS,
    id: `${object}#delete-${++sequence}`,
    type: "Delete",
    actor: actor.uri,
    object: { id: object, type: "Tombstone", atomUri: object },
  };
}

export function announce(actor: TestActor, object: string, extra: Record<string, unknown> = {}) {
  return {
    "@context": AS,
    id: `${actor.uri}/statuses/${++sequence}/activity`,
    type: "Announce",
    actor: actor.uri,
    published: "2026-10-11T13:00:00Z",
    to: [PUBLIC],
    cc: [`${actor.uri}/followers`],
    object,
    ...extra,
  };
}

export function like(actor: TestActor, object: string, extra: Record<string, unknown> = {}) {
  return {
    "@context": AS,
    id: `${new URL(actor.uri).origin}/likes/${++sequence}`,
    type: "Like",
    actor: actor.uri,
    object,
    ...extra,
  };
}

export function undo(actor: TestActor, object: unknown) {
  return { "@context": AS, id: `${actor.uri}#undo-${++sequence}`, type: "Undo", actor: actor.uri, object };
}

export const statuses = (store: StoreStub) =>
  sql<{ uri: string; visibility: string; reblog_of_id: string | null }>(
    store,
    "SELECT uri, visibility, reblog_of_id FROM statuses ORDER BY id",
  );
export type StatusRow = {
  id: string;
  url: string | null;
  content: string;
  spoiler_text: string;
  sensitive: number;
  language: string | null;
  visibility: string;
  published_at: string;
  edited_at: string | null;
  in_reply_to_uri: string | null;
  in_reply_to_id: string | null;
  in_reply_to_account_id: string | null;
  replies_count: number;
  favourites_count: number;
  reblogs_count: number;
  raw: string;
};
export const statusRow = async (store: StoreStub, uri: string) =>
  (
    await sql<StatusRow>(
      store,
      `SELECT id, url, content, spoiler_text, sensitive, language, visibility, published_at, edited_at, in_reply_to_uri,
				in_reply_to_id, in_reply_to_account_id, replies_count, favourites_count, reblogs_count, raw
			FROM statuses WHERE uri = ?`,
      uri,
    )
  )[0];
export const notifications = (store: StoreStub) =>
  sql<{ account_id: string; type: string }>(store, "SELECT account_id, type FROM notifications ORDER BY id");
export const accountId = async (store: StoreStub, uri: string) =>
  (await sql<{ id: string }>(store, "SELECT id FROM accounts WHERE uri = ?", uri))[0]?.id;

// The remote actor is stored (by a Follow of dave) and followed by alice, so its public posts concern this instance.
export async function followed(t: Setup, actor: TestActor, follower = ALICE): Promise<string> {
  await t.post(actor, {
    "@context": AS,
    id: `${actor.uri}#follows/${++sequence}`,
    type: "Follow",
    actor: actor.uri,
    object: follower === ALICE ? DAVE_URI : ALICE_URI,
  });
  const id = (await accountId(t.store, actor.uri))!;
  await sql(
    t.store,
    "INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
    follower,
    id,
  );
  await sql(t.store, "DELETE FROM notifications");
  return id;
}

export async function localStatus(t: Setup, body: Record<string, unknown>, as: "alice" | "dave" = "alice") {
  const response = await t.request("/api/v1/statuses", {
    method: "POST",
    headers: { authorization: `Bearer ${t.tokens[as]}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return await response.json<{ id: string; uri: string }>();
}

// The actor's live retractions at MAX_RETRACTIONS_PER_ACTOR (fillers of its origin, expiring in a day).
export async function retractionsAtCap(t: Setup, actor: TestActor): Promise<void> {
  await sql(
    t.store,
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
		INSERT INTO inbound_retractions (actor_uri, target_uri, expires_at) SELECT ?, ? || '/filler/' || i, ? FROM n`,
    MAX_RETRACTIONS_PER_ACTOR,
    actor.uri,
    actor.uri,
    NOW + 24 * 60 * 60 * 1000,
  );
}
