import { runInDurableObject } from "cloudflare:test";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { DeliveryOutcome } from "../src/domain/deliveries";
import { bearer, json, sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { type Body, type Inbound, type Intent, Peer, Policy } from "./follow-model";
import { BUILD } from "./helpers";
import { storeReceive } from "./inbox-store-helpers";
import { runs } from "./policy-world";
import { community, remoteAccount } from "./status-helpers";

// Model-based checks of the follow lifecycle between the local account L and the remote account R (ID-7, NET-2,
// VIS-13 in docs/threat-model.md). Generated sequences of R's server's actions, L's API actions and Kopje's delivery
// steps run through the Store and the API; after every step the Store's projection and each answer must equal the
// policy's (test/follow-model.ts), and once everything has settled Kopje's edges and blocks must equal those of the
// peer, a Mastodon v4.5.11 model fed the bytes Kopje confirmed, except where an accepted risk names
// the generation that differs (`exceptions`).

const ORIGIN = "https://remote.example";
const OK: DeliveryOutcome = { kind: "delivered", status: 202 };
const FAIL: DeliveryOutcome = { kind: "failed", status: 503, error: "HTTP 503", permanent: false };
const SETTLE_STEPS = 400;

type Action =
  | { k: "peerFollow" | "peerRefollow" | "peerUnfollow" | "peerBlock" | "peerUnblock" }
  | { k: "peerAuthorize" | "peerReject" | "peerRemoveFollower" | "peerJob" }
  | { k: "peerLock"; locked: boolean }
  | { k: "deliver" | "redeliver" | "process"; i: number }
  | { k: "follow" | "unfollow" | "authorize" | "reject" | "removeFollower" | "block" | "unblock" | "unlockRound" }
  | { k: "lock"; locked: boolean }
  | { k: "claim" | "send" | "drainPeer" }
  | { k: "confirm"; i: number }
  | { k: "transmit"; i: number; reached: boolean }
  | { k: "complete"; i: number; ok: boolean }
  | { k: "tick"; ms: number };

const simple = <K extends string>(k: K, weight: number) => ({ arbitrary: fc.constant({ k }), weight });
const indexed = <K extends string>(k: K, weight: number) => ({
  arbitrary: fc.record({ k: fc.constant(k), i: fc.nat(3) }),
  weight,
});

const actionArb: fc.Arbitrary<Action> = fc.oneof(
  simple("peerFollow", 4),
  simple("peerRefollow", 1),
  simple("peerUnfollow", 2),
  simple("peerBlock", 1),
  simple("peerUnblock", 1),
  simple("peerAuthorize", 2),
  simple("peerReject", 1),
  simple("peerRemoveFollower", 1),
  simple("peerJob", 1),
  { arbitrary: fc.record({ k: fc.constant("peerLock" as const), locked: fc.boolean() }), weight: 1 },
  indexed("deliver", 6),
  indexed("redeliver", 1),
  indexed("process", 6),
  simple("follow", 3),
  simple("unfollow", 1),
  simple("authorize", 2),
  simple("reject", 1),
  simple("removeFollower", 1),
  simple("block", 1),
  simple("unblock", 1),
  simple("unlockRound", 1),
  { arbitrary: fc.record({ k: fc.constant("lock" as const), locked: fc.boolean() }), weight: 2 },
  simple("claim", 4),
  simple("send", 6),
  simple("drainPeer", 3),
  indexed("confirm", 4),
  { arbitrary: fc.record({ k: fc.constant("transmit" as const), i: fc.nat(3), reached: fc.boolean() }), weight: 4 },
  { arbitrary: fc.record({ k: fc.constant("complete" as const), i: fc.nat(3), ok: fc.boolean() }), weight: 4 },
  { arbitrary: fc.record({ k: fc.constant("tick" as const), ms: fc.constantFrom(1_000, 30_000, 61_000) }), weight: 2 },
);

type Phase = "claimed" | "confirmed" | "transmitted" | "done";
type Attempt = {
  token: string;
  delivery: string;
  intent: Intent;
  phase: Phase;
  reached: boolean;
  body: string | null;
  // The step of its confirmation: an answer confirmed before R's newer Follow committed may still apply there (NET-2).
  confirmedAt: number;
};

export type Stats = Record<string, number>;

const tally = (stats: Stats, key: string, n = 1) => {
  stats[key] = (stats[key] ?? 0) + n;
};

const edgeName = (edge: { state: string } | null) => edge?.state ?? "none";

let leaseSequence = 0;

async function setup() {
  const h = await community(["alice"]);
  const store = h.store;
  const l = h.users.alice;
  const r = await remoteAccount(store, "r");
  const [lAccount, rAccount] = await Promise.all(
    [l.id, r].map(
      async (id) =>
        (
          await sql<{ uri: string; inbox_url: string; shared_inbox_url: string | null }>(
            store,
            "SELECT uri, inbox_url, shared_inbox_url FROM accounts WHERE id = ?",
            id,
          )
        )[0]!,
    ),
  );
  const lUri = lAccount!.uri;
  const rUri = rAccount!.uri;
  const world = {
    h,
    store,
    l,
    r,
    lUri,
    rUri,
    // docs/visibility.md (audienceTargets): an activity without `to` goes to its recipient's shared inbox, else its
    // personal inbox.
    rInbox: rAccount!.shared_inbox_url ?? rAccount!.inbox_url,
    clock: NOW,
    step: 0,
    policy: new Policy(lUri, rUri),
    peer: new Peer(ORIGIN, rUri, lUri),
    attempts: [] as Attempt[],
    // R's messages Kopje has received, and the step each of R's Follows first reached Kopje.
    delivered: [] as Inbound[],
    receivedAt: new Map<string, number>(),
    // R's generations an older Follow of R's reached Kopje after (its deliveries are independent jobs).
    olderFollowAfter: new Set<string>(),
    // #1415: R's generations whose Reject an older Follow of R's cancelled, with that Follow and the Reject's intent.
    cancelledReject: new Map<string, { olderFollow: string; intent: Intent }>(),
    // L's newest follow and block ids.
    lastFollow: null as string | null,
    lastBlock: null as string | null,
    // The id each intent was first sent under (by its policy seq), and the intent each such id belongs to.
    activityIds: new Map<number, string>(),
    intentOfId: new Map<string, number>(),
    trace: [] as string[],
    stats: {} as Stats,
  };
  h.now.mockImplementation(() => world.clock);
  return world;
}

type World = Awaited<ReturnType<typeof setup>>;

// The Store's state for the pair, read in one Durable Object callback.
async function project(w: World) {
  return runInDurableObject(w.store, (_instance, state) => {
    const q = <T extends Record<string, SqlStorageValue>>(query: string, ...params: SqlStorageValue[]) =>
      state.storage.sql.exec<T>(query, ...params).toArray();
    const edge = (from: string, to: string) => {
      const row = q<{ state: string; uri: string }>(
        "SELECT state, uri FROM follows WHERE account_id = ? AND target_account_id = ?",
        from,
        to,
      )[0];
      return row === undefined ? null : { state: row.state, uri: row.uri };
    };
    const block = (from: string, to: string) =>
      q<{ uri: string }>("SELECT uri FROM blocks WHERE account_id = ? AND target_account_id = ?", from, to)[0]?.uri ??
      null;
    const account = q<{ locked: number; followers_count: number; following_count: number }>(
      "SELECT locked, followers_count, following_count FROM accounts WHERE id = ?",
      w.l.id,
    )[0]!;
    const lane = q<{
      state: string;
      token: string | null;
      type: string;
      id: string;
      object: string;
      superseded: number;
    }>(
      `SELECT d.state, d.lease_token AS token, json_extract(o.body, '$.activity.type') AS type,
				json_extract(o.body, '$.activity.id') AS id,
				coalesce(json_extract(o.body, '$.activity.object.id'), json_extract(o.body, '$.activity.object')) AS object,
				o.superseded
			FROM deliveries d JOIN outbound_activities o ON o.id = d.activity_id WHERE d.account_id = ? ORDER BY d.id`,
      w.l.id,
    );
    return {
      rl: edge(w.r, w.l.id),
      lr: edge(w.l.id, w.r),
      blockRL: block(w.r, w.l.id),
      blockLR: block(w.l.id, w.r),
      locked: account.locked === 1,
      followers: account.followers_count,
      following: account.following_count,
      notifications: q<{ type: string }>(
        "SELECT type FROM notifications WHERE account_id = ? AND from_account_id = ? ORDER BY type",
        w.l.id,
        w.r,
      ).map((n) => n.type),
      retracted: q<{ uri: string }>(
        "SELECT target_uri AS uri FROM inbound_retractions WHERE actor_uri = ? ORDER BY target_uri",
        w.rUri,
      ).map((row) => row.uri),
      lane: lane.map((row) => ({
        type: row.type,
        ref: row.type === "Update" ? null : row.type === "Follow" || row.type === "Block" ? row.id : row.object,
        superseded: row.superseded === 1,
        state: row.state,
        token: row.token,
      })),
      // Intents with nothing left to deliver, and targets not yet written as rows: neither may linger.
      unrowed: q<{ type: string }>(
        `SELECT json_extract(body, '$.activity.type') AS type FROM outbound_activities o
				WHERE account_id = ? AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.activity_id = o.id)`,
        w.l.id,
      ).map((row) => row.type),
      unexpanded: q<{ n: number }>("SELECT count(*) AS n FROM outbound_targets")[0]!.n,
      unlockJob:
        q<{ after: number | null }>(
          "SELECT accept_requests_after AS after FROM local_accounts WHERE account_id = ?",
          w.l.id,
        )[0]?.after != null,
    };
  });
}

function expected(w: World) {
  const p = w.policy;
  return {
    rl: p.rl,
    lr: p.lr,
    blockRL: p.blockRL,
    blockLR: p.blockLR,
    locked: p.locked,
    followers: p.followers,
    following: p.following,
    notifications: [...p.notifications].toSorted(),
    retracted: [...p.retracted].toSorted(),
    lane: p.lane.map((i) => ({
      type: i.type,
      ref: i.ref,
      superseded: i.superseded,
      state: i.head === null ? "queued" : i.head.kind,
      token: i.head?.kind === "leased" ? i.head.token : null,
    })),
    unrowed: [] as string[],
    unexpanded: 0,
    unlockJob: p.unlockJob,
  };
}

async function check(w: World, answer: { actual: unknown; predicted: unknown } | null = null): Promise<void> {
  const context = w.trace.join("\n");
  if (answer !== null) {
    expect(answer.actual, context).toEqual(answer.predicted);
  }
  const actual = await project(w);
  // A profile Update addressed to nobody is recorded with no row (L had no follower then); it carries no relationship.
  actual.unrowed = actual.unrowed.filter((type) => type !== "Update");
  expect(actual, context).toEqual(expected(w));
}

const log = (w: World, line: string) => {
  w.step++;
  w.trace.push(`${w.step} ${line}`);
};

async function api(w: World, path: string, init: RequestInit = json({})): Promise<number> {
  return (await w.h.request(path, bearer(w.l.token, init))).status;
}

// R's message through Kopje's inbox, as the Worker hands a verified activity to the Store.
async function deliverToKopje(w: World, activity: Inbound, label: string): Promise<void> {
  log(
    w,
    `${label} ${activity.type} ${JSON.stringify(activity.type === "Follow" || activity.type === "Block" ? activity.id : activity.object.id)}`,
  );
  const before = `R->L ${edgeName(w.policy.rl)}, L->R ${edgeName(w.policy.lr)}`;
  const rl = w.policy.rl;
  const order = w.peer.generations;
  const result = await storeReceive(w.store, w.rUri, activity, w.clock);
  const predicted = w.policy.receive(activity, w.clock);
  // Only an older Follow that took over as the next generation (a renewal applied) arms the exception.
  if (
    activity.type === "Follow" &&
    predicted.applied &&
    rl !== null &&
    w.policy.rl?.uri === activity.id &&
    order.indexOf(activity.id) < order.indexOf(rl.uri)
  ) {
    w.olderFollowAfter.add(rl.uri);
  }
  // #1415: an older Follow h cancelling the Reject of a later generation g that L had removed.
  if (activity.type === "Follow") {
    for (const intent of predicted.caught ?? []) {
      if (intent.type === "Reject" && intent.ref !== null && order.indexOf(activity.id) < order.indexOf(intent.ref)) {
        w.cancelledReject.set(intent.ref, { olderFollow: activity.id, intent });
      }
    }
  }
  w.trace.push(`  -> ${result.reason}`);
  if (activity.type === "Follow" && !w.receivedAt.has(activity.id)) {
    w.receivedAt.set(activity.id, w.step);
  }
  if (predicted.reason === "follow-request-updated" || predicted.reason === "follow-reaccepted") {
    tally(w.stats, "renewal");
  }
  if ((predicted.caught?.length ?? 0) > 0) {
    tally(w.stats, "stale answer cancelled");
  }
  if (activity.type === "Block" && predicted.reason === "blocked") {
    tally(w.stats, `remote Block, ${before}`);
  }
  w.delivered.push(activity);
  await check(w, {
    actual: { applied: result.applied, reason: result.reason },
    predicted: { applied: predicted.applied, reason: predicted.reason },
  });
}

async function currentUri(w: World, table: "follows" | "blocks"): Promise<string | null> {
  const rows = await sql<{ uri: string }>(
    w.store,
    `SELECT uri FROM ${table} WHERE account_id = ? AND target_account_id = ?`,
    w.l.id,
    w.r,
  );
  return rows[0]?.uri ?? null;
}

const must = (uri: string | null) => () => {
  if (uri === null) {
    throw new Error("Kopje recorded no id for the new relationship");
  }
  return uri;
};

async function local(w: World, a: Action): Promise<void> {
  const p = w.policy;
  const now = w.clock;
  const r = w.r;
  log(w, a.k + ("locked" in a ? ` ${a.locked}` : ""));
  let status: number;
  let predicted: number;
  switch (a.k) {
    case "follow": {
      status = await api(w, `/api/v1/accounts/${r}/follow`);
      const uri = await currentUri(w, "follows");
      predicted = p.localFollow(now, must(uri));
      w.lastFollow = p.lr?.uri ?? w.lastFollow;
      break;
    }
    case "unfollow":
      status = await api(w, `/api/v1/accounts/${r}/unfollow`);
      predicted = p.localUnfollow(now);
      break;
    case "authorize":
      status = await api(w, `/api/v1/follow_requests/${r}/authorize`);
      predicted = p.authorize(now);
      break;
    case "reject":
      status = await api(w, `/api/v1/follow_requests/${r}/reject`);
      predicted = p.rejectRequest(now);
      break;
    case "removeFollower":
      status = await api(w, `/api/v1/accounts/${r}/remove_from_followers`);
      predicted = p.removeFromFollowers(now);
      break;
    case "block": {
      if (p.blockLR === null) {
        tally(w.stats, `local Block, R->L ${edgeName(p.rl)}, L->R ${edgeName(p.lr)}`);
      }
      status = await api(w, `/api/v1/accounts/${r}/block`);
      const uri = await currentUri(w, "blocks");
      predicted = p.localBlock(now, must(uri));
      w.lastBlock = p.blockLR ?? w.lastBlock;
      break;
    }
    case "unblock":
      status = await api(w, `/api/v1/accounts/${r}/unblock`);
      predicted = p.localUnblock(now);
      break;
    case "lock":
      status = await api(w, "/api/v1/accounts/update_credentials", json({ locked: a.locked }, { method: "PATCH" }));
      predicted = p.lock(a.locked, now);
      break;
    case "unlockRound": {
      await w.store.runUnlockAccepts(BUILD, { now });
      status = 200;
      if (p.unlockRound(now)) {
        tally(w.stats, "unlock round authorized");
      }
      predicted = 200;
      break;
    }
    default:
      throw new Error(`not a local action: ${a.k}`);
  }
  w.trace.push(`  -> ${status}`);
  await check(w, { actual: status, predicted });
}

function peerAction(w: World, a: Action): boolean {
  const peer = w.peer;
  switch (a.k) {
    case "peerFollow":
      return peer.follow();
    case "peerRefollow":
      return peer.refollow();
    case "peerUnfollow":
      return peer.unfollow();
    case "peerBlock":
      return peer.block();
    case "peerUnblock":
      return peer.unblock();
    case "peerAuthorize":
      return peer.authorize();
    case "peerReject":
      return peer.reject();
    case "peerRemoveFollower":
      return peer.removeFollower();
    case "peerLock":
      peer.lock(a.locked);
      return true;
    case "peerJob": {
      const had = peer.lr?.state === "requested" && peer.jobs > 0;
      const ran = peer.runJob();
      if (had && ran) {
        tally(w.stats, "peer authorization job");
      }
      return ran;
    }
    default:
      throw new Error(`not a peer action: ${a.k}`);
  }
}

// The activity a delivery row carries, as its type and ref (the identity the projection compares).
async function rowIdentity(w: World, delivery: string) {
  const row = (
    await sql<{ type: string; id: string; object: string }>(
      w.store,
      `SELECT json_extract(o.body, '$.activity.type') AS type, json_extract(o.body, '$.activity.id') AS id,
				coalesce(json_extract(o.body, '$.activity.object.id'), json_extract(o.body, '$.activity.object')) AS object
			FROM deliveries d JOIN outbound_activities o ON o.id = d.activity_id WHERE d.id = ?`,
      delivery,
    )
  )[0]!;
  return {
    type: row.type,
    ref: row.type === "Update" ? null : row.type === "Follow" || row.type === "Block" ? row.id : row.object,
  };
}

async function claim(w: World): Promise<Attempt | null> {
  const token = `lease-${++leaseSequence}`;
  log(w, `claim ${token} at +${w.clock - NOW}`);
  const result = await w.store.claimDeliveries(BUILD, { now: w.clock, leaseToken: token });
  const predicted = w.policy.claim(w.clock, token);
  if (predicted.gaveUp !== null) {
    throw new Error(`a delivery gave up, failing the eventual-delivery assumption\n${w.trace.join("\n")}`);
  }
  const claimed = await Promise.all(
    result.deliveries.map(async (d) => ({
      ...(await rowIdentity(w, d.id)),
      inbox: d.inbox,
      signer: d.signer,
      actor: result.signers[d.signer]?.actorUri,
    })),
  );
  const leased = predicted.leased;
  w.trace.push(`  -> ${JSON.stringify(claimed)}${predicted.dropped === null ? "" : " (dropped a stale answer)"}`);
  if (predicted.dropped !== null) {
    tally(w.stats, "stale answer dropped");
  }
  // NET-2: everything L sends R goes to R's inbox, signed as L.
  await check(w, {
    actual: claimed,
    predicted:
      leased === null ? [] : [{ type: leased.type, ref: leased.ref, inbox: w.rInbox, signer: w.l.id, actor: w.lUri }],
  });
  if (leased === null) {
    return null;
  }
  const attempt: Attempt = {
    token,
    delivery: result.deliveries[0]!.id,
    intent: leased,
    phase: "claimed",
    reached: false,
    body: null,
    confirmedAt: 0,
  };
  w.attempts.push(attempt);
  return attempt;
}

// The parts of a body the peer acts on: its type, its actor, the id of a Follow or Block, and its object with the
// fields an embedded Follow or Block carries. Every id goes through activityIdentity; a Follow's or a Block's is then
// compared exactly, while an answer's, an Undo's or an Update's own id is Kopje's to choose, so only its identity is.
function bodyShape(w: World, body: Body, intent: Intent | null) {
  const identity = activityIdentity(w, body.id, intent);
  const own = (body.type === "Follow" || body.type === "Block") && identity.startsWith("intent ") ? body.id : identity;
  const object =
    typeof body.object === "string"
      ? body.object
      : body.type === "Update"
        ? { id: body.object.id, type: body.object.type }
        : { id: body.object.id, type: body.object.type, actor: body.object.actor, object: body.object.object };
  return { type: body.type, id: own, actor: body.actor, object };
}

// ID-7: an activity Kopje sends keeps its id across its attempts (a retry, a POST again after its lease), no two
// activities share one, and each is on L's origin. The identity is the policy's intent while the id holds to that.
function activityIdentity(w: World, id: string, intent: Intent | null): string {
  if (intent === null) {
    return id;
  }
  const known = w.activityIds.get(intent.seq);
  const other = w.intentOfId.get(id);
  if (new URL(id).origin !== new URL(w.lUri).origin) {
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

// The body the policy's intent stands for, in bodyShape's terms.
function predictedShape(w: World, intent: Intent) {
  const base = { type: intent.type, actor: w.lUri };
  const own = `intent ${intent.seq}`;
  switch (intent.type) {
    case "Follow":
    case "Block":
      return { ...base, id: intent.ref, object: w.rUri };
    case "Undo":
      return { ...base, id: own, object: { id: intent.ref, type: intent.undoes, actor: w.lUri, object: w.rUri } };
    case "Accept":
    case "Reject":
      return { ...base, id: own, object: { id: intent.ref, type: "Follow", actor: w.rUri, object: w.lUri } };
    case "Update":
      return { ...base, id: own, object: { id: w.lUri, type: "Person" } };
  }
}

const bodyRef = (body: Body) =>
  body.type === "Update"
    ? null
    : body.type === "Follow" || body.type === "Block"
      ? body.id
      : typeof body.object === "string"
        ? body.object
        : (body.object.id ?? null);

async function confirm(w: World, attempt: Attempt): Promise<void> {
  log(w, `confirm ${attempt.token} (${attempt.intent.type} ${attempt.intent.ref})`);
  const result = await w.store.confirmDelivery(BUILD, {
    id: attempt.delivery,
    leaseToken: attempt.token,
    now: w.clock,
  });
  const predicted = w.policy.confirm(attempt.token, w.clock);
  w.trace.push(`  -> ${result.status}`);
  if (result.status === "stale") {
    tally(w.stats, "stale attempt refused");
  }
  if (result.status === "send") {
    const body = JSON.parse(result.body) as Body;
    attempt.body = result.body;
    attempt.phase = "confirmed";
    attempt.confirmedAt = w.step;
    await check(w, {
      actual: { status: "send", body: bodyShape(w, body, predicted.status === "send" ? predicted.intent : null) },
      predicted:
        predicted.status === "send"
          ? { status: "send", body: predictedShape(w, predicted.intent) }
          : { status: predicted.status },
    });
    return;
  }
  attempt.phase = "done";
  await check(w, { actual: result.status, predicted: predicted.status });
}

function transmit(w: World, attempt: Attempt, reached: boolean): void {
  log(w, `transmit ${attempt.token} ${reached ? "reached" : "lost"}`);
  attempt.phase = "transmitted";
  attempt.reached = reached;
  if (reached) {
    w.peer.receive(JSON.parse(attempt.body!) as Body);
  }
}

async function complete(w: World, attempt: Attempt, ok: boolean): Promise<void> {
  log(w, `complete ${attempt.token} ${ok ? "delivered" : "failed"}`);
  const result = await w.store.completeDelivery(BUILD, {
    id: attempt.delivery,
    leaseToken: attempt.token,
    now: w.clock,
    outcome: ok ? OK : FAIL,
  });
  attempt.phase = "done";
  const retryAt = result.status === "retry" ? result.retryAt : null;
  const predicted = w.policy.complete(attempt.token, ok, w.clock, retryAt);
  w.trace.push(`  -> ${result.status}`);
  if (result.status === "stale") {
    tally(w.stats, "stale attempt refused");
  }
  await check(w, { actual: result.status, predicted });
}

const open = (w: World, phases: Phase[]) => w.attempts.filter((a) => phases.includes(a.phase));

function peerProcess(w: World, index: number): void {
  if (index > 0) {
    tally(w.stats, "reordered processing at the peer");
  }
  const body = w.peer.process(index, w.clock);
  log(w, `peer processes ${body?.type} ${body === null ? "" : bodyRef(body)}`);
}

async function act(w: World, a: Action): Promise<void> {
  switch (a.k) {
    case "peerFollow":
    case "peerRefollow":
    case "peerUnfollow":
    case "peerBlock":
    case "peerUnblock":
    case "peerAuthorize":
    case "peerReject":
    case "peerRemoveFollower":
    case "peerJob":
    case "peerLock":
      if (peerAction(w, a)) {
        log(w, a.k + ("locked" in a ? ` ${a.locked}` : ""));
      }
      return;
    case "deliver": {
      const outbox = w.peer.outbox;
      if (outbox.length > 0) {
        const index = a.i % outbox.length;
        if (index > 0) {
          tally(w.stats, "reordered delivery to Kopje");
        }
        const [message] = outbox.splice(index, 1);
        await deliverToKopje(w, message!.activity, "deliver");
      }
      return;
    }
    case "redeliver":
      if (w.delivered.length > 0) {
        await deliverToKopje(w, w.delivered[a.i % w.delivered.length]!, "redeliver");
      }
      return;
    case "process":
      if (w.peer.inbox.length > 0) {
        peerProcess(w, a.i % w.peer.inbox.length);
      }
      return;
    case "claim":
      await claim(w);
      return;
    // The usual path in one action: a claim whose row is confirmed, reaches R's server and is completed.
    case "send": {
      const attempt = await claim(w);
      if (attempt !== null) {
        await confirm(w, attempt);
        if (attempt.phase === "confirmed") {
          transmit(w, attempt, true);
          await complete(w, attempt, true);
        }
      }
      return;
    }
    // R's server processes what it received and sends what it queued, each in order.
    case "drainPeer":
      while (w.peer.inbox.length > 0) {
        peerProcess(w, 0);
      }
      while (w.peer.outbox.length > 0) {
        await deliverToKopje(w, w.peer.outbox.shift()!.activity, "deliver");
      }
      return;
    case "confirm": {
      const attempts = open(w, ["claimed"]);
      if (attempts.length > 0) {
        await confirm(w, attempts[a.i % attempts.length]!);
      }
      return;
    }
    case "transmit": {
      const attempts = open(w, ["confirmed"]);
      if (attempts.length > 0) {
        transmit(w, attempts[a.i % attempts.length]!, a.reached);
      }
      return;
    }
    case "complete": {
      // A delivered outcome needs a transmission that reached R's server; a failure may come at any phase.
      const attempts = open(w, ["claimed", "confirmed", "transmitted"]);
      if (attempts.length > 0) {
        const attempt = attempts[a.i % attempts.length]!;
        await complete(w, attempt, a.ok && attempt.phase === "transmitted" && attempt.reached);
      }
      return;
    }
    case "tick":
      w.clock += a.ms;
      log(w, `tick ${a.ms}`);
      return;
    default:
      await local(w, a);
  }
}

// Finishes every open attempt, delivers and processes everything on both sides, runs the peer's jobs and Kopje's
// unlock rounds, advancing the clock to the next retry or lease expiry when nothing is due, until all is quiet.
async function settle(w: World): Promise<void> {
  for (let round = 0; round < SETTLE_STEPS; round++) {
    for (const attempt of open(w, ["claimed", "confirmed", "transmitted"])) {
      if (attempt.phase === "claimed") {
        await confirm(w, attempt);
      }
      if (attempt.phase === "confirmed") {
        transmit(w, attempt, true);
      }
      if (attempt.phase === "transmitted") {
        await complete(w, attempt, attempt.reached);
      }
    }
    const attempt = await claim(w);
    if (attempt !== null) {
      continue;
    }
    while (w.peer.inbox.length > 0) {
      peerProcess(w, 0);
    }
    while (w.peer.jobs > 0) {
      peerAction(w, { k: "peerJob" });
    }
    while (w.peer.outbox.length > 0) {
      await deliverToKopje(w, w.peer.outbox.shift()!.activity, "deliver");
    }
    if (w.policy.unlockJob) {
      await local(w, { k: "unlockRound" });
    }
    const head = w.policy.lane[0]?.head;
    if (head == null) {
      if (
        w.policy.lane.length === 0 &&
        w.peer.inbox.length === 0 &&
        w.peer.outbox.length === 0 &&
        !w.policy.unlockJob
      ) {
        const state = await project(w);
        expect(state.lane, w.trace.join("\n")).toEqual([]);
        expect(state.unexpanded).toBe(0);
        return;
      }
      continue;
    }
    // Nothing is due: the clock moves to the head's retry or the end of its lease.
    const due = head.kind === "pending" ? head.dueAt : head.until;
    if (due > w.clock) {
      w.clock = due;
      log(w, `clock to +${w.clock - NOW}`);
    }
  }
  throw new Error(`settlement did not finish in ${SETTLE_STEPS} rounds\n${w.trace.join("\n")}`);
}

// ---------------------------------------------------------------------------------------------------------------
// Quiescence: Kopje against the peer
// ---------------------------------------------------------------------------------------------------------------

type Exception = "net2-answer" | "block-race" | "reordered-follows" | "refused-refollow" | "known-defect-1415" | null;

const peerState = (edge: { state: string; uri: string } | null) =>
  edge === null ? null : { state: edge.state === "pending" ? "requested" : edge.state, uri: edge.uri };

// The difference allowed on R's follow of L, if one is: each names R's newest generation g, the identified events
// that produced it, and the one difference it allows.
function rlException(w: World, kopje: { state: string; uri: string } | null): Exception {
  const peer = w.peer;
  const g = peer.lastRGeneration;
  if (g === null) {
    return null;
  }
  const mine = peerState(kopje);
  const theirs = peer.rl;
  // NET-2's accepted risk: an answer of an earlier generation, POSTed before Kopje received g (its confirmation came
  // first), applied by the pair to g at R's server (accept.rb:24, reject.rb:25).
  const answeredEarlier = w.attempts.some(
    (a) =>
      a.intent.answer &&
      a.intent.ref !== g &&
      a.body !== null &&
      a.reached &&
      a.confirmedAt < (w.receivedAt.get(g) ?? Number.POSITIVE_INFINITY),
  );
  if (peer.events.pairAnswer.has(g) && answeredEarlier && mine?.uri === g) {
    if ((mine.state === "requested" && theirs?.state === "accepted" && theirs.uri === g) || theirs === null) {
      return "net2-answer";
    }
  }
  // The accepted risk of a block and unblock racing a new Follow: L's Block reached R's server after R sent g, and
  // dropped the request there (block.rb:16), while Kopje, unblocked already, took g.
  if (peer.events.blockDroppedRequest.has(g) && mine?.uri === g && theirs === null) {
    return "block-race";
  }
  // The accepted risk of R's Follows reaching Kopje out of order: an older Follow after g takes over as the next
  // generation, as Mastodon's fast-forward does (follow.rb:11-29), so the older one's Undo ends the follow at Kopje
  // while R's server holds g. Kopje holds anything but g; R's server holds g.
  if (w.olderFollowAfter.has(g) && mine?.uri !== g && theirs?.uri === g) {
    return "reordered-follows";
  }
  // The accepted risk of a refused refollow: R's server dropped its accepted follow g for a refollow (RefollowWorker,
  // which sends no Undo) and FollowService refused the replacement, since R blocks L (follow_service.rb:56-58). Kopje
  // holds g accepted; R's server holds nothing.
  if (peer.events.refusedRefollow.has(g) && mine?.uri === g && mine.state === "accepted" && theirs === null) {
    return "refused-refollow";
  }
  return knownDefect1415(w, g, mine, theirs);
}

// Known defect #1415; the fix removes this function. An older Follow h of R's, reaching Kopje after L removed R's
// later follow g, cancels g's Reject still waiting (NET-2's pair cancellation), where a Mastodon receiver delivers it
// (remove_from_followers_service.rb:16-18, an independent DeliveryWorker job) and R's server then ends g
// (reject.rb:7). Allowed only while that Reject never reached R's server: Kopje holds nothing; R's server holds g.
function knownDefect1415(
  w: World,
  g: string,
  mine: { state: string; uri: string } | null,
  theirs: { state: string; uri: string } | null,
): Exception {
  const cancelled = w.cancelledReject.get(g);
  if (cancelled === undefined || mine !== null || theirs?.uri !== g || theirs.state !== "accepted") {
    return null;
  }
  return w.attempts.some((a) => a.intent === cancelled.intent && a.reached) ? null : "known-defect-1415";
}

// The differences allowed on L's follow of R, named by L's newest follow id u.
function lrExceptionOf(
  w: World,
  kopje: { state: string; uri: string } | null,
): "at-least-once-follow" | "undo-after-newer-follow" | "undo-matched-older-follow" | null {
  const u = w.lastFollow;
  if (u === null) {
    return null;
  }
  const peer = w.peer;
  // The accepted risk of at-least-once delivery: u was POSTed again after its lease (its completion lost), and the
  // repeat reached R's server after the Undo that removed u there (each body is its own job), so Mastodon recreates
  // the follow (follow.rb:31-37); Kopje has ended it. Kopje holds nothing; R's server holds u.
  const reached = w.attempts.filter((a) => a.intent.type === "Follow" && a.intent.ref === u && a.reached).length;
  if (reached >= 2 && peer.events.replayAfterUndo.has(u) && kopje === null && peer.lr?.uri === u) {
    return "at-least-once-follow";
  }
  // The accepted risk of an older Undo processed after a newer Follow: R's server processed L's Undo of an earlier
  // follow after u (each body is its own job), and Mastodon's Undo matches by the account pair (undo.rb:89-101), so it
  // ended u there. Kopje holds u; R's server holds nothing.
  const endedBy = peer.events.undoEnded.follow;
  if (kopje?.uri === u && peer.lr === null && endedBy !== null && endedBy !== u) {
    return "undo-after-newer-follow";
  }
  // The same race the other way: u's Undo was processed before u, while an earlier follow stood, and ended that one
  // by the pair, so nothing suppresses u, which then recreates the follow. Kopje holds nothing; R's server holds u.
  if (kopje === null && peer.lr?.uri === u && peer.events.undoNamedOther.follow.has(u)) {
    return "undo-matched-older-follow";
  }
  return null;
}

// The differences allowed on L's block of R, named by L's newest block id b: the same races for blocks, as Mastodon's
// Undo of a Block matches by the account pair (undo.rb:116-126). An older Undo processed after b ended b at R's
// server (Kopje holds b; R's server nothing), or b's Undo, processed before b, ended an earlier block, so b then
// applied there (Kopje holds nothing; R's server holds b).
function lBlockExceptionOf(
  w: World,
  kopje: string | null,
): "undo-after-newer-block" | "undo-matched-older-block" | null {
  const b = w.lastBlock;
  if (b === null) {
    return null;
  }
  const peer = w.peer;
  const endedBy = peer.events.undoEnded.block;
  if (kopje === b && peer.lBlocks === null && endedBy !== null && endedBy !== b) {
    return "undo-after-newer-block";
  }
  if (kopje === null && peer.lBlocks === b && peer.events.undoNamedOther.block.has(b)) {
    return "undo-matched-older-block";
  }
  return null;
}

async function quiescence(w: World): Promise<void> {
  const state = await project(w);
  const peer = w.peer;
  const context = w.trace.join("\n");
  const exception = rlException(w, state.rl);
  const lrException = lrExceptionOf(w, state.lr);
  const lBlockException = lBlockExceptionOf(w, state.blockLR);
  for (const e of [exception, lrException, lBlockException]) {
    if (e !== null) {
      tally(w.stats, `exception ${e}`);
    }
  }
  const kopje = {
    rl: exception === null ? peerState(state.rl) : "excepted",
    lr: lrException === null ? peerState(state.lr) : "excepted",
    rBlocks: state.blockRL,
    lBlocks: lBlockException === null ? state.blockLR : "excepted",
  };
  const theirs = {
    rl: exception === null ? peer.rl : "excepted",
    lr: lrException === null ? peer.lr : "excepted",
    rBlocks: peer.rBlocks,
    lBlocks: lBlockException === null ? peer.lBlocks : "excepted",
  };
  expect(kopje, context).toEqual(theirs);
}

async function run(actions: readonly Action[]): Promise<World> {
  const w = await setup();
  await check(w);
  for (const a of actions) {
    await act(w, a);
  }
  w.trace.push("-- settle");
  await settle(w);
  await quiescence(w);
  tally(w.stats, "peer: an Undo before its Follow", w.peer.events.undoBeforeFollow);
  tally(w.stats, "peer: a replay after a matched Undo", w.peer.events.replayAfterUndo.size);
  return w;
}

const STATS: Stats = {};

const merge = (stats: Stats) => {
  for (const [key, n] of Object.entries(stats)) {
    tally(STATS, key, n);
  }
};

const CASES = 40;
const SEED = 1411;

describe("follow lifecycle: Kopje against its policy and a Mastodon peer", () => {
  it("agrees with the policy after every step and with the peer once settled", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        fc.boolean(),
        fc.array(actionArb, { minLength: 10, maxLength: 50 }),
        async (locked, peerLocked, actions) => {
          const start: Action[] = [
            ...(locked ? [{ k: "lock", locked: true } as const] : []),
            ...(peerLocked ? [{ k: "peerLock", locked: true } as const] : []),
          ];
          merge((await run([...start, ...actions])).stats);
        },
      ),
      runs(CASES, SEED),
    );
    console.log("follow lifecycle coverage", JSON.stringify(STATS, null, 1));
  }, 600_000);
});

