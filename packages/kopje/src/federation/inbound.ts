import { type DocumentLoader, exportSpki, FetchError, type KeyCache, verifyRequestDetailed } from "@fedify/fedify";
import { CryptographicKey } from "@fedify/vocab";
import { Temporal } from "temporal-polyfill";

import {
  type ActivityRef,
  designatedSigner,
  type DocumentRevision,
  type InboundActivity,
  type InboxGate,
  keyFresh,
  type Prefetched,
  type ReceiveAnswer,
  type RemoteActorInput,
  type StoredRemoteKey,
} from "../domain/inbox";
import { flagObjects, MAX_FLAG_OBJECTS, reportComment } from "../domain/reports";
import { fetchableHref } from "../platform/http-url";
import { ACTIVITY_ID_LIMIT, withinIdentityBound } from "../platform/identity-bounds";
import { withinJsonBounds } from "../platform/json-bounds";
import { isActivityPubMediaType, parseMediaType } from "../platform/media-type";
import { callStore } from "../platform/store-client";
import { importPublicKeyPem } from "../security/key-wrap";
import { hasAuthorProof, verifyAuthorProof } from "./author-proof";
import {
  afterRevisionRead,
  createRemoteLoaders,
  type FederationDeps,
  type FederationState,
  type RemoteLoaders,
} from "./federation";
import { typeIs } from "./json-shapes";
import {
  createContextLoader,
  createSafeLoader,
  isTransientLoadError,
  type LoaderDeps,
  loadFailureOf,
  RefusedFetchError,
  type FetchBudget,
  requestBudget,
  requireObjectRoot,
} from "./loader";
import { fetchActor } from "./remote-actor";
import { ACTOR_TYPES, CONVERTED_TYPES, fetchRemoteStatus, parseRemoteStatus, STATUS_TYPES } from "./remote-status";

// Inbound activities: verification, identity, and the shape of each activity, in the Worker; the effects in
// one Store operation (domain/inbox.ts). The same path serves a live POST and the replay of a spooled one.
//
//   1. The Content-Type is an ActivityStreams type (ID-8).
//   2. The HTTP signature verifies with Fedify, against the time the request was received (OPS-1: a spooled request
//      is judged by its spool time). Unsigned or unverifiable: 401, nothing changes (ID-1).
//   3. The body is a JSON object with the ActivityStreams context, a type, an id and an actor (a string or array root
//      is refused, ID-8).
//   4. ID-1: the actor is not local, and it owns the verifying key: its document (fetched, or the stored one while
//      fresh) lists the key id, and the key names no other owner. The activity id has the actor's origin. One
//      exception: a Delete another server relayed (a quoted author's revocation of a quote's stamp, forwarded by the
//      quoting server) is signed by its relayer, who must own that key in the same way; it is applied as the actor's
//      only with the actor's own proof (author-proof.ts), and without one it only has the stamp verified again.
//   5. Per type, what the Store cannot fetch itself: a fresh actor document for Update, the Move target (ID-4), the
//      object of a Create or Update given by id only.
//   6. The Store applies it. It may answer that it needs a document first (the original of a boost it does not have,
//      or that original's author, or the refetch of a stored author a day old): the Worker fetches it within the
//      request's budget, signed as the request's other fetches are (NET-4), and asks again with it (at most
//      MAX_STORE_ROUNDS times). A refetch's failure that may pass is handed on as no document, never answered 503.
//      Every round carries the actor's document and the revision the inbox gate read before it was fetched; the first
//      round that stores the document issues a new revision, so a later round, or a round after another store of the
//      actor committed, stores nothing of it (ID-1, domain/inbox.ts DocumentRevision).
//
// Effects are idempotent by natural keys and retractions (ID-7); a refused activity reserves and records nothing.

export type InboundRequest = {
  url: string;
  method: string;
  headers: [string, string][];
  body: Uint8Array;
  // When the request reached the inbox (the spool time on replay).
  receivedAt: number;
};

// 202: done or deliberately ignored (a format or authorization problem, as Mastodon answers); 401: the signature or
// the signer's identity failed; 415: not an ActivityStreams body; 503: a remote fetch failed in a way that may pass.
export type InboxOutcome = { status: 202 | 401 | 415 | 503; reason: string; jobsPending?: boolean; delivers?: boolean };

export type InboundDeps = Omit<FederationDeps, "domain"> & { domain: string; recipient: string | null };

const AS_CONTEXT = "https://www.w3.org/ns/activitystreams";
// Fedify's default for the Date header, also applied to (created), which it would otherwise allow one minute.
const TIME_WINDOW = { hours: 1 };

type Json = Record<string, unknown>;

// A Create or Update whose object is given by id only (Mastodon's dereference_object!): fetched before the Store runs.
type Dereference = { type: "Dereference"; kind: "Create" | "UpdateStatus"; id: string; object: string; activity: Json };

export type Parsed =
  | { ok: true; actor: string; activity: InboundActivity | Dereference; target: string | null; body: Json }
  // actor: the envelope's single actor, when the envelope is usable but its activity is not one Kopje reads.
  | { ok: false; reason: string; deleteOfSelf?: boolean; actor?: string };

