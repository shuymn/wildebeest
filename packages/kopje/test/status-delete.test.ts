import { runInDurableObject } from "cloudflare:test";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { STAGING_READ } from "../src/domain/deliveries";
import { MAX_RETRACTIONS_PER_ACTOR } from "../src/domain/inbox";
import type { RemoteStatusInput } from "../src/domain/remote-status-reads";
import { bearer, sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { BUILD, runStoreJobs } from "./helpers";
import { LOCAL } from "./inbox-helpers";
import { storeReceive } from "./inbox-store-helpers";
import { runs } from "./policy-world";
import {
  ANY,
  type Answer,
  type Intent,
  type Lane,
  LANES,
  type Msg,
  type Obj,
  Peer,
  Policy,
  RETRACTION_TTL_MS,
  RETRY_WINDOW_MS,
  type Snapshot,
} from "./status-delete-model";
import { community, remoteAccount, seedReceipts } from "./status-helpers";

// Model-based checks of a remote author's statuses and their deletion (ID-7, ID-6, RES-6, VIS-1 and VIS-3 in
// docs/threat-model.md). Generated sequences of the author R's Create, Update and Delete (through a Mastodon v4.5.11
// sender, delivered in any order and again), L's favourites and boosts of R's status, Kopje's job rounds and its
// delivery steps run through the Store and the API; after every step the Store's projection and each answer must equal
// the policy's (test/status-delete-model.ts), and once everything has settled Kopje must hold the author's final
// state, except where an accepted risk names the messages that differ (`exception`). A second property sends what
// Mastodon would not: forgeries, stale, version-less and future Updates, the retraction cap and replays across the
// retraction TTL.

const AS = "https://www.w3.org/ns/activitystreams";
const PUBLIC = `${AS}#Public`;
const R_ORIGIN = "https://remote.example";
const R = `${R_ORIGIN}/users/r`;
const F = `${R_ORIGIN}/users/f`;
const X = "https://other.example/users/x";
const L = "https://kopje.test/ap/users/alice";
const S1 = `${R}/statuses/1`;
const S2 = `${R}/statuses/2`;
const S3 = `${R}/statuses/3`;
const POOL = [S1, S2, S3] as const;
// Fresh uris of R's origin for F's positive controls: nobody deleted them.
const FRESH = `${R_ORIGIN}/users/f/statuses/fresh`;
const PARENTS = new Map([[S2, S1]]);
const MEDIA = `${R_ORIGIN}/media/1.png`;
const LEASE_MS = 60_000;
const SETTLE_STEPS = 200;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

type Phase = "claimed" | "confirmed" | "done";
type Attempt = { token: string; delivery: string; lane: Lane; phase: Phase };
// A body Kopje confirmed, as the identity of its intent, in a lane, at a step.
type SentBody = { lane: Lane; identity: string; seq: number; id: string; body: string; step: number };

export type Stats = Record<string, number>;

const tally = (stats: Stats, key: string, n = 1) => {
  stats[key] = (stats[key] ?? 0) + n;
};

const iso = (ms: number) => new Date(ms).toISOString();

// Each lane's recipient inbox: R's server's shared inbox (R, and the receipts of L's boost), and FAN's server's.
const INBOX: Record<Lane, string> = { remote: `${R_ORIGIN}/inbox`, fans: "https://fans.example/inbox" };
// The lane of a delivery Kopje claimed, by its exact inbox, or of a deliveries row, by its lane (the inbox's origin);
// any other recipient fails the run.
const laneOf = (inbox: string): Lane => {
  const lane = LANES.find((l) => INBOX[l] === inbox || new URL(INBOX[l]).origin === inbox);
  if (lane === undefined) {
    throw new Error(`a delivery to an unexpected recipient: ${inbox}`);
  }
  return lane;
};
// A Store snapshot as the projection shows it: the media as the exact list of remote urls.
const shown = (snapshot: Snapshot) => ({ ...snapshot, media: snapshot.media ? [MEDIA] : [] });
type Shown = ReturnType<typeof shown>;

let leaseSequence = 0;

async function setup() {
  const h = await community(["alice"]);
  const store = h.store;
  const l = h.users.alice;
  const [r, f, x, fan] = [
    await remoteAccount(store, "r"),
    await remoteAccount(store, "f"),
    await remoteAccount(store, "x", "other.example"),
    await remoteAccount(store, "fan", "fans.example"),
  ];
  // L follows R, so R's public statuses concern this instance (relatedToLocal); FAN follows L, so L's boost reaches
  // fans.example and a proven Delete of a status L boosted is forwarded there.
  await sql(store, "INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')", l.id, r);
  await sql(store, "INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')", fan, l.id);
  const world = {
    h,
    store,
    l,
    accounts: { [R]: r, [F]: f, [X]: x } as Record<string, string>,
    clock: NOW,
    step: 0,
    policy: new Policy({ l: L, r: R, s1: S1, s2: S2 }, MAX_RETRACTIONS_PER_ACTOR),
    peer: new Peer(R, POOL, PARENTS),
    attempts: [] as Attempt[],
    sent: [] as SentBody[],
    // Every status id the Store has shown, with its uri (a remote status) or its symbol (one of L's boosts).
    ids: new Map<string, string>(),
    // The Like ids and the boost uris Kopje chose, by the policy's symbols, and back.
    symbolOf: new Map<string, string>(),
    // Notification ids bound to the policy's symbols, and back.
    noteSym: new Map<string, string>(),
    noteId: new Map<string, string>(),
    // Uris Kopje stored at some point, and every answer each message got.
    everStored: new Set<string>(),
    answers: new Map<string, string[]>(),
    proven: new Map<string, Record<string, unknown>>(),
    // The id each intent (by the policy's sequence) went out with, and back (activityIdentity).
    activityIds: new Map<number, string>(),
    intentOfId: new Map<string, number>(),
    trace: [] as string[],
    stats: {} as Stats,
  };
  h.now.mockImplementation(() => world.clock);
  return world;
}

type World = Awaited<ReturnType<typeof setup>>;

// ---------------------------------------------------------------------------------------------------------------
// The Store's projection, and the policy's
// ---------------------------------------------------------------------------------------------------------------

const letter = (content: string) => content.replace(/^<p>(.*)<\/p>$/, "$1") as Snapshot["content"];

async function project(w: World) {
  const raw = await runInDurableObject(w.store, (_instance, state) => {
    const q = <T extends Record<string, SqlStorageValue>>(query: string, ...params: SqlStorageValue[]) =>
      state.storage.sql.exec<T>(query, ...params).toArray();
    return {
      statuses: q<{
        id: string;
        uri: string;
        author: string;
        withdrawn: number;
        content: string;
        sensitive: number;
        version: string | null;
        edited_at: string | null;
        linked: number;
        history: string;
        media: string;
        favourites_count: number;
        reblogs_count: number;
        replies_count: number;
      }>(
        `SELECT s.id, s.uri, a.uri AS author, s.withdrawn, s.content, s.sensitive, s.remote_version AS version,
					s.edited_at, s.in_reply_to_id IS NOT NULL AS linked,
					(SELECT json_group_array(json_object('content', e.content, 'sensitive', e.sensitive, 'media', e.media_json,
						'at', e.created_at)) FROM (SELECT * FROM status_edits WHERE status_id = s.id ORDER BY id) e) AS history,
					(SELECT json_group_array(url) FROM (SELECT url FROM media_attachments
						WHERE status_id = s.id ORDER BY position, id)) AS media,
					s.favourites_count, s.reblogs_count, s.replies_count
				FROM statuses s JOIN accounts a ON a.id = s.account_id
				WHERE a.domain IS NOT NULL AND s.reblog_of_id IS NULL ORDER BY s.uri`,
      ),
      boosts: q<{ id: string; uri: string; withdrawn: number }>(
        "SELECT id, uri, withdrawn FROM statuses WHERE account_id = ? AND reblog_of_id IS NOT NULL ORDER BY id",
        w.l.id,
      ),
      favourites: q<{ uri: string | null }>("SELECT uri FROM favourites WHERE account_id = ?", w.l.id),
      retractions: q<{ actor: string; uri: string; expires: number }>(
        `SELECT actor_uri AS actor, target_uri AS uri, expires_at AS expires FROM inbound_retractions
				WHERE expires_at > ? AND target_uri NOT LIKE '%/filler/%' ORDER BY actor_uri, target_uri`,
        w.clock,
      ),
      notifications: q<{ id: string; type: string; status: string | null; from: string }>(
        `SELECT CAST(n.id AS TEXT) AS id, n.type, s.uri AS status, a.uri AS "from" FROM notifications n
				JOIN accounts a ON a.id = n.from_account_id LEFT JOIN statuses s ON s.id = n.status_id
				WHERE n.account_id = ? ORDER BY n.id`,
        w.l.id,
      ),
      jobs: q<{ key: string; done: number | null }>(
        `SELECT key, done_at AS done FROM inbound_jobs WHERE kind = 'delete' AND (done_at IS NULL OR expires_at > ?)
				ORDER BY created_at, key`,
        w.clock,
      ),
      intents: q<{
        id: number;
        type: string;
        object: string | null;
        superseded: number;
        staged: string | null;
        targets: number;
      }>(
        `SELECT o.id, json_extract(o.body, '$.activity.type') AS type, o.object_uri AS object, o.superseded, o.staged,
					(SELECT count(*) FROM outbound_targets t WHERE t.activity_id = o.id) AS targets
				FROM outbound_activities o WHERE o.account_id = ? ORDER BY o.id`,
        w.l.id,
      ),
      deliveries: q<{ id: number; lane: string; state: string; token: string | null; activity: number }>(
        "SELECT id, lane, state, lease_token AS token, activity_id AS activity FROM deliveries ORDER BY id",
      ),
    };
  });
  for (const s of raw.statuses) {
    w.ids.set(s.id, s.uri);
    w.everStored.add(s.uri);
  }
  for (const b of raw.boosts) {
    w.ids.set(b.id, w.symbolOf.get(b.uri) ?? `unbound boost ${b.uri}`);
  }
  // Each policy job is bound to its row (by the id of what it removes) the first time the Store shows it.
  for (const job of w.policy.jobs) {
    const row = raw.jobs.find((j) => w.ids.get(j.key) === job.ref && !w.policy.jobs.some((o) => o.key === j.key));
    if (job.key === null && row !== undefined) {
      job.key = row.key;
    }
  }
  const intentIdentity = new Map(raw.intents.map((i) => [i.id, identity(w, i.type, i.object)]));
  const s1 = raw.statuses.find((s) => s.uri === S1);
  return {
    statuses: raw.statuses.map((s) => ({
      uri: s.uri,
      author: s.author,
      withdrawn: s.withdrawn === 1,
      snapshot: { content: letter(s.content), sensitive: s.sensitive === 1, media: JSON.parse(s.media) as string[] },
      version: s.version,
      editedAt: s.edited_at,
      history: (JSON.parse(s.history) as { content: string; sensitive: number; media: string; at: string }[]).map(
        (e) => ({
          snapshot: {
            content: letter(e.content),
            sensitive: e.sensitive === 1,
            media: (JSON.parse(e.media) as { remote_url: string | null }[]).map((m) => m.remote_url),
          },
          at: e.at,
        }),
      ),
      linked: s.linked === 1,
    })),
    counts:
      s1 === undefined
        ? null
        : { favourites: s1.favourites_count, reblogs: s1.reblogs_count, replies: s1.replies_count },
    favourites: raw.favourites.map((f) => w.symbolOf.get(f.uri ?? "") ?? `unbound ${f.uri}`),
    boosts: raw.boosts.map((b) => ({ sym: w.symbolOf.get(b.uri) ?? `unbound ${b.uri}`, withdrawn: b.withdrawn === 1 })),
    retractions: raw.retractions,
    notifications: bindNotifications(w, raw.notifications),
    jobs: raw.jobs
      .map((j) => ({ ref: w.ids.get(j.key) ?? `unknown ${j.key}`, done: j.done }))
      .toSorted((a, b) => a.ref.localeCompare(b.ref)),
    intents: raw.intents.map((i) => ({
      identity: intentIdentity.get(i.id)!,
      superseded: i.superseded === 1,
      stage: i.targets > 0 ? "staged" : i.staged !== null ? "waiting" : "expanded",
    })),
    lanes: Object.fromEntries(
      LANES.map((lane) => [
        lane,
        raw.deliveries
          .filter((d) => laneOf(d.lane) === lane)
          .map((d) => ({
            identity: intentIdentity.get(d.activity) ?? `gone ${d.activity}`,
            state: d.state,
            token: d.token,
          })),
      ]),
    ),
  };
}

// The identity of an outbound activity: its type and the policy's symbol of what it names.
function identity(w: World, type: string, object: string | null): string {
  if (type === "Delete") {
    return `Forward ${object?.replace(/^forward /, "")}`;
  }
  const sym = w.symbolOf.get(object ?? "");
  if (sym === undefined) {
    return `${type} unbound ${object}`;
  }
  if (type === "Undo") {
    return sym.startsWith("fav") ? `UndoLike ${sym}` : `UndoAnnounce ${sym}`;
  }
  return `${type} ${sym}`;
}

// Kopje's notification ids are its own: each policy notification is bound to the first unbound row of its kind, and
// a row keeps its symbol, so a replaced notification (a new id) shows as a new symbol and one left in place does not.
function bindNotifications(w: World, rows: { id: string; type: string; status: string | null; from: string }[]) {
  for (const n of w.policy.notifications) {
    if (w.noteId.has(n.sym)) {
      continue;
    }
    const row = rows.find(
      (r) => r.type === n.type && r.status === n.status && r.from === n.from && !w.noteSym.has(r.id),
    );
    if (row !== undefined) {
      w.noteSym.set(row.id, n.sym);
      w.noteId.set(n.sym, row.id);
    }
  }
  return rows
    .map((r) => ({ sym: w.noteSym.get(r.id) ?? `unbound ${r.id}`, type: r.type, status: r.status, from: r.from }))
    .toSorted((a, b) => a.sym.localeCompare(b.sym));
}

function expected(w: World) {
  const p = w.policy;
  const s1 = p.statuses.get(S1);
  const s2 = p.statuses.get(S2);
  return {
    statuses: [...p.statuses.entries()]
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([uri, s]) => ({
        uri,
        author: s.author,
        withdrawn: s.withdrawn,
        snapshot: shown(s.snapshot),
        version: s.version,
        editedAt: s.editedAt,
        history: s.history.map((v) => ({ snapshot: shown(v.snapshot), at: v.at })),
        linked: s.linked,
      })),
    counts:
      s1 === undefined
        ? null
        : {
            favourites: p.favourite === null ? 0 : 1,
            reblogs: p.boosts.filter((b) => !b.withdrawn).length,
            replies: s2 !== undefined && s2.linked && !s2.withdrawn ? 1 : 0,
          },
    favourites: p.favourite === null ? [] : [p.favourite],
    boosts: p.boosts,
    retractions: [...p.retractions.entries()]
      .filter(([, expires]) => expires > w.clock)
      .map(([key, expires]) => {
        const [actor, uri] = key.split(" ") as [string, string];
        return { actor, uri, expires };
      })
      .toSorted((a, b) => a.actor.localeCompare(b.actor) || a.uri.localeCompare(b.uri)),
    notifications: p.notifications
      .map((n) => ({ sym: n.sym, type: n.type, status: n.status, from: n.from }))
      .toSorted((a, b) => a.sym.localeCompare(b.sym)),
    jobs: p.jobs
      .filter((j) => j.doneAt === null || j.doneAt + RETRACTION_TTL_MS > w.clock)
      .map((j) => ({ ref: j.ref, done: j.doneAt }))
      .toSorted((a, b) => a.ref.localeCompare(b.ref)),
    intents: p.intents.map((i) => ({ identity: `${i.type} ${i.ref}`, superseded: i.superseded, stage: i.stage })),
    lanes: Object.fromEntries(
      LANES.map((lane) => [
        lane,
        p.lanes.get(lane)!.map((r) => {
          const i = p.intentOf(r.intent);
          return { identity: `${i.type} ${i.ref}`, state: r.state, token: r.token };
        }),
      ]),
    ),
  };
}