// ---------------------------------------------------------------------------------------------------------------
// The inbound family alone (policy only, not Mastodon realism): Follow generations and their replays, typed and
// untyped Undo of Follows and Blocks, Blocks with new ids, with L's lock and its answers, checked after every step.
// ---------------------------------------------------------------------------------------------------------------

const FOLLOWS = ["f1", "f2", "f3"].map((s) => `${ORIGIN}/follows/${s}`);
const BLOCKS = ["b1", "b2"].map((s) => `${ORIGIN}/blocks/${s}`);

type InboundAction =
  | { k: "inFollow" | "inBlock"; id: string }
  | { k: "inUndo"; id: string; type: "Follow" | "Block" | null }
  | { k: "lock"; locked: boolean }
  | { k: "authorize" | "reject" | "removeFollower" };

const inboundArb: fc.Arbitrary<InboundAction> = fc.oneof(
  { arbitrary: fc.record({ k: fc.constant("inFollow" as const), id: fc.constantFrom(...FOLLOWS) }), weight: 4 },
  { arbitrary: fc.record({ k: fc.constant("inBlock" as const), id: fc.constantFrom(...BLOCKS) }), weight: 2 },
  {
    arbitrary: fc.record({
      k: fc.constant("inUndo" as const),
      id: fc.constantFrom(...FOLLOWS, ...BLOCKS),
      type: fc.constantFrom("Follow" as const, "Block" as const, null),
    }),
    weight: 3,
  },
  { arbitrary: fc.record({ k: fc.constant("lock" as const), locked: fc.boolean() }), weight: 1 },
  {
    arbitrary: fc.constantFrom({ k: "authorize" as const }, { k: "reject" as const }, { k: "removeFollower" as const }),
    weight: 2,
  },
);