// What processInbox read before the request reaches receiveInbound (federation/inbox.ts): the request's headers (read
// only), the parsed body, whether the Store's instance domain blocks cover its actor, the stored key for the
// signature's key id, the preparation of the request's first fetch, and the revisions of the actor and of a Move's
// target, read before their documents are fetched (the expectations their stores compare).
export type InboundGate = {
  headers: Headers;
  parsed: Parsed;
  domainBlocked: boolean;
  key: InboxGate["key"];
  prefetch: InboxGate["prefetch"];
  revisions: InboxGate["revisions"];
};

// The URL an activity's own handling fetches first, whatever its key (receiveInbound: an actor's Update fetches the
// actor's document, a Dereference its object on the actor's origin, a Move its target), for the inbox gate's fetch
// preparation; null when there is none, or the loader would refuse it (fetchableHref). Only a hint: a wrong one costs
// an unused preparation or one more Store call.
export function fetchesFirst(parsed: Parsed): string | null {
  if (!parsed.ok) {
    return null;
  }
  const { activity, actor, target } = parsed;
  const url =
    activity.type === "UpdateActor"
      ? actor
      : activity.type === "Dereference" && originOf(activity.object) === originOf(actor)
        ? activity.object
        : activity.type === "Move" && target !== null && target !== actor
          ? target
          : null;
  return url === null ? null : fetchableHref(url);
}

// Store calls one activity may take: the activity, its boosted original, and that original's author (or the refetch
// of a stale stored one).
const MAX_STORE_ROUNDS = 3;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function idOf(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  return isObject(value) && typeof value.id === "string" ? value.id : null;
}

// The types read as a Like: Misskey's reactions (a Like with _misskey_reaction or content), EmojiReact and
// EmojiReaction (Misskey's isLike, core/activitypub/type.ts). A favourite; the emoji is not kept (as Mastodon).
const LIKE_TYPES: ReadonlySet<string> = new Set(["Like", "EmojiReact", "EmojiReaction"]);

function refOf(value: unknown): ActivityRef {
  if (!isObject(value)) {
    return { id: idOf(value), type: null, actor: null, object: null, instrument: null };
  }
  const type = typeof value.type === "string" ? value.type : null;
  return {
    id: idOf(value),
    type: type !== null && LIKE_TYPES.has(type) ? "Like" : type,
    actor: idOf(value.actor),
    object: idOf(value.object),
    instrument: idOf(value.instrument),
  };
}

export function originOf(uri: string | null): string | null {
  if (uri === null) {
    return null;
  }
  try {
    const url = new URL(uri);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

export function hasActivityStreamsContext(context: unknown): boolean {
  // An exact comparison with the context and each listed context, not a substring match.
  return context === AS_CONTEXT || (Array.isArray(context) && context.some((c) => c === AS_CONTEXT));
}

// The activity as Mastodon reads it: compacted JSON with the ActivityStreams context, ids as strings or objects with
// an id. Other types and objects Kopje does not store are 'unsupported'.
// The envelope every activity must have before anything reads it: the ActivityStreams context, a string id and type,
// and an actor with an http(s) origin. Shared by the inbox and the cutover rollback's drain, so neither hands on an
// activity the other would ignore.
export function activityEnvelope(
  json: Json,
): { ok: true; actor: string; id: string; type: string } | { ok: false; reason: "no-context" | "incomplete" } {
  if (!hasActivityStreamsContext(json["@context"])) {
    return { ok: false, reason: "no-context" };
  }
  const actor = idOf(json.actor);
  const id = typeof json.id === "string" ? json.id : null;
  const type = typeof json.type === "string" ? json.type : null;
  if (actor === null || originOf(actor) === null || id === null || type === null) {
    return { ok: false, reason: "incomplete" };
  }
  return { ok: true, actor, id, type };
}

export function parseActivity(body: Uint8Array): Parsed {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return { ok: false, reason: "invalid-json" };
  }
  if (!isObject(json)) {
    return { ok: false, reason: "not-an-object" };
  }
  // RES-2: the work of reading an activity is bounded before anything reads it.
  if (!withinJsonBounds(json)) {
    return { ok: false, reason: "too-complex" };
  }
  const object = idOf(json.object);
  const deleteOfSelf = json.type === "Delete" && idOf(json.actor) !== null && object === idOf(json.actor);
  const envelope = activityEnvelope(json);
  if (!envelope.ok) {
    return { ok: false, reason: envelope.reason, deleteOfSelf };
  }
  const { actor, id, type } = envelope;
  const activity = activityOf(type, id, actor, json, object);
  if (activity === null) {
    return { ok: false, reason: "unsupported", deleteOfSelf, actor };
  }
  return { ok: true, actor, activity, target: type === "Move" ? idOf(json.target) : null, body: json };
}

function strings(value: unknown): string[] {
  return (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]).flatMap(
    (entry) => idOf(entry) ?? [],
  );
}

function statusActivity(kind: "Create" | "UpdateStatus", id: string, json: Json): InboundActivity | Dereference | null {
  if (typeof json.object === "string") {
    return { type: "Dereference", kind, id, object: json.object, activity: json };
  }
  const object = parseRemoteStatus(json.object, json);
  return object === null ? null : { type: kind, id, object };
}