async function check(w: World, answer: { actual: unknown; predicted: unknown } | null = null): Promise<void> {
  const context = w.trace.join("\n");
  if (answer !== null) {
    expect(answer.actual, context).toEqual(answer.predicted);
  }
  expect(await project(w), context).toEqual(expected(w));
}

const log = (w: World, line: string) => {
  w.step++;
  w.trace.push(`${w.step} ${line}`);
};

// ---------------------------------------------------------------------------------------------------------------
// Remote messages
// ---------------------------------------------------------------------------------------------------------------

function input(o: Obj): RemoteStatusInput {
  const author = o.attributedTo ?? R;
  return {
    uri: o.uri,
    url: null,
    attributedTo: o.attributedTo,
    content: `<p>${o.snapshot.content}</p>`,
    text: o.snapshot.content,
    spoilerText: "",
    sensitive: o.snapshot.sensitive,
    language: "en",
    published: o.published === null ? null : iso(o.published),
    updated: o.updated === null ? null : iso(o.updated),
    inReplyTo: o.inReplyTo,
    to: [PUBLIC],
    cc: [`${author}/followers`, L],
    mentions: [L],
    tags: [],
    emojiTags: [],
    media: o.snapshot.media
      ? [
          {
            type: "image",
            url: MEDIA,
            previewUrl: null,
            description: "",
            focus: null,
            width: null,
            height: null,
            blurhash: null,
          },
        ]
      : [],
    raw: "{}",
  };
}

// The Delete as the author sends it; a proven one is passed with its body, as the Worker passes it once it has
// verified the author proof (the proof and its need-proof round stay with test/forward-delete.test.ts).
function proof(actor: string, msg: Msg & { type: "Delete" }): Record<string, unknown> {
  return {
    "@context": AS,
    id: msg.id,
    type: "Delete",
    actor,
    to: [PUBLIC],
    object: { id: msg.object, type: "Tombstone" },
  };
}