let undoSequence = 0;

async function inbound(w: World, a: InboundAction): Promise<void> {
  switch (a.k) {
    case "inFollow":
      return deliverToKopje(w, { type: "Follow", id: a.id, object: w.lUri }, "receive");
    case "inBlock":
      return deliverToKopje(w, { type: "Block", id: a.id, object: w.lUri }, "receive");
    case "inUndo": {
      const object =
        a.type === null
          ? { id: a.id, type: null, actor: null, object: null }
          : { id: a.id, type: a.type, actor: w.rUri, object: w.lUri };
      return deliverToKopje(w, { type: "Undo", id: `${ORIGIN}/undos/${++undoSequence}`, object }, "receive");
    }
    default:
      return local(w, a);
  }
}

describe("follow lifecycle: R's inbound activities against the policy", () => {
  it("agrees with the policy after every activity, typed and untyped Undo included", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(inboundArb, { minLength: 1, maxLength: 16 }), async (actions) => {
        const w = await setup();
        for (const a of actions) {
          await inbound(w, a);
        }
      }),
      runs(CASES, SEED),
    );
  }, 300_000);
});

const at = (i: number) => ({ i });

// Each transition the property counts, and each accepted race, by a fixed sequence through the same harness (every
// step checked against the policy, and the settled pair against the peer).
describe("follow lifecycle transitions", () => {
  it("a renewal: R's server follows again (RefollowWorker) and Kopje accepts the new generation", async () => {
    const w = await run([
      { k: "peerFollow" },
      { k: "drainPeer" },
      { k: "send" },
      { k: "drainPeer" },
      { k: "peerRefollow" },
    ]);
    expect(w.stats.renewal).toBe(1);
    expect(w.peer.rl?.state).toBe("accepted");
  });

  it("a renewal cancels the answer still waiting for the earlier generation", async () => {
    const w = await run([
      { k: "lock", locked: true },
      { k: "peerFollow" },
      { k: "drainPeer" },
      { k: "authorize" },
      { k: "peerUnfollow" },
      { k: "peerFollow" },
      { k: "drainPeer" },
    ]);
    expect(w.stats["stale answer cancelled"]).toBe(1);
  });

  // ID-7: a retried Undo keeps its id (checked at each confirmation, as are the other activities' distinct ids).
  it("a retried Undo keeps its id", async () => {
    const w = await run([
      { k: "follow" },
      { k: "send" },
      { k: "unfollow" },
      { k: "claim" },
      { k: "confirm", ...at(0) },
      { k: "transmit", reached: false, ...at(0) },
      { k: "complete", ok: false, ...at(0) },
      { k: "peerFollow" },
      { k: "drainPeer" },
    ]);
    const confirmed = (type: string) =>
      w.attempts.filter((a) => a.intent.type === type && a.body !== null).map((a) => (JSON.parse(a.body!) as Body).id);
    expect(confirmed("Undo")).toHaveLength(2);
    expect(new Set(confirmed("Undo")).size).toBe(1);
    expect(confirmed("Accept")).toHaveLength(1);
    expect(w.intentOfId.size).toBe(3);
  });

  it("a stale attempt is refused at its confirmation and its completion", async () => {
    const w = await run([
      { k: "follow" },
      { k: "claim" },
      { k: "tick", ms: 61_000 },
      { k: "claim" },
      // The first attempt's confirmation, after the second claim took the row.
      { k: "confirm", ...at(0) },
      { k: "confirm", ...at(0) },
      { k: "tick", ms: 61_000 },
      { k: "claim" },
      // The second attempt's completion, after the third claim.
      { k: "complete", ok: false, ...at(0) },
    ]);
    expect(w.stats["stale attempt refused"]).toBe(2);
  });

  it("R's server's authorization job, queued by its unlock, accepts L's request", async () => {
    const w = await run([
      { k: "peerLock", locked: true },
      { k: "follow" },
      { k: "send" },
      { k: "drainPeer" },
      { k: "peerLock", locked: false },
      { k: "peerLock", locked: true },
      { k: "peerJob" },
    ]);
    expect(w.stats["peer authorization job"]).toBe(1);
    expect(w.peer.lr?.state).toBe("accepted");
    expect((await project(w)).lr?.state).toBe("accepted");
  });

  it("an unlock round accepts R's pending request", async () => {
    const w = await run([
      { k: "lock", locked: true },
      { k: "peerFollow" },
      { k: "drainPeer" },
      { k: "lock", locked: false },
      { k: "unlockRound" },
    ]);
    expect(w.stats["unlock round authorized"]).toBe(1);
    expect(w.peer.rl?.state).toBe("accepted");
  });

  it("deliveries reordered both ways", async () => {
    const w = await run([
      { k: "follow" },
      { k: "send" },
      { k: "unfollow" },
      { k: "send" },
      { k: "process", ...at(1) },
      { k: "peerFollow" },
      { k: "peerUnfollow" },
      { k: "deliver", ...at(1) },
    ]);
    expect(w.stats["reordered processing at the peer"]).toBe(1);
    expect(w.stats["reordered delivery to Kopje"]).toBe(1);
    // L's Undo processed before its Follow at R's server: the Follow is suppressed (activity.rb:92-98, follow.rb:9).
    expect(w.stats["peer: an Undo before its Follow"]).toBe(1);
  });

  it.each([
    ["R->L pending, L->R pending", true, true],
    ["R->L accepted, L->R accepted", false, false],
  ])("a local Block, %s", async (name, locked, peerLocked) => {
    const w = await run([
      ...(locked ? [{ k: "lock", locked: true } as const] : []),
      ...(peerLocked ? [{ k: "peerLock", locked: true } as const] : []),
      { k: "peerFollow" },
      { k: "follow" },
      { k: "drainPeer" },
      { k: "send" },
      { k: "send" },
      { k: "drainPeer" },
      { k: "drainPeer" },
      { k: "block" },
    ]);
    expect(w.stats[`local Block, ${name}`]).toBe(1);
  });

  it.each([
    ["R->L accepted, L->R pending", true],
    ["R->L accepted, L->R accepted", false],
  ])("a remote Block, %s", async (name, peerLocked) => {
    const w = await run([
      ...(peerLocked ? [{ k: "peerLock", locked: true } as const] : []),
      { k: "peerFollow" },
      { k: "follow" },
      { k: "drainPeer" },
      { k: "send" },
      { k: "send" },
      { k: "drainPeer" },
      { k: "drainPeer" },
      { k: "peerBlock" },
      // The Block reaches Kopje before the Undo and the Reject R's server sent ahead of it.
      { k: "deliver", ...at(2) },
    ]);
    expect(w.stats[`remote Block, ${name}`]).toBe(1);
  });

  // The accepted risk of at-least-once delivery: L's Follow is POSTed again after its lease expired, and R's server
  // processes the second copy after the Undo that came between (each body is its own job), recreating the follow.
  it("a replay after a matched Undo at the peer recreates the follow there", async () => {
    const w = await run([
      { k: "follow" },
      { k: "claim" },
      { k: "confirm", ...at(0) },
      { k: "transmit", reached: true, ...at(0) },
      { k: "tick", ms: 61_000 },
      { k: "send" },
      { k: "process", ...at(0) },
      { k: "unfollow" },
      { k: "send" },
      { k: "process", ...at(1) },
      { k: "process", ...at(0) },
    ]);
    expect(w.stats["peer: a replay after a matched Undo"]).toBe(1);
    expect(w.stats["exception at-least-once-follow"]).toBe(1);
    expect(w.peer.lr?.state).toBe("accepted");
    expect((await project(w)).lr).toBeNull();
  });

  // Mastodon's BlockService has no guard for a block R already holds: blocking again runs its cleanup, which now
  // undoes R's follow that began when L authorized the request the first Block kept, and sends the Block again
  // under its id.
  it("R's server blocks again: its cleanup runs again and the Block is resent under its id", async () => {
    const w = await run([
      { k: "lock", locked: true },
      { k: "peerFollow" },
      { k: "peerBlock" },
      { k: "deliver", ...at(0) },
      { k: "deliver", ...at(0) },
      { k: "authorize" },
      { k: "send" },
      { k: "drainPeer" },
      { k: "peerBlock" },
    ]);
    const blocks = w.peer.sent.filter((m) => m.activity.type === "Block").map((m) => m.activity.id);
    expect(blocks).toHaveLength(2);
    expect(new Set(blocks).size).toBe(1);
    expect(w.peer.sent.filter((m) => m.activity.type === "Undo")).toHaveLength(1);
    expect(w.trace).toContain("  -> duplicate");
    expect(w.peer.rl).toBeNull();
    expect((await project(w)).blockRL).toBe(blocks[0]);
  });
});