function activityOf(
  type: string,
  id: string,
  actor: string,
  json: Json,
  object: string | null,
): InboundActivity | Dereference | null {
  if (LIKE_TYPES.has(type)) {
    return object === null ? null : { type: "Like", id, object };
  }
  switch (type) {
    case "Follow":
    case "Block":
      return object === null ? null : { type, id, object };
    // An Accept of a QuoteRequest names the stamp it grants in result (Accept#accept_quote!: its first value, by id).
    case "Accept": {
      const result: unknown = Array.isArray(json.result) ? json.result[0] : json.result;
      return { type, id, object: refOf(json.object), result: idOf(result) };
    }
    case "Reject":
    case "Undo":
      return { type, id, object: refOf(json.object) };
    case "Move":
      // The object of a Move is the actor itself (Mastodon ignores any other).
      return object === actor ? { type, id, target: { local: "" } } : null;
    // FEP-044f: the object is the quoted status by id; the instrument, the quoting status, by id or inlined (used
    // only as the actor's own object, in the Store, with its own addressing, never the request's).
    case "QuoteRequest": {
      const instrument = idOf(json.instrument);
      return object === null || instrument === null
        ? null
        : {
            type,
            id,
            object,
            instrument,
            embedded: isObject(json.instrument) ? parseRemoteStatus(json.instrument) : null,
          };
    }
    case "Create":
      return statusActivity("Create", id, json);
    case "Update": {
      // An actor updates only itself (ID-6); a status is updated by its author (checked in the Store).
      if (object === actor) {
        return { type: "UpdateActor", id };
      }
      const embedded = isObject(json.object) ? json.object : null;
      if (embedded !== null && typeIs(embedded.type, ACTOR_TYPES)) {
        return null;
      }
      if (embedded !== null && !typeIs(embedded.type, [...STATUS_TYPES, ...CONVERTED_TYPES])) {
        return null;
      }
      return statusActivity("UpdateStatus", id, json);
    }
    case "Delete":
      if (object === null) {
        return null;
      }
      return object === actor
        ? { type: "DeleteActor", id }
        : { type: "Delete", id, object, ...(hasAuthorProof(json) ? { signed: true } : {}) };
    // The target is matched against the actor's own collections by the Store. A Hashtag is named by its name; anything
    // else by its id, as a status (Mastodon's Add and Remove read any other object as one).
    case "Add":
    case "Remove": {
      const target = idOf(json.target);
      if (target === null) {
        return null;
      }
      if (isObject(json.object) && json.object.type === "Hashtag") {
        return typeof json.object.name === "string"
          ? { type, id, target, object: { hashtag: json.object.name } }
          : null;
      }
      return object === null ? null : { type, id, target, object: { status: object } };
    }
    // A report (Mastodon's ActivityPub::Activity::Flag): its id within ACTIVITY_ID_LIMIT, else unsupported; the
    // objects by id, read as reports.ts flagObjects bounds them (MAX_FLAG_OBJECTS, each within ACTIVITY_ID_LIMIT), and
    // the comment cut by reportComment. The Store checks all of it again (fileRemoteReports). Nothing is fetched.
    case "Flag": {
      if (!withinIdentityBound(id, ACTIVITY_ID_LIMIT)) {
        return null;
      }
      const listed: unknown[] = Array.isArray(json.object) ? json.object : [json.object];
      const objects = flagObjects(listed.slice(0, MAX_FLAG_OBJECTS).flatMap((entry) => idOf(entry) ?? []));
      return objects.length === 0 ? null : { type: "Flag", id, objects, content: reportComment(json.content) };
    }
    case "Announce":
      return object === null
        ? null
        : {
            type: "Announce",
            id,
            object,
            embedded: isObject(json.object) ? parseRemoteStatus(json.object) : null,
            to: strings(json.to),
            cc: strings(json.cc),
            published: typeof json.published === "string" ? json.published : null,
            raw: JSON.stringify(json),
          };
    default:
      return null;
  }
}

type ServedKey = { key: CryptographicKey; owner: string };

// A KeyCache over the Store: a key a verified actor document listed, with its owner (remote_keys). A key is served only
// while fresh (listed within 24 hours); anyAge is for the one exception, a Delete by an actor whose document is gone
// (receiveInbound). Fedify verifies with a served key first and, if the signature fails (a rotated key), fetches the
// key anew. Fetched keys are not written back here: the actor document is stored with its keys when the activity is
// applied. The gate's key serves exactly the key id it was read for, judged fresh at this lookup (ID-1); any other key
// id is asked of the Store.
function storedKeys(
  deps: InboundDeps,
  served: Map<string, ServedKey>,
  anyAge: boolean,
  prefetched: InboxGate["key"],
): KeyCache {
  return {
    async get(keyId) {
      const stored = await lookupKey(deps, keyId.href, prefetched);
      if (stored === null || (!stored.fresh && !anyAge)) {
        return undefined;
      }
      try {
        const key = new CryptographicKey({
          id: keyId,
          owner: new URL(stored.owner),
          publicKey: await importPublicKeyPem(stored.pem),
        });
        served.set(keyId.href, { key, owner: stored.owner });
        return key;
      } catch {
        return undefined;
      }
    },
    async set() {},
  };
}

async function lookupKey(
  deps: InboundDeps,
  keyId: string,
  prefetched: InboxGate["key"],
): Promise<StoredRemoteKey | null> {
  if (prefetched?.keyId === keyId) {
    const key = prefetched.stored;
    return key === null ? null : { owner: key.owner, pem: key.pem, fresh: keyFresh(key.fetchedAt, deps.now()) };
  }
  return callStore(() => deps.store().remoteKey(deps.build, { keyId, now: deps.now() }));
}