function activityOf(actor: string, msg: Msg) {
  switch (msg.type) {
    case "Create":
      return { type: "Create" as const, id: msg.id, object: input(msg.object) };
    case "Update":
      return { type: "UpdateStatus" as const, id: msg.id, object: input(msg.object) };
    case "Delete":
      return msg.proven
        ? { type: "Delete" as const, id: msg.id, object: msg.object, proven: proof(actor, msg) }
        : { type: "Delete" as const, id: msg.id, object: msg.object };
  }
}

const describeMsg = (actor: string, msg: Msg) =>
  `${actor.split("/").at(-1)} ${msg.type}${msg.type === "Delete" && msg.proven ? " (proven)" : ""} ${
    msg.type === "Delete" ? msg.object : msg.object.uri
  }${msg.type === "Delete" ? "" : ` ${JSON.stringify(msg.object.snapshot)} p=${msg.object.published} u=${msg.object.updated}`}`;

async function receive(w: World, actor: string, msg: Msg, label: string): Promise<Answer> {
  log(w, `${label} ${describeMsg(actor, msg)} at +${w.clock - NOW}`);
  const result = await storeReceive(w.store, actor, activityOf(actor, msg), w.clock);
  const predicted = w.policy.receive(actor, msg, w.clock);
  const actual = {
    applied: result.applied,
    reason: result.reason,
    ...(result.retry === true ? { retry: true as const } : {}),
    ...(result.reason === "status-deleted" ? { jobsPending: result.jobsPending } : {}),
  };
  w.trace.push(`  -> ${JSON.stringify(actual)}`);
  w.answers.set(msg.id, [...(w.answers.get(msg.id) ?? []), result.reason]);
  tally(w.stats, `${msg.type} ${result.reason}`);
  await check(w, { actual, predicted });
  return predicted;
}

// ---------------------------------------------------------------------------------------------------------------
// L's API actions on s1
// ---------------------------------------------------------------------------------------------------------------

async function s1Id(w: World): Promise<string> {
  const rows = await sql<{ id: string }>(w.store, "SELECT id FROM statuses WHERE uri = ?", S1);
  // A status never stored or removed: the last id it had, else an id nothing has.
  return rows[0]?.id ?? [...w.ids].find(([, uri]) => uri === S1)?.[0] ?? "1";
}

async function bindNewest(w: World, query: string, sym: string | null): Promise<void> {
  if (sym === null) {
    return;
  }
  const uri = (await sql<{ uri: string }>(w.store, query, w.l.id))[0]?.uri;
  if (uri === undefined) {
    throw new Error(`Kopje recorded no row for ${sym}\n${w.trace.join("\n")}`);
  }
  w.symbolOf.set(uri, sym);
  w.symbolOf.set(sym, uri);
}

type LocalKind = "favourite" | "unfavourite" | "reblog" | "unreblog";

async function local(w: World, kind: LocalKind): Promise<void> {
  const id = await s1Id(w);
  log(w, `L ${kind}`);
  const status = (await w.h.request(`/api/v1/statuses/${id}/${kind}`, bearer(w.l.token, { method: "POST" }))).status;
  const p = w.policy;
  const withdrawn = p.statuses.get(S1)?.withdrawn === true;
  let predicted: number;
  switch (kind) {
    case "favourite": {
      const r = p.favouriteS1();
      predicted = r.status;
      await bindNewest(w, "SELECT uri FROM favourites WHERE account_id = ?", r.created);
      break;
    }
    case "unfavourite": {
      const had = p.favourite !== null;
      predicted = p.unfavouriteS1();
      if (had && withdrawn) {
        tally(w.stats, "unfavourite 404 with its Undo(Like)");
      }
      break;
    }
    case "reblog": {
      const r = p.reblogS1();
      predicted = r.status;
      await bindNewest(
        w,
        "SELECT uri FROM statuses WHERE account_id = ? AND reblog_of_id IS NOT NULL AND withdrawn = 0",
        r.created,
      );
      break;
    }
    case "unreblog":
      predicted = p.unreblogS1(w.clock);
      if (withdrawn && p.boosts.some((b) => !b.withdrawn)) {
        tally(w.stats, "unboost 404 while the removal runs");
      }
      break;
  }
  w.trace.push(`  -> ${status}`);
  await check(w, { actual: status, predicted });
}

// ---------------------------------------------------------------------------------------------------------------
// Kopje's work: job rounds and delivery steps
// ---------------------------------------------------------------------------------------------------------------

async function runJobs(w: World): Promise<void> {
  log(w, "jobs round");
  await runStoreJobs(w.store, BUILD, { now: w.clock });
  if (w.policy.runJobs(w.clock)) {
    tally(w.stats, "jobs round left a job for the next");
  }
  await check(w);
}

async function rowIdentity(w: World, delivery: string): Promise<string> {
  const row = (
    await sql<{ type: string; object: string | null }>(
      w.store,
      `SELECT json_extract(o.body, '$.activity.type') AS type, o.object_uri AS object
			FROM deliveries d JOIN outbound_activities o ON o.id = d.activity_id WHERE d.id = ?`,
      delivery,
    )
  )[0];
  return row === undefined ? "gone" : identity(w, row.type, row.object);
}

async function claim(w: World): Promise<Attempt[]> {
  const token = `lease-${++leaseSequence}`;
  log(w, `claim ${token} at +${w.clock - NOW}`);
  const result = await w.store.claimDeliveries(BUILD, { now: w.clock, leaseToken: token });
  const predicted = w.policy.claim(w.clock, token, LEASE_MS);
  for (const intent of predicted.dropped) {
    tally(w.stats, `claim dropped ${intent.type}`);
  }
  const claimed = await Promise.all(
    result.deliveries.map(async (d) => ({
      lane: laneOf(d.inbox),
      inbox: d.inbox,
      identity: await rowIdentity(w, d.id),
      actor: result.signers[d.signer]?.actorUri,
    })),
  );
  w.trace.push(`  -> ${JSON.stringify(claimed)}`);
  // NET-2: L's activities go to each lane's recipient inbox, signed by L.
  await check(w, {
    actual: claimed.toSorted((a, b) => a.lane.localeCompare(b.lane)),
    predicted: predicted.leased.map((l) => ({
      lane: l.lane,
      inbox: INBOX[l.lane],
      identity: `${l.intent.type} ${l.intent.ref}`,
      actor: L,
    })),
  });
  const attempts = result.deliveries.map((d) => ({
    token,
    delivery: d.id,
    lane: laneOf(d.inbox),
    phase: "claimed" as Phase,
  }));
  w.attempts.push(...attempts);
  return attempts;
}

type Body = {
  id: string;
  type: string;
  actor: string;
  object: string | { id: string; type: string; actor?: string; object?: string };
};

// The parts of a body the receiver acts on: its kind and what it names by the policy's symbols, its own id through
// activityIdentity, its actor, and the actor and status an Undo's embedded activity names; a forward as received, byte
// for byte (VIS-3, docs/mastodon-deviations.md).
function bodyShape(w: World, body: string, intent: Intent | null) {
  const json = JSON.parse(body) as Body;
  if (json.type === "Delete") {
    const object = json.object as { id: string };
    return {
      identity: `Forward ${object.id}`,
      actor: json.actor,
      exact: body === JSON.stringify(w.proven.get(json.id)),
    };
  }
  const id = activityIdentity(w, json.id, intent);
  if (json.type === "Undo" && typeof json.object !== "string") {
    const object = json.object;
    const sym = w.symbolOf.get(object.id) ?? `unbound ${object.id}`;
    return {
      identity: `Undo${object.type} ${sym}`,
      id,
      actor: json.actor,
      object: { actor: object.actor, object: object.object },
    };
  }
  const sym = w.symbolOf.get(json.id) ?? `unbound ${json.id}`;
  return { identity: `${json.type} ${sym}`, id, actor: json.actor, object: json.object };
}

// ID-7: an activity Kopje sends keeps its id across its attempts (each lane, a POST again after its lease), no two
// activities share one, and each is on L's origin (as test/follow-lifecycle.test.ts). The identity is the policy's
// intent while the id holds to that.
function activityIdentity(w: World, id: string, intent: Intent | null): string {
  if (intent === null) {
    return id;
  }
  const known = w.activityIds.get(intent.seq);
  const other = w.intentOfId.get(id);
  if (new URL(id).origin !== new URL(L).origin) {
    return `not on L's origin: ${id}`;
  }
  if (known !== undefined && known !== id) {
    return `changed from ${known} to ${id}`;
  }
  if (other !== undefined && other !== intent.seq) {
    return `${id}, already the id of intent ${other}`;
  }
  w.activityIds.set(intent.seq, id);
  w.intentOfId.set(id, intent.seq);
  return `intent ${intent.seq}`;
}

// The body the policy's intent stands for, in bodyShape's terms: each of L's reactions names s1.
function predictedShape(intent: Intent) {
  const identity = `${intent.type} ${intent.ref}`;
  switch (intent.type) {
    case "Forward":
      // A forward goes as received: the author's own Delete.
      return { identity, actor: R, exact: true };
    case "UndoLike":
    case "UndoAnnounce":
      return { identity, id: `intent ${intent.seq}`, actor: L, object: { actor: L, object: S1 } };
    case "Like":
    case "Announce":
      return { identity, id: `intent ${intent.seq}`, actor: L, object: S1 };
  }
}