describe("follow lifecycle accepted races", () => {
  // L blocks R and unblocks at once; R's Follow reaches Kopje after the unblock but before R's server processed the
  // Block. Kopje accepts it and sends Block, its Undo and the Accept in lane order; Mastodon's Block handler drops R's
  // request (block.rb:16), so the Accept finds nothing (accept.rb:24-29).
  it("a block and unblock racing a new Follow", async () => {
    const w = await run([{ k: "block" }, { k: "unblock" }, { k: "peerFollow" }, { k: "deliver", ...at(0) }]);
    expect(w.stats["exception block-race"]).toBe(1);
    expect((await project(w)).rl?.state).toBe("accepted");
    expect(w.peer.rl).toBeNull();
  });

  // NET-2: L's Accept of R's first request, confirmed before R's new Follow reached Kopje, is applied at R's server to
  // the new request by the account pair (accept.rb:24), while Kopje waits for L's decision on it.
  it("an answer in flight applied to the next generation", async () => {
    const w = await run([
      { k: "lock", locked: true },
      { k: "peerFollow" },
      { k: "deliver", ...at(0) },
      { k: "authorize" },
      { k: "claim" },
      { k: "confirm", ...at(0) },
      { k: "transmit", reached: true, ...at(0) },
      { k: "peerUnfollow" },
      { k: "peerFollow" },
      { k: "deliver", ...at(0) },
      { k: "deliver", ...at(0) },
      { k: "complete", ok: true, ...at(0) },
      { k: "process", ...at(0) },
    ]);
    expect(w.stats["exception net2-answer"]).toBe(1);
    expect((await project(w)).rl?.state).toBe("pending");
    expect(w.peer.rl?.state).toBe("accepted");
  });

  // R follows, undoes it and follows again; Kopje gets the second Follow first, then the first, which it takes as the
  // next generation as Mastodon's fast-forward does (follow.rb:11-29), and then the first's Undo ends the follow.
  it("R's Follows reaching Kopje out of order", async () => {
    const w = await run([
      { k: "peerFollow" },
      { k: "peerUnfollow" },
      { k: "peerFollow" },
      { k: "deliver", ...at(2) },
      { k: "deliver", ...at(0) },
    ]);
    expect(w.stats["exception reordered-follows"]).toBe(1);
    expect((await project(w)).rl).toBeNull();
    expect(w.peer.rl?.state).toBe("accepted");
  });

  // The older Follow arrives after its own Undo, which recorded it as retracted (ID-7): it is ignored, takes nothing
  // over, and so allows no difference.
  it("R's older Follow ignored after its Undo allows no difference", async () => {
    const w = await run([
      { k: "peerFollow" },
      { k: "peerUnfollow" },
      { k: "peerFollow" },
      { k: "deliver", ...at(2) },
      { k: "deliver", ...at(1) },
      { k: "deliver", ...at(0) },
    ]);
    expect(w.trace).toContain("  -> retracted");
    expect(w.olderFollowAfter.size).toBe(0);
    expect(w.stats["exception reordered-follows"]).toBeUndefined();
  });

  // L's lane delivers in order, but R's server processes each body as its own job, and Mastodon's typed Undo of a
  // Follow or a Block matches by the account pair (undo.rb:89-101, 116-126), not by the id it names.
  const cycle = (on: "follow" | "block", off: "unfollow" | "unblock"): Action[] => [
    { k: on },
    { k: "send" },
    { k: off },
    { k: "send" },
    { k: on },
    { k: "send" },
  ];

  // The earlier Undo, processed after the newer Follow (which fast-forwarded the follow, follow.rb:23-29), ends it.
  it("L's earlier Undo processed after its newer Follow at R's server", async () => {
    const w = await run([...cycle("follow", "unfollow"), ...[0, 1, 0].map((i) => ({ k: "process", i }) as const)]);
    expect(w.stats["exception undo-after-newer-follow"]).toBe(1);
    expect((await project(w)).lr).toEqual({ state: "accepted", uri: w.lastFollow });
    expect(w.peer.lr).toBeNull();
  });

  // The newer Undo, processed before its Follow while the earlier follow stood, ends that one instead of being
  // cached (activity.rb:92-98), so the newer Follow then applies; no Follow was POSTed twice.
  it("L's newer Undo processed before its Follow at R's server", async () => {
    const w = await run([
      ...cycle("follow", "unfollow"),
      { k: "unfollow" },
      { k: "send" },
      ...[0, 2, 0, 0].map((i) => ({ k: "process", i }) as const),
    ]);
    expect(w.stats["exception undo-matched-older-follow"]).toBe(1);
    expect(w.stats["exception at-least-once-follow"]).toBeUndefined();
    expect(w.attempts.filter((a) => a.intent.type === "Follow" && a.reached)).toHaveLength(2);
    expect((await project(w)).lr).toBeNull();
    expect(w.peer.lr?.uri).toBe(w.lastFollow);
  });

  it("L's earlier Undo of a Block processed after its newer Block at R's server", async () => {
    const w = await run([...cycle("block", "unblock"), ...[0, 1, 0].map((i) => ({ k: "process", i }) as const)]);
    expect(w.stats["exception undo-after-newer-block"]).toBe(1);
    expect((await project(w)).blockLR).toBe(w.lastBlock);
    expect(w.peer.lBlocks).toBeNull();
  });

  it("L's newer Undo of a Block processed before its Block at R's server", async () => {
    const w = await run([
      ...cycle("block", "unblock"),
      { k: "unblock" },
      { k: "send" },
      ...[0, 2, 0, 0].map((i) => ({ k: "process", i }) as const),
    ]);
    expect(w.stats["exception undo-matched-older-block"]).toBe(1);
    expect((await project(w)).blockLR).toBeNull();
    expect(w.peer.lBlocks).toBe(w.lastBlock);
  });
});