// A Store refusal inside a loader reaches Fedify as a failed fetch; it is maintenance, so it is rethrown for the caller
// to spool or requeue the request.
function rethrowStoreError(state: FederationState): void {
  if (state.storeError !== null) {
    throw state.storeError;
  }
}

function isGone(result: { status: number } | { error: Error }): boolean {
  const status =
    "status" in result ? result.status : result.error instanceof FetchError ? result.error.response?.status : undefined;
  return status === 404 || status === 410;
}

function isTransientKeyFailure(result: { status: number } | { error: Error }): boolean {
  if ("status" in result) {
    return result.status === 408 || result.status === 429 || result.status >= 500;
  }
  return isTransientLoadError(result.error);
}

// Used where the Store's key is the only evidence: nothing may be fetched.
const NO_FETCH: DocumentLoader = (url) => Promise.reject(new RefusedFetchError(new URL(url), "Not fetched"));

type Verified = { key: CryptographicKey; pem: string } | InboxOutcome;

async function verify(
  deps: InboundDeps,
  request: InboundRequest,
  headers: Headers,
  loaders: { document: DocumentLoader; context: DocumentLoader },
  served: Map<string, ServedKey>,
  anyAge: boolean,
  prefetched: InboxGate["key"],
): Promise<Verified> {
  const signed = new Request(request.url, { method: request.method, headers, body: request.body });
  let verified: Awaited<ReturnType<typeof verifyRequestDetailed>>;
  try {
    verified = await verifyRequestDetailed(signed, {
      documentLoader: loaders.document,
      contextLoader: loaders.context,
      keyCache: storedKeys(deps, served, anyAge, prefetched),
      currentTime: Temporal.Instant.fromEpochMilliseconds(request.receivedAt),
      timeWindow: TIME_WINDOW,
    });
  } catch (error) {
    // A key document whose JSON-LD context could not be loaded.
    const failure = loadFailureOf(error);
    if (failure === undefined) {
      throw error;
    }
    return isTransientLoadError(failure)
      ? { status: 503, reason: "key-unavailable" }
      : { status: 401, reason: "key-unusable" };
  }
  if (verified.verified) {
    const material = verified.key.publicKey;
    return material === null
      ? { status: 401, reason: "invalidSignature" }
      : { key: verified.key, pem: await exportSpki(material) };
  }
  const reason = verified.reason;
  if (reason.type !== "keyFetchError") {
    return { status: 401, reason: reason.type };
  }
  if (isTransientKeyFailure(reason.result)) {
    return { status: 503, reason: "key-unavailable" };
  }
  // Only a key that answers 404 or 410 is gone; anything else (403, a refused document) only fails verification.
  return { status: 401, reason: isGone(reason.result) ? "key-gone" : "key-refused" };
}

export async function receiveInbound(
  deps: InboundDeps,
  request: InboundRequest,
  gate: InboundGate,
): Promise<InboxOutcome> {
  const { headers } = gate;
  const media = parseMediaType(headers.get("content-type") ?? "");
  if (media === null || !isActivityPubMediaType(media)) {
    return { status: 415, reason: "not-activitystreams" };
  }
  const origin = `https://${deps.domain}`;
  // The gate's preparation serves the request's first fetch: its verdict that request alone, its signer every fetch
  // of the request's own loaders.
  const state: FederationState = {
    resolvedUsername: null,
    source: null,
    storeError: null,
    ticket: gate.prefetch?.ticket ?? null,
  };
  const budget = requestBudget(Date.now());
  const loaders = createRemoteLoaders(deps, state, deps.recipient, budget, gate.prefetch?.signer);
  const { parsed, domainBlocked: blocked, key: storedKey, revisions } = gate;

  // The actor of the bounded envelope is judged before anything is verified, whether or not its type is
  // one Kopje reads, so that no activity of a covered actor (an unsupported or malformed one included) is fetched for.
  // An envelope that names no usable actor cannot be judged, and no handler would read it: it is checked with the
  // Store's keys alone, fetching nothing, and answered as ignored. A request without a valid signature stays refused
  // (ID-1), a wrong signature under a stored key included; one signed with a key id the Store does not hold (a cache
  // miss: no key was served) is ignored as it would be once that key were fetched.
  // The gate read the block for exactly parsed.actor.
  if (!parsed.ok) {
    if (parsed.actor === undefined) {
      const none = { document: NO_FETCH, context: NO_FETCH };
      const stored = new Map<string, ServedKey>();
      const checked = await verify(deps, request, headers, none, stored, true, storedKey);
      const missed = "status" in checked && checked.reason === "key-refused" && stored.size === 0;
      return "status" in checked && !missed ? checked : { status: 202, reason: parsed.reason };
    }
    if (blocked) {
      return { status: 202, reason: "domain-blocked" };
    }
  } else if (blocked) {
    return domainBlocked(deps, request, headers, parsed, { origin, state, budget, key: storedKey, revisions });
  }
  const served = new Map<string, ServedKey>();
  let verified = await verify(deps, request, headers, loaders, served, false, storedKey);
  rethrowStoreError(state);
  // The key is gone, and the activity is the actor's own Delete. A stored key of any age may speak for the actor
  // only if the actor document itself answers 404 or 410: a live actor is never deleted with a key it no longer
  // lists. Without a stored key the Delete cannot be verified and is answered 202, as Mastodon does, so that servers
  // do not retry it.
  if ("status" in verified && verified.reason === "key-gone" && parsed.ok && parsed.activity.type === "DeleteActor") {
    const current = await fetchActor(parsed.actor, loaders.document, loaders.context);
    rethrowStoreError(state);
    if (current.kind === "transient") {
      return { status: 503, reason: "actor-unavailable" };
    }
    if (current.kind !== "gone") {
      return verified;
    }
    verified = await verify(deps, request, headers, { document: NO_FETCH, context: NO_FETCH }, served, true, storedKey);
    rethrowStoreError(state);
    if ("status" in verified) {
      // No stored key (nothing is fetched here): the Delete cannot be verified.
      return verified.reason === "key-gone" || verified.reason === "key-refused"
        ? { status: 202, reason: "unknown-actor-deleted" }
        : verified;
    }
  }
  if ("status" in verified) {
    return verified;
  }
  if (!parsed.ok) {
    return { status: 202, reason: parsed.reason };
  }
  const { actor: actorUri, activity } = parsed;

  // ID-1: the actor is remote and owns the key.
  const { key, pem } = verified;
  if (originOf(actorUri) === origin) {
    return { status: 401, reason: "local-actor" };
  }
  if (key.id === null) {
    return { status: 401, reason: "not-key-owner" };
  }
  // The key came from the Store: its owner is the account whose verified document listed it within 24 hours, or, for
  // a gone actor's Delete, at any time. Otherwise the owner's current document, fetched anew, must list this very
  // key: the same id and the same key material.
  const fromStore = served.get(key.id.href);
  const signerUri =
    fromStore !== undefined && fromStore.key === key ? fromStore.owner : (key.ownerId?.href ?? actorUri);
  if (signerUri !== actorUri) {
    return activity.type === "Delete"
      ? relayed(deps, request, {
          activity,
          actorUri,
          signerUri,
          origin,
          key,
          pem,
          fromStore,
          loaders,
          state,
          budget,
          revisions,
        })
      : { status: 401, reason: "not-key-owner" };
  }
  if (originOf(activity.id) !== originOf(actorUri)) {
    return { status: 202, reason: "foreign-id" };
  }
  let actor: RemoteActorInput | null = null;
  if (fromStore?.key !== key || activity.type === "UpdateActor") {
    const owned = await ownerDocument(actorUri, key, pem, loaders);
    rethrowStoreError(state);
    if ("status" in owned) {
      return owned;
    }
    actor = owned.input;
  }
  return apply(deps, {
    activity,
    target: parsed.target,
    actorUri,
    actor,
    origin,
    loaders,
    state,
    budget,
    body: parsed.body,
    revisions,
  });
}