async function confirm(w: World, attempt: Attempt): Promise<void> {
  log(w, `confirm ${attempt.token} ${attempt.lane}`);
  const result = await w.store.confirmDelivery(BUILD, {
    id: attempt.delivery,
    leaseToken: attempt.token,
    now: w.clock,
  });
  const predicted = w.policy.confirm(attempt.lane, attempt.token);
  w.trace.push(`  -> ${result.status}`);
  if (result.status === "send") {
    attempt.phase = "confirmed";
    const intent = predicted.status === "send" ? predicted.intent : null;
    const shape = bodyShape(w, result.body, intent);
    w.sent.push({
      lane: attempt.lane,
      identity: shape.identity,
      seq: intent?.seq ?? 0,
      id: (JSON.parse(result.body) as { id: string }).id,
      body: result.body,
      step: w.step,
    });
    await check(w, {
      actual: { status: "send", ...shape },
      predicted: intent === null ? { status: predicted.status } : { status: "send", ...predictedShape(intent) },
    });
    return;
  }
  attempt.phase = "done";
  if (result.status === "dropped") {
    tally(w.stats, "confirmation dropped an Announce whose original is gone");
  }
  await check(w, { actual: result.status, predicted: predicted.status });
}

async function complete(w: World, attempt: Attempt): Promise<void> {
  log(w, `complete ${attempt.token} ${attempt.lane}`);
  const result = await w.store.completeDelivery(BUILD, {
    id: attempt.delivery,
    leaseToken: attempt.token,
    now: w.clock,
    outcome: { kind: "delivered", status: 202 },
  });
  attempt.phase = "done";
  const predicted = w.policy.complete(attempt.lane, attempt.token);
  w.trace.push(`  -> ${result.status}`);
  await check(w, { actual: result.status, predicted });
}

const open = (w: World, phases: Phase[]) => w.attempts.filter((a) => phases.includes(a.phase));

// ---------------------------------------------------------------------------------------------------------------
// The realistic property's actions
// ---------------------------------------------------------------------------------------------------------------

type Action =
  | { k: "post"; s: number; snapshot: Snapshot }
  | { k: "edit"; s: number; snapshot: Snapshot }
  | { k: "delete"; s: number; proven: boolean }
  | { k: "deliver" | "redeliver" | "confirm" | "complete"; i: number }
  | { k: LocalKind }
  | { k: "jobs" | "claim" | "send" }
  | { k: "tick"; ms: number };

const snapshotArb: fc.Arbitrary<Snapshot> = fc.record({
  content: fc.constantFrom("A" as const, "B" as const, "C" as const),
  sensitive: fc.boolean(),
  media: fc.boolean(),
});
const A: Snapshot = { content: "A", sensitive: false, media: false };
const B: Snapshot = { content: "B", sensitive: false, media: false };
const C: Snapshot = { content: "C", sensitive: false, media: false };

const simple = <K extends string>(k: K, weight: number) => ({ arbitrary: fc.constant({ k }), weight });
const indexed = <K extends string>(k: K, weight: number) => ({
  arbitrary: fc.record({ k: fc.constant(k), i: fc.nat(5) }),
  weight,
});

// s1, which L reacts to, most often.
const statusArb = fc.constantFrom(0, 0, 0, 1, 2);

const actionArb: fc.Arbitrary<Action> = fc.oneof(
  { arbitrary: fc.record({ k: fc.constant("post" as const), s: statusArb, snapshot: snapshotArb }), weight: 2 },
  { arbitrary: fc.record({ k: fc.constant("edit" as const), s: statusArb, snapshot: snapshotArb }), weight: 4 },
  { arbitrary: fc.record({ k: fc.constant("delete" as const), s: statusArb, proven: fc.boolean() }), weight: 3 },
  indexed("deliver", 10),
  indexed("redeliver", 2),
  simple("favourite", 2),
  simple("unfavourite", 1),
  simple("reblog", 2),
  simple("unreblog", 1),
  simple("jobs", 2),
  simple("claim", 1),
  simple("send", 2),
  indexed("confirm", 1),
  indexed("complete", 1),
  {
    arbitrary: fc.record({
      k: fc.constant("tick" as const),
      ms: fc.constantFrom(MINUTE, 6 * MINUTE, 2 * HOUR, 25 * HOUR),
    }),
    weight: 2,
  },
);

async function act(w: World, a: Action): Promise<void> {
  const peer = w.peer;
  switch (a.k) {
    case "post":
      if (peer.post(POOL[a.s]!, a.snapshot, w.clock)) {
        log(w, `R posts ${POOL[a.s]} ${JSON.stringify(a.snapshot)}`);
      }
      return;
    case "edit":
      if (peer.edit(POOL[a.s]!, a.snapshot, w.clock)) {
        log(w, `R edits ${POOL[a.s]} to ${JSON.stringify(a.snapshot)}`);
      }
      return;
    case "delete":
      if (peer.delete(POOL[a.s]!, w.clock, a.proven)) {
        log(w, `R deletes ${POOL[a.s]}${a.proven ? " (proven)" : ""}`);
      }
      return;
    case "deliver":
      if (peer.outbox.length > 0) {
        const index = a.i % peer.outbox.length;
        if (index > 0) {
          tally(w.stats, "reordered delivery");
        }
        await deliverSent(w, peer.take(index).msg, "deliver");
      }
      return;
    case "redeliver": {
      // Mastodon retries a message within its retry window only.
      const retried = peer.delivered.filter((s) => w.clock - s.at <= RETRY_WINDOW_MS);
      if (retried.length > 0) {
        await deliverSent(w, retried[a.i % retried.length]!.msg, "redeliver");
      }
      return;
    }
    case "favourite":
    case "unfavourite":
    case "reblog":
    case "unreblog":
      await local(w, a.k);
      return;
    case "jobs":
      await runJobs(w);
      return;
    case "claim":
      await claim(w);
      return;
    case "send":
      for (const attempt of await claim(w)) {
        await confirm(w, attempt);
        if (attempt.phase === "confirmed") {
          await complete(w, attempt);
        }
      }
      return;
    case "confirm": {
      const attempts = open(w, ["claimed"]);
      if (attempts.length > 0) {
        await confirm(w, attempts[a.i % attempts.length]!);
      }
      return;
    }
    case "complete": {
      const attempts = open(w, ["confirmed"]);
      if (attempts.length > 0) {
        await complete(w, attempts[a.i % attempts.length]!);
      }
      return;
    }
    case "tick":
      // Mastodon retries a message for about 3.1 days at most: no undelivered one is held longer.
      if (peer.oldest(w.clock + a.ms) <= RETRY_WINDOW_MS) {
        w.clock += a.ms;
        log(w, `tick ${a.ms}`);
      }
      return;
  }
}

async function deliverSent(w: World, msg: Msg, label: string): Promise<void> {
  const s1 = w.policy.statuses.get(S1);
  const before = msg.type === "Delete" && msg.object === S1 && s1 !== undefined && !s1.withdrawn;
  const keptBoost = w.policy.boosts.some((b) => !b.withdrawn);
  if (msg.type === "Delete" && msg.proven) {
    w.proven.set(msg.id, proof(R, msg));
  }
  if (msg.type === "Update" && !w.everStored.has(msg.object.uri)) {
    tally(w.stats, "Update before its Create");
  }
  if (msg.type === "Delete" && !w.everStored.has(msg.object)) {
    tally(w.stats, "Delete before Create");
  }
  await receive(w, R, msg, label);
  if (before && msg.proven && keptBoost) {
    tally(w.stats, "proven Delete forwarded through a kept boost");
  }
}

// Finishes every open attempt, then runs job rounds and delivery rounds until nothing is left for Kopje to do.
async function settleKopje(w: World): Promise<void> {
  for (let round = 0; round < SETTLE_STEPS; round++) {
    for (const attempt of open(w, ["claimed", "confirmed"])) {
      if (attempt.phase === "claimed") {
        await confirm(w, attempt);
      }
      if (attempt.phase === "confirmed") {
        await complete(w, attempt);
      }
    }
    if (w.policy.quiet()) {
      const state = await project(w);
      expect(Object.values(state.lanes).flat(), w.trace.join("\n")).toEqual([]);
      expect(
        state.intents.filter((i) => i.stage !== "expanded"),
        w.trace.join("\n"),
      ).toEqual([]);
      return;
    }
    if (w.policy.jobs.some((j) => j.doneAt === null)) {
      await runJobs(w);
    }
    await claim(w);
  }
  throw new Error(`settlement did not finish in ${SETTLE_STEPS} rounds\n${w.trace.join("\n")}`);
}

// ---------------------------------------------------------------------------------------------------------------
// Quiescence: Kopje against the author
// ---------------------------------------------------------------------------------------------------------------

// The accepted risk of an Update that reaches Kopje before its Create, more than 24 hours after publication
// (Mastodon parity: update.rb:34 drops it through object_too_old?): Kopje dropped it as `unknown-object` and stored the
// earlier version the Create carried. Allowed only for that status, while every newer version of it was answered
// `unknown-object` each time it arrived, and the version Kopje holds is one the author sent.
function updateBeforeCreate(w: World, uri: string, held: { snapshot: Shown; version: string | null }): boolean {
  const versions = w.peer.sent.filter((s) => s.msg.type !== "Delete" && s.msg.object.uri === uri);
  const mine = versions.find(
    (s) =>
      s.msg.type !== "Delete" &&
      iso(s.msg.object.updated ?? s.msg.object.published!) === held.version &&
      JSON.stringify(shown(s.msg.object.snapshot)) === JSON.stringify(held.snapshot),
  );
  if (mine === undefined) {
    return false;
  }
  const newer = versions.filter((s) => s.at > mine.at);
  return (
    newer.length > 0 &&
    newer.every((s) => {
      const answers = w.answers.get(s.msg.id) ?? [];
      return answers.length > 0 && answers.every((a) => a === "unknown-object");
    })
  );
}