// R's Block of L while R's own follow of L stands or waits (VIS-13, docs/visibility.md R21), as Mastodon handles it on
// both sides: BlockService keeps the blocker's request at R's server (block_service.rb:9-11), and the receiver's Block
// handler keeps it too and ends an accepted follow with a Reject (block.rb:14-16, unfollow_service.rb:35-36).
describe("follow lifecycle: the blocker's own follow", () => {
  it("a remote Block keeps the blocker's pending request", async () => {
    const w = await run([{ k: "lock", locked: true }, { k: "peerFollow" }, { k: "deliver", i: 0 }, { k: "peerBlock" }]);
    expect(w.peer.rl?.state).toBe("requested");
    expect((await project(w)).rl).toEqual({ state: "pending", uri: w.peer.lastRGeneration });
  });

  // Kopje accepted R's Follow, whose request R's Block kept at R's server: the Block ends the follow with one Reject
  // that withdraws it, and the Accept still waiting is superseded and never sent (NET-2), so R's server drops the
  // request (reject.rb) and both sides end with nothing.
  it("a remote Block ends the blocker's accepted follow with one withdrawing Reject", async () => {
    const w = await run([{ k: "peerFollow" }, { k: "peerBlock" }]);
    const sent = w.attempts.filter((a) => a.body !== null).map((a) => a.intent.type);
    expect(sent.filter((type) => type === "Reject")).toHaveLength(1);
    expect(sent).not.toContain("Accept");
    expect(w.peer.rl).toBeNull();
    expect((await project(w)).rl).toBeNull();
  });

  // R's Follow reaches Kopje after R's Block (Mastodon's deliveries are independent jobs) and is taken as any other,
  // as Mastodon's Follow handler refuses only a follower the target blocks (follow.rb:18); no notification of it is
  // written (docs/mastodon-deviations.md).
  it("a Follow that arrives after its follower's Block is taken", async () => {
    const w = await run([{ k: "peerFollow" }, { k: "peerBlock" }, { k: "deliver", i: 1 }]);
    expect(w.trace).toContain("  -> followed");
    expect(w.peer.rl?.state).toBe("accepted");
    const state = await project(w);
    expect(state.rl?.state).toBe("accepted");
    expect(state.notifications).toEqual([]);
  });

  // The accepted risk of a refused refollow: L authorized R's kept request, so R follows L while blocking it; then R's
  // server refollows (RefollowWorker drops the follow without an Undo, refollow_worker.rb:17-19) and FollowService
  // refuses the replacement because R blocks L (follow_service.rb:56-58), which the worker rescues: nothing is sent,
  // and Kopje keeps the follow.
  it("a refollow R's server refuses because R blocks L", async () => {
    const w = await run([
      { k: "lock", locked: true },
      { k: "peerFollow" },
      { k: "peerBlock" },
      { k: "drainPeer" },
      { k: "authorize" },
      { k: "send" },
      { k: "drainPeer" },
      { k: "peerRefollow" },
    ]);
    expect(w.stats["exception refused-refollow"]).toBe(1);
    expect(w.peer.sent.filter((m) => m.activity.type === "Follow")).toHaveLength(1);
    expect((await project(w)).rl).toEqual({ state: "accepted", uri: w.peer.lastRGeneration });
    expect(w.peer.rl).toBeNull();
  });
});