// What an actor an instance domain block covers may still do (R38, VIS-30). Only its cleanups (Delete,
// DeleteActor, Undo, Reject) are admitted, and only when they verify against a key the Store already holds, of any
// age, signed by the actor itself; nothing is fetched, the key and the actor's document included (a rotated key fails
// verification). Everything else is ignored before any fetch, as Mastodon refuses a blocked domain before verifying
// (signature_verification.rb:96-99). The Store's gate (inbox.ts receive) holds the actor the same way in every round.
const DOMAIN_BLOCKED_ADMITS: ReadonlySet<string> = new Set(["Delete", "DeleteActor", "Undo", "Reject"]);

async function domainBlocked(
  deps: InboundDeps,
  request: InboundRequest,
  headers: Headers,
  parsed: Extract<Parsed, { ok: true }>,
  context: {
    origin: string;
    state: FederationState;
    budget: FetchBudget;
    key: InboxGate["key"];
    revisions: InboxGate["revisions"];
  },
): Promise<InboxOutcome> {
  const { actor: actorUri, activity } = parsed;
  if (!DOMAIN_BLOCKED_ADMITS.has(activity.type)) {
    return { status: 202, reason: "domain-blocked" };
  }
  const none = {
    document: NO_FETCH,
    context: NO_FETCH,
    webfinger: NO_FETCH,
    capped: () => NO_FETCH,
    offerSigner: () => {},
  };
  const served = new Map<string, ServedKey>();
  const verified = await verify(deps, request, headers, none, served, true, context.key);
  if ("status" in verified) {
    return verified.reason === "key-gone" || verified.reason === "key-refused"
      ? { status: 401, reason: "key-not-stored" }
      : verified;
  }
  const { key } = verified;
  const fromStore = key.id === null ? undefined : served.get(key.id.href);
  if (fromStore === undefined || fromStore.key !== key || fromStore.owner !== actorUri) {
    return { status: 401, reason: "not-key-owner" };
  }
  if (originOf(actorUri) === context.origin) {
    return { status: 401, reason: "local-actor" };
  }
  if (originOf(activity.id) !== originOf(actorUri)) {
    return { status: 202, reason: "foreign-id" };
  }
  return apply(deps, {
    activity,
    target: parsed.target,
    actorUri,
    actor: null,
    origin: context.origin,
    loaders: none,
    state: context.state,
    budget: context.budget,
    body: parsed.body,
    revisions: context.revisions,
  });
}