async function quiescence(w: World): Promise<void> {
  const state = await project(w);
  const context = w.trace.join("\n");
  const live = (actor: string, uri: string) => state.retractions.some((r) => r.actor === actor && r.uri === uri);
  for (const uri of POOL) {
    const status = w.peer.statuses.get(uri)!;
    const held = state.statuses.find((s) => s.uri === uri);
    if (status.state === "deleted") {
      // Each deleted status is gone and stays retracted; `*` too once it had been stored.
      expect({ uri, held: held ?? null, own: live(R, uri), any: live(ANY, uri) }, context).toEqual({
        uri,
        held: null,
        own: true,
        any: w.everStored.has(uri),
      });
      continue;
    }
    const final = w.peer.final(uri);
    const mine =
      held === undefined
        ? null
        : { author: held.author, withdrawn: held.withdrawn, snapshot: held.snapshot, version: held.version };
    const theirs =
      final === null ? null : { author: R, withdrawn: false, snapshot: shown(final.snapshot), version: final.version };
    if (mine !== null && JSON.stringify(mine) !== JSON.stringify(theirs) && updateBeforeCreate(w, uri, mine)) {
      // Only the version differs: the status is still R's, and shown.
      expect({ uri, author: mine.author, withdrawn: mine.withdrawn }, context).toEqual({
        uri,
        author: R,
        withdrawn: false,
      });
      tally(w.stats, "exception update-before-create");
      continue;
    }
    expect({ uri, status: mine }, context).toEqual({ uri, status: theirs });
  }
  // The forward and the Undo(Announce) of each boost kept when the proven Delete was accepted: one activity id each per
  // lane, the forward first, byte for byte the same in every lane (docs/mastodon-deviations.md:669-670).
  const forwards = w.sent.filter((s) => s.identity.startsWith("Forward "));
  if (w.policy.keptAtForward.length > 0) {
    for (const lane of LANES) {
      const inLane = w.sent.filter((s) => s.lane === lane);
      const forward = inLane.findIndex((s) => s.identity === `Forward ${S1}`);
      expect(forward, context).toBeGreaterThanOrEqual(0);
      for (const boost of w.policy.keptAtForward) {
        const undos = inLane.filter((s) => s.identity === `UndoAnnounce ${boost}`);
        expect(new Set(undos.map((u) => u.id)).size, context).toBe(1);
        expect(inLane.indexOf(undos[0]!), context).toBeGreaterThan(forward);
      }
    }
    expect(new Set(forwards.map((f) => f.body)).size, context).toBe(1);
  } else {
    expect(forwards, context).toEqual([]);
  }
  // Decision (d): every Like sent stays sent; one Undo(Like) per favourite an explicit unfavourite removed, none other.
  const undoLikes = new Map<string, Set<string>>();
  for (const s of w.sent.filter((s) => s.identity.startsWith("UndoLike "))) {
    const sym = s.identity.slice("UndoLike ".length);
    undoLikes.set(sym, (undoLikes.get(sym) ?? new Set()).add(s.id));
  }
  const byName = (a: [string, number], b: [string, number]) => a[0].localeCompare(b[0]);
  expect([...undoLikes].map(([sym, ids]): [string, number] => [sym, ids.size]).toSorted(byName), context).toEqual(
    w.policy.unliked.map((sym): [string, number] => [sym, 1]).toSorted(byName),
  );
}

async function run(actions: readonly Action[], order: readonly number[] = []): Promise<World> {
  const w = await setup();
  await check(w);
  for (const a of actions) {
    await act(w, a);
  }
  w.trace.push("-- settle");
  // Every message the author sent is delivered at least once, in a generated order.
  for (let k = 0; w.peer.outbox.length > 0; k++) {
    await deliverSent(w, w.peer.take((order[k] ?? 0) % w.peer.outbox.length).msg, "deliver");
  }
  await settleKopje(w);
  await quiescence(w);
  return w;
}

const STATS: Stats = {};
const merge = (stats: Stats) => {
  for (const [key, n] of Object.entries(stats)) {
    tally(STATS, key, n);
  }
};

const CASES = 30;
const SEED = 1411;

describe("status deletes: Kopje against its policy and a Mastodon author", () => {
  it("agrees with the policy after every step and with the author once settled", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        fc.array(actionArb, { minLength: 12, maxLength: 20 }),
        fc.array(fc.nat(7), { maxLength: 12 }),
        async (boosted, actions, order) => {
          // R's s1 reaches Kopje first, and L may have boosted it: the start most of the transitions need.
          const start: Action[] = [
            { k: "post", s: 0, snapshot: A },
            { k: "deliver", i: 0 },
            ...(boosted ? [{ k: "reblog" } as const] : []),
          ];
          merge((await run([...start, ...actions], order)).stats);
        },
      ),
      runs(CASES, SEED),
    );
    console.log("status delete coverage", JSON.stringify(STATS, null, 1));
  }, 600_000);
});

// ---------------------------------------------------------------------------------------------------------------
// What Mastodon would not send (policy only): forgeries by F (same origin) and X (another origin), stale, version-less
// and future Updates, Updates of unknown statuses, the retraction cap, and replays across the retraction TTL, checked
// after every step.
// ---------------------------------------------------------------------------------------------------------------

const ACTORS = [R, F, X] as const;

type InAction =
  | {
      k: "in";
      actor: number;
      type: "Create" | "Update" | "Delete";
      s: number;
      // attributedTo: the actor itself, or R.
      own: boolean;
      snapshot: Snapshot;
      // Offsets from the clock (null: the field is absent).
      published: number | null;
      updated: number | null;
      proven: boolean;
    }
  | { k: "replay"; i: number }
  | { k: "tick"; ms: number };

const inArb: fc.Arbitrary<InAction> = fc.oneof(
  {
    arbitrary: fc.record({
      k: fc.constant("in" as const),
      actor: fc.constantFrom(0, 0, 0, 1, 1, 2),
      type: fc.constantFrom("Create" as const, "Update" as const, "Update" as const, "Delete" as const),
      s: fc.constantFrom(0, 0, 1, 2),
      own: fc.boolean(),
      snapshot: snapshotArb,
      published: fc.constantFrom(0, -MINUTE, -2 * HOUR, -DAY, -25 * HOUR, null),
      updated: fc.constantFrom(null, -10 * MINUTE, -MINUTE, 0, MINUTE, 6 * MINUTE, 10 * MINUTE),
      proven: fc.boolean(),
    }),
    weight: 8,
  },
  { arbitrary: fc.record({ k: fc.constant("replay" as const), i: fc.nat(7) }), weight: 2 },
  {
    arbitrary: fc.record({
      k: fc.constant("tick" as const),
      ms: fc.constantFrom(MINUTE, 6 * MINUTE, 2 * HOUR, 25 * HOUR, 30 * DAY, 31 * DAY),
    }),
    weight: 2,
  },
);

let inSequence = 0;

function inMessage(w: World, a: InAction & { k: "in" }): { actor: string; msg: Msg } {
  const actor = ACTORS[a.actor]!;
  const uri = POOL[a.s]!;
  const id = `${new URL(actor).origin}/activities/${++inSequence}`;
  if (a.type === "Delete") {
    return { actor, msg: { type: "Delete", id, object: uri, proven: a.proven } };
  }
  const object: Obj = {
    uri,
    attributedTo: a.own ? actor : R,
    snapshot: a.snapshot,
    published: a.published === null ? null : w.clock + a.published,
    updated: a.updated === null ? null : w.clock + a.updated,
    inReplyTo: PARENTS.get(uri) ?? null,
  };
  return { actor, msg: { type: a.type, id, object } };
}

async function inbound(w: World, a: InAction, received: { actor: string; msg: Msg }[]): Promise<void> {
  switch (a.k) {
    case "in": {
      const m = inMessage(w, a);
      if (m.msg.type === "Delete" && m.msg.proven) {
        w.proven.set(m.msg.id, proof(m.actor, m.msg));
      }
      received.push(m);
      await receive(w, m.actor, m.msg, "receive");
      return;
    }
    case "replay":
      if (received.length > 0) {
        const m = received[a.i % received.length]!;
        await receive(w, m.actor, m.msg, "replay");
      }
      return;
    case "tick":
      w.clock += a.ms;
      log(w, `tick ${a.ms}`);
      await check(w);
      return;
  }
}