describe("follow lifecycle known defects", () => {
  // #1415, a known defect: R follows (h), undoes it and follows again (g); Kopje gets g first and accepts it, then L
  // removes R from its followers, queueing a Reject of g. The older h arrives next and cancels that Reject (NET-2's
  // cancellation of the pair's answers), and h's Undo ends h, so Kopje holds nothing while R's server, which never
  // gets the Reject, holds g. A Mastodon receiver delivers the Reject (remove_from_followers_service.rb:16-18) and R's
  // server ends g (reject.rb:7). This assertion flips when the fix lands.
  it("an older Follow cancels the Reject of a removed later follow (known defect #1415)", async () => {
    const w = await run([
      { k: "peerFollow" },
      { k: "peerUnfollow" },
      { k: "peerFollow" },
      { k: "deliver", ...at(2) },
      { k: "send" },
      { k: "process", ...at(0) },
      { k: "removeFollower" },
      { k: "deliver", ...at(0) },
      { k: "deliver", ...at(0) },
    ]);
    const [h, g] = w.peer.generations;
    expect(w.cancelledReject.get(g!)?.olderFollow).toBe(h);
    expect(w.stats["exception known-defect-1415"]).toBe(1);
    expect((await project(w)).rl).toBeNull();
    expect(w.peer.rl).toEqual({ state: "accepted", uri: g });
  });
});