// The current document of `uri`, fetched anew, if it lists this very key (the same id and the same key material).
async function ownerDocument(
  uri: string,
  key: CryptographicKey,
  pem: string,
  loaders: RemoteLoaders,
): Promise<{ input: RemoteActorInput } | InboxOutcome> {
  const fetched = await fetchActor(uri, loaders.document, loaders.context);
  if (fetched.kind === "transient") {
    return { status: 503, reason: "actor-unavailable" };
  }
  if (fetched.kind !== "ok") {
    return { status: 401, reason: "actor-unusable" };
  }
  if (fetched.input === null) {
    return { status: 202, reason: "invalid-actor" };
  }
  const keys = withVerifiedReference(fetched.input.keys, fetched.actor.publicKeyIds, key, pem, uri);
  if (!keys.some((listed) => listed.id === key.id?.href && listed.pem === pem)) {
    return { status: 401, reason: "not-key-owner" };
  }
  return { input: { ...fetched.input, keys } };
}

type Relay = {
  activity: Extract<InboundActivity, { type: "Delete" }>;
  actorUri: string;
  signerUri: string;
  origin: string;
  key: CryptographicKey;
  pem: string;
  fromStore: ServedKey | undefined;
  loaders: RemoteLoaders;
  state: FederationState;
  budget: FetchBudget;
  revisions: InboxGate["revisions"];
};

// A Delete relayed by another server: the HTTP signer is not the actor (Mastodon's forward of a stamp's Delete, signed
// by a local sharer of the quoting status). The signer owns its key as any actor must (ID-1, judged on the signer).
// With the actor's own proof, verified against a key the actor's current document embeds, it is applied as the actor's
// Delete; without one it is handed on unproven, which can only have a stamp verified again. A proof that is present but
// does not verify refuses it. Only the Store's relayedDelete applies either: never to an actor, a status or a boost.
// The actor's document is stored under the actor's revision (the gate read it for the envelope's actor, not for the
// signer, whose document is only checked here).
async function relayed(deps: InboundDeps, request: InboundRequest, relay: Relay): Promise<InboxOutcome> {
  const { activity, actorUri, signerUri, origin, key, pem, fromStore, loaders, state, budget, revisions } = relay;
  if (originOf(signerUri) === null || originOf(signerUri) === origin) {
    return { status: 401, reason: "not-key-owner" };
  }
  if (originOf(activity.id) !== originOf(actorUri)) {
    return { status: 202, reason: "foreign-id" };
  }
  if (fromStore?.key !== key) {
    const owned = await ownerDocument(signerUri, key, pem, loaders);
    rethrowStoreError(state);
    if ("status" in owned) {
      return owned;
    }
  }
  const json = JSON.parse(new TextDecoder().decode(request.body)) as Json;
  let actor: RemoteActorInput | null = null;
  let proven = false;
  if (hasAuthorProof(json)) {
    const fetched = await fetchActor(actorUri, loaders.document, loaders.context);
    rethrowStoreError(state);
    if (fetched.kind === "transient") {
      return { status: 503, reason: "actor-unavailable" };
    }
    if (fetched.kind !== "ok" || fetched.input === null) {
      return { status: 401, reason: "actor-unusable" };
    }
    const verdict = await verifyAuthorProof(
      json,
      { id: activity.id, actor: actorUri, object: activity.object },
      JSON.parse(fetched.input.raw) as unknown,
      loaders.context,
    );
    rethrowStoreError(state);
    if (verdict === "transient") {
      return { status: 503, reason: "proof-unavailable" };
    }
    if (!verdict) {
      return { status: 401, reason: "proof-invalid" };
    }
    actor = fetched.input;
    proven = true;
  }
  return apply(deps, {
    activity: {
      type: "RelayedDelete",
      id: activity.id,
      object: activity.object,
      proven,
      ...(proven ? { body: json } : {}),
    },
    target: null,
    actorUri,
    actor,
    origin,
    loaders,
    state,
    budget,
    body: json,
    revisions,
  });
}

type Application = {
  activity: InboundActivity | Dereference;
  target: string | null;
  actorUri: string;
  actor: RemoteActorInput | null;
  origin: string;
  loaders: RemoteLoaders;
  state: FederationState;
  budget: FetchBudget;
  // The activity as received, for an author proof the Store asks to have verified (need 'proof').
  body: Json;
  // What the inbox gate read before any document was fetched (InboundGate).
  revisions: InboxGate["revisions"];
};