// R's live retractions short of the cap by `k`, fillers of its origin expiring at `expires` (as retractionsAtCap in
// test/inbox-status-helpers.ts).
async function seedCap(w: World, k: number, expires: number): Promise<void> {
  const count = MAX_RETRACTIONS_PER_ACTOR - k;
  await sql(
    w.store,
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
		INSERT INTO inbound_retractions (actor_uri, target_uri, expires_at) SELECT ?, ? || '/filler/' || i, ? FROM n`,
    count,
    R,
    R,
    expires,
  );
  w.policy.fillers = { count, expires };
}

async function inRun(actions: readonly InAction[], cap: { k: number; expires: number } | null = null): Promise<World> {
  const w = await setup();
  if (cap !== null) {
    await seedCap(w, cap.k, NOW + cap.expires);
  }
  await check(w);
  const received: { actor: string; msg: Msg }[] = [];
  for (const a of actions) {
    await inbound(w, a, received);
  }
  return w;
}

const IN_CASES = 40;

describe("status deletes: what Mastodon would not send, against the policy", () => {
  it("agrees with the policy after every activity, forgeries, stale versions, the cap and the TTL included", async () => {
    const stats: Stats = {};
    await fc.assert(
      fc.asyncProperty(
        fc.option(fc.record({ k: fc.nat(2), expires: fc.constantFrom(HOUR, 3 * DAY, 31 * DAY) }), { freq: 3 }),
        fc.array(inArb, { minLength: 10, maxLength: 16 }),
        async (cap, actions) => {
          const w = await inRun(actions, cap);
          for (const [key, n] of Object.entries(w.stats)) {
            tally(stats, key, n);
          }
        },
      ),
      runs(IN_CASES, SEED),
    );
    console.log("status delete inbound coverage", JSON.stringify(stats, null, 1));
  }, 300_000);
});

// ---------------------------------------------------------------------------------------------------------------
// Deterministic witnesses: each transition the properties count, each accepted divergence and each boundary, through
// the same harness (every step checked against the policy, and a realistic run's settled state against the author).
// ---------------------------------------------------------------------------------------------------------------

const deliver = (i = 0) => ({ k: "deliver", i }) as const;
const at = (i: number) => ({ i });
const answersOf = (w: World, type: Msg["type"], uri: string) =>
  w.peer.sent
    .filter((s) => s.msg.type === type && (s.msg.type === "Delete" ? s.msg.object : s.msg.object.uri) === uri)
    .flatMap((s) => w.answers.get(s.msg.id) ?? []);

describe("status deletes: the author's orders", () => {
  it("a Delete before its Create keeps the status from appearing", async () => {
    const w = await run([
      { k: "post", s: 2, snapshot: A },
      { k: "delete", s: 2, proven: false },
      deliver(1),
      deliver(0),
    ]);
    expect(answersOf(w, "Delete", S3)).toEqual(["retraction-recorded"]);
    expect(answersOf(w, "Create", S3)).toEqual(["retracted"]);
  });

  it("an Update before its Create, within 24 hours, creates the status", async () => {
    const w = await run([{ k: "post", s: 2, snapshot: A }, { k: "edit", s: 2, snapshot: B }, deliver(1), deliver(0)]);
    expect(answersOf(w, "Update", S3)).toEqual(["created"]);
    expect(answersOf(w, "Create", S3)).toEqual(["duplicate"]);
  });

  // Exception 1, Mastodon parity (update.rb:34, OBJECT_AGE_THRESHOLD = 1.day): the Update is dropped and the Create
  // that follows stores the earlier version, until the next edit.
  it("an Update before its Create, past 24 hours, leaves the earlier version (an accepted risk)", async () => {
    const w = await run([
      { k: "post", s: 2, snapshot: A },
      { k: "tick", ms: 25 * HOUR },
      { k: "edit", s: 2, snapshot: B },
      deliver(1),
      deliver(0),
    ]);
    expect(answersOf(w, "Update", S3)).toEqual(["unknown-object"]);
    expect(w.stats["exception update-before-create"]).toBe(1);
    expect((await project(w)).statuses.find((s) => s.uri === S3)?.snapshot).toEqual(shown(A));
    // A later edit retires it.
    const later = await run([
      { k: "post", s: 2, snapshot: A },
      { k: "tick", ms: 25 * HOUR },
      { k: "edit", s: 2, snapshot: B },
      deliver(1),
      deliver(0),
      { k: "edit", s: 2, snapshot: C },
    ]);
    expect(later.stats["exception update-before-create"]).toBeUndefined();
  });

  // Decision (c): Kopje's watermark moves on every accepted Update, so the obsolete B, older than the final A, is
  // ignored. Mastodon's edited_at moves only on a significant change (process_status_update_service.rb:179,394-396),
  // so the final A, no change against A, leaves it, and B then applies there.
  it("the author's A, B, A with the final A delivered before B", async () => {
    const w = await run([
      { k: "post", s: 0, snapshot: A },
      deliver(),
      { k: "edit", s: 0, snapshot: B },
      { k: "edit", s: 0, snapshot: A },
      deliver(1),
      deliver(0),
    ]);
    expect(answersOf(w, "Update", S1)).toEqual(["updated", "stale"].toReversed());
    expect((await project(w)).statuses.find((s) => s.uri === S1)?.snapshot).toEqual(shown(A));
  });

  it("a metadata Update, then an older content Update", async () => {
    const w = await run([
      { k: "post", s: 0, snapshot: A },
      deliver(),
      { k: "edit", s: 0, snapshot: B },
      { k: "edit", s: 0, snapshot: { ...A, sensitive: true } },
      deliver(1),
      deliver(0),
    ]);
    expect(answersOf(w, "Update", S1)).toEqual(["stale", "updated"]);
  });

  it("a replay after a Delete, while the removal runs and after it", async () => {
    const w = await run([
      { k: "post", s: 0, snapshot: A },
      deliver(),
      { k: "reblog" },
      { k: "edit", s: 0, snapshot: B },
      deliver(),
      { k: "delete", s: 0, proven: true },
      deliver(),
      { k: "redeliver", ...at(0) },
      { k: "redeliver", ...at(1) },
      { k: "jobs" },
      { k: "redeliver", ...at(0) },
      { k: "redeliver", ...at(1) },
    ]);
    expect(answersOf(w, "Create", S1)).toEqual(["created", "retracted", "retracted"]);
    expect(answersOf(w, "Update", S1)).toEqual(["edited", "retracted", "retracted"]);
  });

  it("boost, unboost, boost again, then a proven Delete: the forward, then each Undo once", async () => {
    const w = await run([
      { k: "post", s: 0, snapshot: A },
      deliver(),
      { k: "reblog" },
      { k: "send" },
      { k: "unreblog" },
      { k: "reblog" },
      { k: "delete", s: 0, proven: true },
      deliver(),
    ]);
    expect(w.policy.keptAtForward).toHaveLength(1);
    expect(w.stats["proven Delete forwarded through a kept boost"]).toBe(1);
    // Two boost generations, each withdrawn with one Undo in each lane.
    const undos = w.sent.filter((s) => s.identity.startsWith("UndoAnnounce "));
    expect(new Set(undos.map((u) => u.id)).size).toBe(2);
    expect(undos).toHaveLength(4);
  });

  it("an Announce claimed before its original's removal is dropped at its confirmation", async () => {
    const w = await run([
      { k: "post", s: 0, snapshot: A },
      deliver(),
      { k: "reblog" },
      { k: "claim" },
      { k: "delete", s: 0, proven: false },
      deliver(),
      { k: "confirm", ...at(0) },
    ]);
    // One in each lane: the second at settlement.
    expect(w.stats["confirmation dropped an Announce whose original is gone"]).toBe(2);
    expect(w.sent.filter((s) => s.identity.startsWith("Announce "))).toEqual([]);
  });

  it("an unboost answers 404 while the removal runs; an unfavourite answers 404 and still sends its Undo(Like)", async () => {
    const w = await run([
      { k: "post", s: 0, snapshot: A },
      deliver(),
      { k: "reblog" },
      { k: "favourite" },
      { k: "send" },
      { k: "send" },
      { k: "delete", s: 0, proven: true },
      deliver(),
      { k: "unreblog" },
      { k: "unfavourite" },
    ]);
    expect(w.stats["unboost 404 while the removal runs"]).toBe(1);
    expect(w.stats["unfavourite 404 with its Undo(Like)"]).toBe(1);
    expect(w.sent.filter((s) => s.identity.startsWith("UndoLike "))).toHaveLength(1);
    // The Like sent before stays sent (decision d): no Undo(Like) follows the Delete by itself.
    expect(w.sent.filter((s) => s.identity.startsWith("Like "))).toHaveLength(1);
  });

  it("a removal never sends an Undo(Like) of its own", async () => {
    const w = await run([
      { k: "post", s: 0, snapshot: A },
      deliver(),
      { k: "favourite" },
      { k: "send" },
      { k: "delete", s: 0, proven: false },
      deliver(),
    ]);
    expect(w.sent.map((s) => s.identity.split(" ")[0])).toEqual(["Like"]);
  });

  it("a forward followed by its Undo(Announce), in each lane", async () => {
    const w = await run([
      { k: "post", s: 0, snapshot: A },
      deliver(),
      { k: "reblog" },
      { k: "send" },
      { k: "delete", s: 0, proven: true },
      deliver(),
    ]);
    for (const lane of LANES) {
      expect(w.sent.filter((s) => s.lane === lane).map((s) => s.identity.split(" ")[0])).toEqual([
        "Announce",
        "Forward",
        "UndoAnnounce",
      ]);
    }
  });

  // RES-6: a job round runs at most JOB_BATCHES_PER_ROUND batches. Five unboosts' jobs take two rounds; after the first
  // the policy and the Store agree on the job left (the step's check), and settlement finishes it.
  it("five unboosts' jobs take two rounds", async () => {
    const cycles = Array.from({ length: 5 }, () => [{ k: "reblog" }, { k: "unreblog" }] as const).flat();
    const w = await run([{ k: "post", s: 0, snapshot: A }, deliver(), ...cycles, { k: "jobs" }]);
    expect(w.stats["jobs round left a job for the next"]).toBe(1);
    expect(w.policy.jobs.map((j) => j.doneAt !== null)).toEqual(Array.from({ length: 5 }, () => true));
  });
});

// The checker's own sensitivity: bodies Kopje did not send, which the confirmation's check must reject.
describe("status deletes: the body check", () => {
  it("rejects an Undo(Like) that names another status, or reuses an earlier generation's id", async () => {
    const w = await run([
      { k: "post", s: 0, snapshot: A },
      deliver(),
      { k: "favourite" },
      { k: "send" },
      { k: "unfavourite" },
      { k: "send" },
      { k: "favourite" },
      { k: "send" },
      { k: "unfavourite" },
      { k: "send" },
    ]);
    const undos = w.sent.filter((s) => s.identity.startsWith("UndoLike "));
    expect(undos).toHaveLength(2);
    const [first, second] = undos as [SentBody, SentBody];
    const intent: Intent = {
      seq: second.seq,
      type: "UndoLike",
      ref: second.identity.slice("UndoLike ".length),
      superseded: false,
      stage: "expanded",
    };
    // The body Kopje sent passes.
    expect(bodyShape(w, second.body, intent)).toEqual(predictedShape(intent));
    // Its embedded Like names s2 instead of s1.
    const json = JSON.parse(second.body) as { id: string; object: { object: string } };
    const elsewhere = bodyShape(w, JSON.stringify({ ...json, object: { ...json.object, object: S2 } }), intent);
    expect(elsewhere).not.toEqual(predictedShape(intent));
    expect(elsewhere).toMatchObject({ object: { actor: L, object: S2 } });
    // The second generation's Undo with the first's id, as its first confirmation would see it.
    w.activityIds.delete(second.seq);
    w.intentOfId.delete(second.id);
    const reused = bodyShape(w, JSON.stringify({ ...json, id: first.id }), intent);
    expect(reused).not.toEqual(predictedShape(intent));
    expect(reused).toMatchObject({ id: `${first.id}, already the id of intent ${first.seq}` });
  });
});

// A step through the inbound harness, by actor.
const inbox = (
  actor: number,
  type: "Create" | "Update" | "Delete",
  s: number,
  extra: Partial<InAction & { k: "in" }> = {},
): InAction => ({
  k: "in",
  actor,
  type,
  s,
  own: true,
  snapshot: A,
  published: 0,
  updated: null,
  proven: false,
  ...extra,
});
const tick = (ms: number): InAction => ({ k: "tick", ms });
const reasons = (w: World) =>
  w.trace.filter((l) => l.startsWith("  -> ")).map((l) => (JSON.parse(l.slice(5)) as Answer).reason);
const lastAnswer = (w: World) => w.trace.findLast((line) => line.startsWith("  -> "))?.slice(5);

describe("status deletes: forgeries and the retraction's scope", () => {
  it("a forged Delete by F (same origin) or X (another origin) changes nothing", async () => {
    const w = await inRun([inbox(0, "Create", 0), inbox(1, "Delete", 0), inbox(2, "Delete", 0)]);
    expect(reasons(w)).toEqual(["created", "not-author", "foreign-object"]);
    expect((await project(w)).retractions).toEqual([]);
  });

  // ID-7, ID-6: a stored status R deleted is created again by nobody (`*`), while R's Delete of a uri never seen
  // here is R's own (deviation 3: Mastodon's Tombstone of it refuses every account, create.rb:438).
  it("F's Create of R's deleted uri is refused; of R's unknown-deleted uri it is taken", async () => {
    const w = await inRun([
      inbox(0, "Create", 0),
      inbox(0, "Delete", 0),
      inbox(1, "Create", 0),
      inbox(0, "Delete", 2),
      inbox(1, "Create", 2),
    ]);
    expect(reasons(w)).toEqual(["created", "status-deleted", "retracted", "retraction-recorded", "created"]);
    expect((await project(w)).statuses.map((s) => [s.uri, s.author])).toEqual([[S3, F]]);
  });

  // The positive control of the wildcard: F's valid Create of a uri nobody deleted is taken.
  it("F's Create of a fresh uri of its origin is created", async () => {
    const w = await setup();
    const msg: Msg = {
      type: "Create",
      id: `${FRESH}/activity`,
      object: { uri: FRESH, attributedTo: F, snapshot: A, published: NOW, updated: null, inReplyTo: null },
    };
    expect((await receive(w, F, msg, "receive")).reason).toBe("created");
  });
});

describe("status deletes: the cap and the TTL", () => {
  it("a Delete at the cap: 503 for a stored status, nothing written; ignored for an unknown one", async () => {
    const w = await inRun([inbox(0, "Create", 0), inbox(0, "Delete", 0), inbox(0, "Delete", 2)], {
      k: 0,
      expires: DAY,
    });
    expect(w.stats["Delete retraction-cap"]).toBe(2);
    expect(w.trace).toContain('  -> {"applied":false,"reason":"retraction-cap","retry":true}');
    const state = await project(w);
    expect(state.statuses.map((s) => s.uri)).toEqual([S1]);
    expect(state.retractions).toEqual([]);
  });

  // Deviation 2: the retraction lasts 30 days (decision b); Mastodon's Tombstone never expires by age.
  it("a Create replayed after the TTL is created again", async () => {
    const w = await inRun([inbox(0, "Create", 0), inbox(0, "Delete", 0), tick(31 * DAY), { k: "replay", i: 0 }]);
    expect(lastAnswer(w)).toBe('{"applied":true,"reason":"created"}');
  });

  // Decision (a): a Delete delivered again after the removal finds no row and renews only R's own retraction.
  it("a redelivered Delete after the removal leaves `*` its earlier deadline", async () => {
    const w = await inRun([inbox(0, "Create", 0), inbox(0, "Delete", 0), tick(2 * HOUR), { k: "replay", i: 1 }]);
    expect(lastAnswer(w)).toBe('{"applied":true,"reason":"retraction-recorded"}');
    expect((await project(w)).retractions).toEqual([
      { actor: ANY, uri: S1, expires: NOW + RETRACTION_TTL_MS },
      { actor: R, uri: S1, expires: NOW + 2 * HOUR + RETRACTION_TTL_MS },
    ]);
  });

  it("a retraction holds at expires_at - 1 and lapses at expires_at", async () => {
    const w = await inRun([
      inbox(0, "Delete", 2),
      tick(RETRACTION_TTL_MS - 1),
      inbox(0, "Create", 2, { published: -DAY }),
    ]);
    expect(lastAnswer(w)).toBe('{"applied":false,"reason":"retracted"}');
    const v = await inRun([inbox(0, "Delete", 2), tick(RETRACTION_TTL_MS), inbox(0, "Create", 2, { published: -DAY })]);
    expect(lastAnswer(v)).toBe('{"applied":true,"reason":"created"}');
  });

  it("an Update exactly 5 minutes ahead applies; one millisecond more is ignored", async () => {
    const w = await inRun([inbox(0, "Create", 0), inbox(0, "Update", 0, { snapshot: B, updated: 5 * MINUTE + 1 })]);
    expect(lastAnswer(w)).toBe('{"applied":false,"reason":"future"}');
    const v = await inRun([inbox(0, "Create", 0), inbox(0, "Update", 0, { snapshot: B, updated: 5 * MINUTE })]);
    expect(lastAnswer(v)).toBe('{"applied":true,"reason":"edited"}');
  });

  it("an Update of an unknown status published exactly 24 hours ago creates it; one millisecond older does not", async () => {
    const w = await inRun([inbox(0, "Update", 2, { published: -DAY, updated: 0 })]);
    expect(lastAnswer(w)).toBe('{"applied":true,"reason":"created"}');
    const v = await inRun([inbox(0, "Update", 2, { published: -DAY - 1, updated: 0 })]);
    expect(lastAnswer(v)).toBe('{"applied":false,"reason":"unknown-object"}');
  });

  it("an Update that names no version, or an older one, changes nothing", async () => {
    const w = await inRun([
      inbox(0, "Create", 0),
      inbox(0, "Update", 0, { snapshot: B, updated: null }),
      inbox(0, "Update", 0, { snapshot: B, updated: -MINUTE }),
    ]);
    expect(w.stats["Update stale"]).toBe(2);
  });

  // RES-6 (D2): the retraction lapses while the removal still runs. A late Update rewrites the hidden row (checked
  // against the policy). The removal's first round takes L's mention while the row stays (the receipts of L's boost
  // hold it past the round), so a late Create to L's personal inbox gives the mention back as a silent one
  // (`audience-extended`); the row stays withdrawn, L still cannot see it (VIS-1), and the cleanup then leaves no row.
  it("a retraction that lapses while the removal runs", async () => {
    const w = await setup();
    for (const a of [{ k: "post", s: 0, snapshot: A }, deliver(), { k: "reblog" }] as const) {
      await act(w, a);
    }
    const id = await s1Id(w);
    // Receipts are not in the projection: the policy still holds.
    const boost = (await sql<{ id: string }>(w.store, "SELECT id FROM statuses WHERE reblog_of_id = ?", id))[0]!;
    await seedReceipts(w.store, boost.id, w.l.id, 4 * STAGING_READ, NOW);
    for (const a of [{ k: "delete", s: 0, proven: true }, deliver(), { k: "tick", ms: RETRACTION_TTL_MS }] as const) {
      await act(w, a);
    }
    expect(w.policy.jobs.filter((j) => j.doneAt === null)).toHaveLength(1);
    await receive(
      w,
      R,
      {
        type: "Update",
        id: `${S1}#late`,
        object: { uri: S1, attributedTo: R, snapshot: B, published: NOW, updated: w.clock, inReplyTo: null },
      },
      "late",
    );
    expect(lastAnswer(w)).toBe('{"applied":true,"reason":"edited"}');
    const mention = () =>
      sql(w.store, "SELECT silent FROM status_mentions WHERE status_id = ? AND account_id = ?", id, w.l.id);
    const withdrawn = () => sql(w.store, "SELECT withdrawn FROM statuses WHERE id = ?", id);
    expect(await mention()).toEqual([{ silent: 0 }]);
    // From here the Store runs alone: the policy finishes a removal in one batch.
    expect((await runStoreJobs(w.store, BUILD, { now: w.clock })).pending).toBe(true);
    expect(await mention()).toEqual([]);
    expect(await withdrawn()).toEqual([{ withdrawn: 1 }]);
    const result = await w.store.receiveActivity(BUILD, {
      now: w.clock,
      origin: LOCAL,
      actorUri: R,
      actor: null,
      actorRevision: null,
      activity: activityOf(R, w.peer.sent[0]!.msg),
      recipient: "alice",
    });
    expect({ applied: result.applied, reason: result.reason }).toEqual({ applied: true, reason: "audience-extended" });
    expect(await mention()).toEqual([{ silent: 1 }]);
    expect(await withdrawn()).toEqual([{ withdrawn: 1 }]);
    expect((await w.h.request(`/api/v1/statuses/${id}`, bearer(w.l.token))).status).toBe(404);
    for (let round = 0; round < 100; round++) {
      if (!(await runStoreJobs(w.store, BUILD, { now: w.clock })).pending) {
        break;
      }
    }
    expect(await sql(w.store, "SELECT 1 FROM statuses WHERE uri = ?", S1)).toEqual([]);
  }, 120_000);
});