// Steps 5 and 6: what the type needs, and the Store.
async function apply(deps: InboundDeps, application: Application): Promise<InboxOutcome> {
  const { target, actorUri, actor, origin, loaders, state, budget, revisions } = application;
  const activity = application.activity;
  const ready = await prepare(activity, target, actorUri, origin, loaders, revisions.target);
  rethrowStoreError(state);
  if (!("type" in ready)) {
    return ready;
  }
  let prepared: InboundActivity = ready;
  const refreshRevisions: NonNullable<Prefetched["revisions"]> = {};
  const prefetched: Prefetched = { statuses: {}, actors: {}, revisions: refreshRevisions };
  // The answer prepared the need's fetch: its verdict serves the next request alone, its signer the loaders the need
  // designates. A document the Store wants signed otherwise (an Add's pinned status: by a local follower of its
  // author, else by the instance actor, never the inbox's recipient) is fetched with that key, within the same budget
  // (DATA-7); any other with the request's loaders, which take the signer while they have none resolved. A need
  // without a preparation (a Store of another build) is fetched as without one: the loaders read what they lack.
  const loadersFor = (need: NonNullable<ReceiveAnswer["need"]>): RemoteLoaders => {
    const prepared = need.prefetch ?? null;
    state.ticket = prepared?.ticket ?? null;
    if (need.signer === undefined) {
      if (prepared !== null) {
        loaders.offerSigner(prepared.signer);
      }
      return loaders;
    }
    return createRemoteLoaders(deps, state, designatedSigner(need.signer), budget, prepared?.signer);
  };
  let result: ReceiveAnswer | undefined;
  for (let round = 0; round < MAX_STORE_ROUNDS; round++) {
    result = await callStore(() =>
      deps.store().receiveActivity(deps.build, {
        now: deps.now(),
        origin,
        actorUri,
        actor,
        actorRevision: revisions.actor,
        activity: prepared,
        recipient: deps.recipient,
        prefetched,
      }),
    );
    const need = result.need;
    if (need === undefined) {
      break;
    }
    // Only a proven body may be forwarded (proveDelete); an unproven Delete still applies as its actor's.
    if (need.kind === "proof") {
      if (prepared.type !== "Delete") {
        break;
      }
      const proof = await proveDelete(application.body, prepared, actorUri, loadersFor(need));
      rethrowStoreError(state);
      if (proof === "transient") {
        return { status: 503, reason: "proof-unavailable" };
      }
      prepared = proof ? { ...prepared, proven: application.body } : { ...prepared, signed: false };
      result = undefined;
      continue;
    }
    // A need that carries a revision read in this round's answer, after the request's first fetches, takes a fresh
    // memo: the request's may hold this document as fetched before that read (afterRevisionRead).
    const needLoaders = loadersFor(need);
    const fetched = await fetchNeeded(
      need,
      origin,
      need.revision === undefined ? needLoaders : afterRevisionRead(needLoaders),
    );
    rethrowStoreError(state);
    if (fetched === "transient" && !(need.kind === "actor" && need.refresh === true)) {
      return { status: 503, reason: "object-unavailable" };
    }
    if (need.kind === "status") {
      prefetched.statuses[need.uri] = fetched as Prefetched["statuses"][string];
    } else {
      prefetched.actors[need.uri] = fetched === "transient" ? null : (fetched as Prefetched["actors"][string]);
      if (need.revision !== undefined) {
        refreshRevisions[need.uri] = need.revision;
      }
    }
    result = undefined;
  }
  if (result === undefined) {
    return { status: 202, reason: "too-many-fetches" };
  }
  if (result.retry === true) {
    return { status: 503, reason: result.reason };
  }
  return { status: 202, reason: result.reason, jobsPending: result.jobsPending, delivers: result.delivers === true };
}

// Whether the author proof the body of the actor's own Delete carries verifies against a key the actor's current
// document embeds (author-proof.ts); 'transient' when that may change.
async function proveDelete(
  body: Json,
  activity: { id: string; object: string },
  actorUri: string,
  loaders: RemoteLoaders,
): Promise<boolean | "transient"> {
  const fetched = await fetchActor(actorUri, loaders.document, loaders.context);
  if (fetched.kind === "transient") {
    return "transient";
  }
  if (fetched.kind !== "ok" || fetched.input === null) {
    return false;
  }
  return verifyAuthorProof(
    body,
    { id: activity.id, actor: actorUri, object: activity.object },
    JSON.parse(fetched.input.raw) as unknown,
    loaders.context,
  );
}

// A document the Store asked for, fetched through the request's loaders: a status (null if it cannot be one) or an
// actor (null if it cannot be stored, 'gone' if it answered 404 or 410). A local URI is never fetched.
async function fetchNeeded(
  need: NonNullable<ReceiveAnswer["need"]>,
  origin: string,
  loaders: RemoteLoaders,
): Promise<Prefetched["statuses"][string] | Prefetched["actors"][string] | "transient"> {
  if (originOf(need.uri) === null || originOf(need.uri) === origin) {
    return null;
  }
  if (need.kind === "status") {
    const fetched = await fetchRemoteStatus(need.uri, loaders.document);
    return fetched.kind === "transient" ? "transient" : fetched.kind === "ok" ? fetched.status : null;
  }
  const fetched = await fetchActor(need.uri, loaders.document, loaders.context);
  if (fetched.kind === "transient" || fetched.kind === "gone") {
    return fetched.kind;
  }
  return fetched.kind === "ok" ? fetched.input : null;
}

// An actor may list a key by reference (publicKey: "<key URL>") rather than embed it. Fedify has just resolved that
// reference to verify the signature, so the verified key is reused instead of fetched again: it is kept if the actor
// lists its id, the key names no other owner, and its id has the actor's origin.
function withVerifiedReference(
  keys: { id: string; pem: string }[],
  listed: URL[],
  key: CryptographicKey,
  pem: string,
  actorUri: string,
): { id: string; pem: string }[] {
  const id = key.id?.href;
  if (
    id === undefined ||
    keys.some((k) => k.id === id) ||
    !listed.some((url) => url.href === id) ||
    (key.ownerId !== null && key.ownerId.href !== actorUri) ||
    originOf(id) !== originOf(actorUri)
  ) {
    return keys;
  }
  return [...keys, { id, pem }];
}

// What a type needs beyond the activity itself. targetRevision: a Move target's, read by the inbox gate before this
// fetch, stored with the document it compares against.
async function prepare(
  activity: InboundActivity | Dereference,
  target: string | null,
  actorUri: string,
  origin: string,
  loaders: RemoteLoaders,
  targetRevision: DocumentRevision,
): Promise<InboundActivity | InboxOutcome> {
  if (activity.type === "Dereference") {
    // The object of the actor's own activity: only on the actor's origin (Mastodon's permitted_origin).
    if (originOf(activity.object) !== originOf(actorUri)) {
      return { status: 202, reason: "foreign-object" };
    }
    const fetched = await fetchRemoteStatus(activity.object, loaders.document, activity.activity);
    if (fetched.kind === "transient") {
      return { status: 503, reason: "object-unavailable" };
    }
    if (fetched.kind === "unusable") {
      return { status: 202, reason: "unusable-object" };
    }
    return { type: activity.kind, id: activity.id, object: fetched.status };
  }
  if (activity.type !== "Move") {
    return activity;
  }
  if (target === null || target === actorUri) {
    return { status: 202, reason: "no-target" };
  }
  if (originOf(target) === origin) {
    return { ...activity, target: { local: target } };
  }
  // ID-4: the target is fetched anew and must list the actor among its aliases.
  const fetched = await fetchActor(target, loaders.document, loaders.context);
  if (fetched.kind === "transient") {
    return { status: 503, reason: "target-unavailable" };
  }
  if (fetched.kind !== "ok" || fetched.input === null) {
    return { status: 202, reason: "unknown-target" };
  }
  if (!fetched.actor.aliasIds.some((alias) => alias.href === actorUri)) {
    return { status: 202, reason: "not-alias" };
  }
  return { ...activity, target: { document: fetched.input, revision: targetRevision } };
}

// The cutover rollback's check of a spooled request (docs/cutover-runbook.md): the same signature verification and
// key ownership rule as receiveInbound (ID-1, against the time the request was spooled, OPS-1), without the Store:
// keys are fetched anew, unsigned, within the request budget and the JSON bounds, and nothing is recorded. Only the
// request is judged here; the legacy instance applies the activity. transient: may pass if tried again later.
export type SpoolVerification =
  | { ok: true; actor: string; activity: Json }
  | { ok: false; transient: boolean; reason: string };

export async function verifySpooledRequest(
  loader: LoaderDeps,
  domain: string,
  request: InboundRequest,
): Promise<SpoolVerification> {
  const headers = new Headers(request.headers);
  const media = parseMediaType(headers.get("content-type") ?? "");
  if (media === null || !isActivityPubMediaType(media)) {
    return { ok: false, transient: false, reason: "not-activitystreams" };
  }
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(request.body));
  } catch {
    return { ok: false, transient: false, reason: "invalid-json" };
  }
  if (!isObject(json) || !withinJsonBounds(json)) {
    return { ok: false, transient: false, reason: "not-an-object" };
  }
  // What Kopje's inbox would ignore is not handed to the legacy instance either.
  const envelope = activityEnvelope(json);
  if (!envelope.ok) {
    return { ok: false, transient: false, reason: envelope.reason };
  }
  const actorUri = envelope.actor;
  if (originOf(actorUri) === `https://${domain}`) {
    return { ok: false, transient: false, reason: "invalid-actor" };
  }
  if (originOf(envelope.id) !== originOf(actorUri)) {
    return { ok: false, transient: false, reason: "foreign-id" };
  }
  const deps = { ...loader, budget: requestBudget(Date.now()) };
  const bounded =
    (base: DocumentLoader): DocumentLoader =>
    async (url, options) => {
      const remote = await base(url, options);
      if (!withinJsonBounds(remote.document)) {
        throw new RefusedFetchError(new URL(remote.documentUrl), "Document exceeds the JSON bounds");
      }
      return remote;
    };
  const documentLoader = requireObjectRoot(bounded(createSafeLoader(deps)));
  const contextLoader = bounded(createContextLoader(deps));
  const signed = new Request(request.url, { method: request.method, headers, body: request.body });
  let verified: Awaited<ReturnType<typeof verifyRequestDetailed>>;
  try {
    verified = await verifyRequestDetailed(signed, {
      documentLoader,
      contextLoader,
      currentTime: Temporal.Instant.fromEpochMilliseconds(request.receivedAt),
      timeWindow: TIME_WINDOW,
    });
  } catch (error) {
    const failure = loadFailureOf(error);
    if (failure === undefined) {
      throw error;
    }
    return { ok: false, transient: isTransientLoadError(failure), reason: "key-unusable" };
  }
  if (!verified.verified) {
    const reason = verified.reason;
    return reason.type === "keyFetchError"
      ? { ok: false, transient: isTransientKeyFailure(reason.result), reason: "key-unavailable" }
      : { ok: false, transient: false, reason: reason.type };
  }
  const { key } = verified;
  if (key.publicKey === null || key.id === null || (key.ownerId !== null && key.ownerId.href !== actorUri)) {
    return { ok: false, transient: false, reason: "not-key-owner" };
  }
  const pem = await exportSpki(key.publicKey);
  const fetched = await fetchActor(actorUri, documentLoader, contextLoader);
  if (fetched.kind === "transient") {
    return { ok: false, transient: true, reason: "actor-unavailable" };
  }
  if (fetched.kind !== "ok" || fetched.input === null) {
    return { ok: false, transient: false, reason: "actor-unusable" };
  }
  const keys = withVerifiedReference(fetched.input.keys, fetched.actor.publicKeyIds, key, pem, actorUri);
  if (!keys.some((listed) => listed.id === key.id?.href && listed.pem === pem)) {
    return { ok: false, transient: false, reason: "not-key-owner" };
  }
  return { ok: true, actor: actorUri, activity: json };
}