// Every delivery Kopje has, claimed, confirmed and completed until none is left: the ids of the bodies it sent.
async function deliverAll(w: World, prefix: string): Promise<string[]> {
  const sent: string[] = [];
  for (let round = 0; round < 200; round++) {
    const token = `${prefix}-${round}`;
    const claimed = await w.store.claimDeliveries(BUILD, { now: w.clock, leaseToken: token });
    for (const d of claimed.deliveries) {
      const confirmation = await w.store.confirmDelivery(BUILD, { id: d.id, leaseToken: token, now: w.clock });
      if (confirmation.status === "send") {
        sent.push((JSON.parse(confirmation.body) as { id: string }).id);
        await w.store.completeDelivery(BUILD, {
          id: d.id,
          leaseToken: token,
          now: w.clock,
          outcome: { kind: "delivered", status: 202 },
        });
      }
    }
    if ((await sql(w.store, "SELECT 1 FROM deliveries UNION ALL SELECT 1 FROM outbound_targets")).length === 0) {
      return sent;
    }
  }
  throw new Error("deliveries left after 200 rounds");
}

// R's s1 stored, L's boost of it with receipts beyond the staging budget (STAGING_READ): the boost's row.
async function boostedWithReceipts(w: World): Promise<{ original: string; boost: { id: string; uri: string } }> {
  const create: Msg = {
    type: "Create",
    id: `${S1}/activity`,
    object: { uri: S1, attributedTo: R, snapshot: A, published: NOW, updated: null, inReplyTo: null },
  };
  await storeReceive(w.store, R, activityOf(R, create), NOW);
  const original = await s1Id(w);
  expect((await w.h.request(`/api/v1/statuses/${original}/reblog`, bearer(w.l.token, { method: "POST" }))).status).toBe(
    200,
  );
  const boost = (
    await sql<{ id: string; uri: string }>(w.store, "SELECT id, uri FROM statuses WHERE reblog_of_id = ?", original)
  )[0]!;
  await seedReceipts(w.store, boost.id, w.l.id, 4 * STAGING_READ, NOW);
  return { original, boost };
}

// RES-6, ID-7, NET-2, VIS-3: the removal crosses the staging budget (receipts beyond STAGING_READ) while the boost's
// Undo is staged and delivered, then the author's Delete arrives again: no second Undo(Announce) is recorded or sent.
describe("status deletes: the production cleanup", () => {
  it("records and sends one Undo(Announce) across staging, delivery, a redelivered Delete and the rest", async () => {
    const w = await setup();
    const { boost } = await boostedWithReceipts(w);
    const remove: Msg = { type: "Delete", id: `${S1}#delete`, object: S1, proven: false };
    expect((await storeReceive(w.store, R, activityOf(R, remove), NOW)).reason).toBe("status-deleted");
    const undos = () =>
      sql<{ id: number; staged: string | null }>(
        w.store,
        "SELECT id, staged FROM outbound_activities WHERE object_uri = ? AND retracts = 1",
        boost.uri,
      );
    // Job batches stage the Undo; the withdrawn boost remains while its receipts go.
    for (let round = 0; round < 20 && (await undos())[0]?.staged !== null; round++) {
      await runStoreJobs(w.store, BUILD, { now: NOW });
    }
    expect((await undos()).map((u) => u.staged)).toEqual([null]);
    expect(await sql(w.store, "SELECT withdrawn FROM statuses WHERE id = ?", boost.id)).toEqual([{ withdrawn: 1 }]);
    // Kopje delivers the Undo everywhere.
    const undoIds = new Set((await deliverAll(w, "cleanup")).filter((s) => s.endsWith("/undo")));
    expect(undoIds.size).toBe(1);
    // R's Delete again, then the cleanup to its end.
    await storeReceive(w.store, R, activityOf(R, remove), NOW);
    for (let round = 0; round < 100; round++) {
      if (!(await runStoreJobs(w.store, BUILD, { now: NOW })).pending) {
        break;
      }
    }
    const after = await w.store.claimDeliveries(BUILD, { now: NOW, leaseToken: "cleanup-after" });
    expect(after.deliveries).toEqual([]);
    expect(await sql(w.store, "SELECT 1 FROM statuses")).toEqual([]);
    expect(
      await sql(w.store, "SELECT id FROM outbound_activities WHERE object_uri = ? AND retracts = 1", boost.uri),
    ).toEqual([]);
  }, 120_000);

  // ID-7: a boost is withdrawn once. L's unboost withdrew it and its Undo went out while the boost's row stays (its
  // receipts not yet deleted); R's Delete then starts the original's removal, whose job reaches the withdrawn boost
  // with no cursor of its own: it records no second Undo(Announce) and sends none.
  it("an original's removal records no Undo of a boost its booster withdrew", async () => {
    const w = await setup();
    const { original, boost } = await boostedWithReceipts(w);
    expect(
      (await w.h.request(`/api/v1/statuses/${original}/unreblog`, bearer(w.l.token, { method: "POST" }))).status,
    ).toBe(200);
    const undos = () =>
      sql<{ id: number; staged: string | null }>(
        w.store,
        "SELECT id, staged FROM outbound_activities WHERE object_uri = ? AND retracts = 1",
        boost.uri,
      );
    for (let round = 0; round < 20 && (await undos())[0]?.staged !== null; round++) {
      await runStoreJobs(w.store, BUILD, { now: NOW });
    }
    expect((await undos()).map((u) => u.staged)).toEqual([null]);
    const undoIds = new Set((await deliverAll(w, "unboost")).filter((s) => s.endsWith("/undo")));
    expect(undoIds.size).toBe(1);
    // Delivered: its intent is gone, while the boost's row stays, withdrawn.
    expect(await undos()).toEqual([]);
    expect(await sql(w.store, "SELECT withdrawn FROM statuses WHERE id = ?", boost.id)).toEqual([{ withdrawn: 1 }]);
    const remove: Msg = { type: "Delete", id: `${S1}#delete`, object: S1, proven: false };
    expect((await storeReceive(w.store, R, activityOf(R, remove), NOW)).reason).toBe("status-deleted");
    expect(await undos()).toEqual([]);
    for (let round = 0; round < 100; round++) {
      expect(await undos()).toEqual([]);
      if (!(await runStoreJobs(w.store, BUILD, { now: NOW })).pending) {
        break;
      }
    }
    expect(await undos()).toEqual([]);
    expect(await deliverAll(w, "removal")).toEqual([]);
    expect(await sql(w.store, "SELECT 1 FROM statuses")).toEqual([]);
  }, 120_000);
});
