// A remote author's statuses, their deletion and their retractions, as two reference models in plain TypeScript
// (test/status-delete.test.ts drives the Store and the API against them):
//
// - Policy: Kopje's documented rules, written from the docs and never from src/: docs/threat-model.md ID-7 (its status
//   paragraph: the Update watermark, the 5-minute skew, the retractions of a Delete, the cap, local boosts withdrawn
//   once and the 404s while a removal runs), ID-6 (the authorization table: Create, Update and Delete of statuses),
//   RES-6 (a remote status's removal in bounded batches after its hide), VIS-3 (a proven Delete forwarded through the
//   local boosts, and the Undo of an unboost staged by its job) and docs/mastodon-deviations.md ("Forwarded deletes").
//   It holds each status by uri, the live retractions, the local account L's notifications and reactions, the delete
//   jobs, and Kopje's outbound intents with their deliveries in each lane.
// - Peer: the author R's server, Mastodon v4.5.11, as a sender only (each rule cites the file and line it models): the
//   statuses it posted, edited and deleted, and every message it sent, each an independent delivery job.
//
// A change to a status Create, Update or Delete rule in docs/threat-model.md changes this file with it.

// ---------------------------------------------------------------------------------------------------------------
// Shared vocabulary
// ---------------------------------------------------------------------------------------------------------------

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// ID-7: "A valid Delete or Undo that arrives before its target is recorded for 30 days".
export const RETRACTION_TTL_MS = 30 * DAY;
// ID-7: "an Update dated more than 5 minutes ahead of the clock is ignored".
export const VERSION_SKEW_MS = 5 * MINUTE;
// Mastodon's Update#object_too_old? (OBJECT_AGE_THRESHOLD = 1.day, update.rb:5,44-48), which Kopje follows for an
// Update of a status it does not hold (updateRemoteStatus's doc comment: "creates it if it is recent").
export const UPDATE_CREATES_WITHIN_MS = DAY;

// The ANY_ACTOR row of ID-7: "the Delete of a stored status or boost is also recorded for every actor".
export const ANY = "*";

// A hidden status's content is empty (the hide clears its content and audience, RES-6).
export type Snapshot = { content: "A" | "B" | "C" | ""; sensitive: boolean; media: boolean };

export const sameSnapshot = (a: Snapshot, b: Snapshot) =>
  a.content === b.content && a.sensitive === b.sensitive && a.media === b.media;

// A status object as a sender writes it (the parts the rules read).
export type Obj = {
  uri: string;
  attributedTo: string | null;
  snapshot: Snapshot;
  published: number | null;
  updated: number | null;
  inReplyTo: string | null;
};

export type Msg =
  | { type: "Create"; id: string; object: Obj }
  | { type: "Update"; id: string; object: Obj }
  | { type: "Delete"; id: string; object: string; proven: boolean };

export type Answer = { applied: boolean; reason: string; retry?: true };

const originOf = (uri: string) => new URL(uri).origin;
const iso = (ms: number) => new Date(ms).toISOString();

// ---------------------------------------------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------------------------------------------

// A status_edits row: the status as it was, and the time it names (the original's publication, else the edit's).
export type Version = { snapshot: Snapshot; at: string };

export type Stored = {
  author: string;
  snapshot: Snapshot;
  // statuses.published_at, as stored (never in the future).
  published: string;
  // statuses.remote_version (ID-7: "the last accepted version ... kept as the remote wrote it"), as an ISO time.
  version: string;
  editedAt: string | null;
  // status_edits rows, in order: a significant change records the original first, then each version.
  history: Version[];
  // The hide of a removal that runs (RES-6, VIS-1): statuses.withdrawn.
  withdrawn: boolean;
  inReplyTo: string | null;
  // Its in_reply_to_id is set (the parent was stored, and not hidden, when either arrived).
  linked: boolean;
};

export type Lane = "fans" | "remote";
export const LANES: readonly Lane[] = ["fans", "remote"];

export type IntentType = "Like" | "UndoLike" | "Announce" | "UndoAnnounce" | "Forward";

export type Intent = {
  seq: number;
  type: IntentType;
  // A favourite's or a boost's generation symbol, or the forwarded status's uri.
  ref: string;
  superseded: boolean;
  // waiting: recorded with no targets (a retraction its job stages); staged: targets recorded, not yet expanded;
  // expanded: its deliveries are rows in the lanes.
  stage: "waiting" | "staged" | "expanded";
};

export type Row = { intent: number; state: "queued" | "pending" | "leased"; token: string | null; until: number };

export type Notification = { sym: string; type: "mention" | "update"; status: string; from: string };

export type Boost = { sym: string; withdrawn: boolean };

// key: inbound_jobs.key, the Store's id of the status or the boost, bound by the harness once the Store shows it.
export type Job = {
  kind: "status" | "boost";
  ref: string;
  createdAt: number;
  key: string | null;
  doneAt: number | null;
};

// RES-6: a round of the Store's jobs runs at most this many batches (JOB_BATCHES_PER_RUN), each of the next job.
export const JOB_BATCHES_PER_ROUND = 4;

export type ClaimResult = { leased: { lane: Lane; intent: Intent }[]; dropped: Intent[] };

export class Policy {
  statuses = new Map<string, Stored>();
  // Live and expired retractions of the pool, by `${actor} ${uri}`: their expires_at.
  retractions = new Map<string, number>();
  // R's filler retractions (the cap variant): how many, and when they expire.
  fillers = { count: 0, expires: 0 };
  notifications: Notification[] = [];
  favourite: string | null = null;
  boosts: Boost[] = [];
  jobs: Job[] = [];
  intents: Intent[] = [];
  lanes = new Map<Lane, Row[]>(LANES.map((lane) => [lane, []]));
  // Every Like generation that was ever recorded, every one an explicit unfavourite removed, and the boosts kept when a
  // proven Delete of s1 was accepted.
  readonly likes: string[] = [];
  readonly unliked: string[] = [];
  keptAtForward: string[] = [];
  private seq = 0;
  private symbols = 0;

  constructor(
    readonly ids: { l: string; r: string; s1: string; s2: string },
    readonly cap: number,
  ) {}

  private sym(prefix: string) {
    return `${prefix}${++this.symbols}`;
  }

  // ---- retractions (ID-7) ----

  private key = (actor: string, uri: string) => `${actor} ${uri}`;

  isLive(actor: string, uri: string, now: number): boolean {
    return (this.retractions.get(this.key(actor, uri)) ?? -Infinity) > now;
  }

  // ID-7: "a status whose Delete was recorded takes no Update", and "nobody ... creates or updates that uri again".
  private isDeleted(actor: string, uri: string, now: number): boolean {
    return this.isLive(actor, uri, now) || this.isLive(ANY, uri, now);
  }

  private live(actor: string, now: number): number {
    let n = 0;
    for (const [key, expires] of this.retractions) {
      if (key.startsWith(`${actor} `) && expires > now) {
        n++;
      }
    }
    return actor === this.ids.r && this.fillers.expires > now ? n + this.fillers.count : n;
  }

  // ID-7: "only an id of the actor's own origin", "at most MAX_RETRACTIONS_PER_ACTOR live ones per actor"; a live one
  // is renewed whatever the count.
  private canRetract(actor: string, uri: string, now: number): boolean {
    return this.isLive(actor, uri, now) || this.live(actor, now) + 1 <= this.cap;
  }

  private retract(actor: string, uri: string, now: number): boolean {
    if (originOf(actor) !== originOf(uri) || !this.canRetract(actor, uri, now)) {
      return false;
    }
    this.retractions.set(this.key(actor, uri), now + RETRACTION_TTL_MS);
    return true;
  }

  // ---- receive ----

  receive(actor: string, msg: Msg, now: number): Answer & { jobsPending?: boolean } {
    switch (msg.type) {
      case "Create":
        return this.create(actor, msg.object, now);
      case "Update":
        return this.update(actor, msg.object, now);
      case "Delete":
        return this.delete(actor, msg, now);
    }
  }

  // ID-6: "Create needs the actor's origin and no other attributedTo"; ID-7: a recorded Delete keeps it from
  // appearing; a status exists once per uri, a repeat adds nothing.
  private create(actor: string, o: Obj, now: number): Answer {
    if (originOf(o.uri) !== originOf(actor)) {
      return { applied: false, reason: "foreign-object" };
    }
    if (o.attributedTo !== null && o.attributedTo !== actor) {
      return { applied: false, reason: "not-author" };
    }
    if (this.isDeleted(actor, o.uri, now)) {
      return { applied: false, reason: "retracted" };
    }
    const stored = this.statuses.get(o.uri);
    if (stored !== undefined) {
      // A redelivery to the shared inbox changes nothing (ID-7).
      return { applied: false, reason: stored.author === actor ? "duplicate" : "not-author" };
    }
    // A time as stored is never in the future; the version is the remote's, unclamped (ID-7).
    const clamp = (t: number | null) => (t === null || t > now ? now : t);
    const published = clamp(o.published);
    const updated = o.updated === null ? null : clamp(o.updated);
    const declared = o.updated ?? o.published;
    const version = declared === null || declared > now + VERSION_SKEW_MS ? published : declared;
    const parent = o.inReplyTo === null ? undefined : this.statuses.get(o.inReplyTo);
    this.statuses.set(o.uri, {
      author: actor,
      snapshot: o.snapshot,
      published: iso(published),
      version: iso(version),
      editedAt: updated !== null && updated !== published ? iso(updated) : null,
      history: [],
      withdrawn: false,
      inReplyTo: o.inReplyTo,
      linked: parent !== undefined && !parent.withdrawn,
    });
    // Replies that arrived before it are linked to it now.
    for (const reply of this.statuses.values()) {
      if (reply.inReplyTo === o.uri && !reply.linked) {
        reply.linked = true;
      }
    }
    // Every object of the pool mentions and addresses L: L is notified of it.
    this.notifications.push({ sym: this.sym("n"), type: "mention", status: o.uri, from: actor });
    return { applied: true, reason: "created" };
  }

  // ID-6: "Update ... require[s] the object's current author"; ID-7: the watermark, the skew, the retraction; an
  // Update of a status Kopje does not hold creates it when it is recent (Mastodon's update.rb:34-37).
  private update(actor: string, o: Obj, now: number): Answer {
    if (originOf(o.uri) !== originOf(actor)) {
      return { applied: false, reason: "foreign-object" };
    }
    if (o.attributedTo !== null && o.attributedTo !== actor) {
      return { applied: false, reason: "not-author" };
    }
    if (this.isDeleted(actor, o.uri, now)) {
      return { applied: false, reason: "retracted" };
    }
    if (o.updated !== null && o.updated > now + VERSION_SKEW_MS) {
      return { applied: false, reason: "future" };
    }
    const stored = this.statuses.get(o.uri);
    if (stored === undefined) {
      if (o.published !== null && o.published < now - UPDATE_CREATES_WITHIN_MS) {
        return { applied: false, reason: "unknown-object" };
      }
      return this.create(actor, o, now);
    }
    if (stored.author !== actor) {
      return { applied: false, reason: "not-author" };
    }
    const watermark = Date.parse(stored.version);
    // An older version changes nothing; one that names no newer version (none, or the same) is the implicit Update,
    // which here (no poll, no policy) changes nothing either.
    if (o.updated === null || o.updated <= watermark) {
      return { applied: false, reason: "stale" };
    }
    // A content or media change is significant (an edit row, the original first, and an `update` notification to each
    // local booster); a sensitive flip alone is not. Either way the watermark moves (ID-7).
    const significant = stored.snapshot.content !== o.snapshot.content || stored.snapshot.media !== o.snapshot.media;
    if (significant && stored.history.length === 0) {
      stored.history.push({ snapshot: stored.snapshot, at: stored.published });
    }
    stored.snapshot = o.snapshot;
    stored.version = iso(o.updated);
    if (significant) {
      stored.editedAt = iso(Math.min(o.updated, now));
      stored.history.push({ snapshot: o.snapshot, at: stored.editedAt });
      // A local booster of a kept boost is notified, the previous notification replaced by a new one; nobody is
      // notified of a status they may not see (VIS-1: a hidden one).
      if (o.uri === this.ids.s1 && !stored.withdrawn && this.boosts.some((b) => !b.withdrawn)) {
        this.notifications = this.notifications.filter((n) => !(n.type === "update" && n.status === o.uri));
        this.notifications.push({ sym: this.sym("n"), type: "update", status: o.uri, from: actor });
      }
    }
    return { applied: true, reason: significant ? "edited" : "updated" };
  }

  // ID-6: "Delete [requires] the stored status's author (a refused Delete records no retraction)"; ID-7: an unknown
  // object is recorded for its actor only; a stored one also for every actor; at the cap a stored one answers 503 and
  // an unknown one is not recorded. RES-6 and VIS-3: the hide, the forwards, then the removal.
  private delete(actor: string, msg: Msg & { type: "Delete" }, now: number): Answer & { jobsPending?: boolean } {
    const uri = msg.object;
    if (originOf(uri) !== originOf(actor)) {
      return { applied: false, reason: "foreign-object" };
    }
    const stored = this.statuses.get(uri);
    if (stored !== undefined && stored.author !== actor) {
      return { applied: false, reason: "not-author" };
    }
    if (stored === undefined) {
      // Decision (a): only the actor's own retraction is renewed; the `*` deadline stays.
      return this.retract(actor, uri, now)
        ? { applied: true, reason: "retraction-recorded" }
        : { applied: false, reason: "retraction-cap" };
    }
    if (!this.canRetract(actor, uri, now)) {
      return { applied: false, reason: "retraction-cap", retry: true };
    }
    this.retract(actor, uri, now);
    this.retractions.set(this.key(ANY, uri), now + RETRACTION_TTL_MS);
    const first = !stored.withdrawn;
    let job = this.jobs.find((j) => j.kind === "status" && j.ref === uri && j.doneAt === null);
    if (first) {
      job = { kind: "status", ref: uri, createdAt: now, key: null, doneAt: null };
      this.jobs.push(job);
      stored.withdrawn = true;
      stored.snapshot = { ...stored.snapshot, content: "" };
      // VIS-3: a proven Delete of a public original is forwarded once through each kept local boost, recorded by the
      // request that created the job, which then runs no batch: the job stages the forward before any boost is
      // withdrawn.
      const kept = this.boosts.filter((b) => !b.withdrawn);
      if (msg.proven && uri === this.ids.s1 && kept.length > 0) {
        this.keptAtForward = kept.map((b) => b.sym);
        this.record("Forward", uri, "waiting");
        return { applied: true, reason: "status-deleted", jobsPending: true };
      }
    }
    // A batch runs in the request; the world is small, so it finishes the removal.
    this.removal(job!, now);
    return { applied: true, reason: "status-deleted", jobsPending: false };
  }

  // A removal to its end (RES-6), as one batch does it in this small world: the forwards staged, then the local
  // boosts withdrawn (each Undo recorded once: a withdrawn boost's continues), the boosts, the favourites, the
  // notifications and the status deleted; its reply unlinked. The Likes sent stay (decision d).
  private removal(job: Job, now: number): void {
    const uri = job.ref;
    for (const intent of this.intents) {
      if (intent.type === "Forward" && intent.ref === uri && intent.stage === "waiting") {
        intent.stage = "staged";
      }
    }
    if (uri === this.ids.s1) {
      for (const boost of this.boosts) {
        if (boost.withdrawn) {
          this.stageUndo(boost.sym);
        } else {
          this.supersede("Announce", boost.sym);
          this.record("UndoAnnounce", boost.sym, "staged");
        }
      }
      this.boosts = [];
      this.favourite = null;
    }
    this.notifications = this.notifications.filter((n) => n.status !== uri);
    this.statuses.delete(uri);
    for (const reply of this.statuses.values()) {
      if (reply.inReplyTo === uri) {
        reply.linked = false;
      }
    }
    job.doneAt = now;
  }

  private stageUndo(boost: string): void {
    const undo = this.intents.find((i) => i.type === "UndoAnnounce" && i.ref === boost);
    if (undo !== undefined && undo.stage === "waiting") {
      undo.stage = "staged";
    }
  }

  // One round of the Store's jobs: the next JOB_BATCHES_PER_ROUND jobs, oldest first, then by key (nextJob's order:
  // created_at, kind, key), each a batch that runs it to its end (the world is small). Returns whether a job is left.
  runJobs(now: number): boolean {
    const pending = this.jobs
      .filter((j) => j.doneAt === null)
      .map((job) => {
        if (job.key === null) {
          throw new Error(`the job of ${job.ref} has no key bound`);
        }
        return { job, key: job.key };
      })
      .toSorted((a, b) => a.job.createdAt - b.job.createdAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    for (const { job } of pending.slice(0, JOB_BATCHES_PER_ROUND)) {
      if (job.kind === "status") {
        this.removal(job, now);
      } else {
        // An unboost's job stages its Undo, then deletes the boost.
        this.stageUndo(job.ref);
        this.boosts = this.boosts.filter((b) => b.sym !== job.ref);
        job.doneAt = now;
      }
    }
    return pending.length > JOB_BATCHES_PER_ROUND;
  }

  // ---- L's API actions on s1 (ID-7's local reactions) ----

  private s1Visible(): boolean {
    const s1 = this.statuses.get(this.ids.s1);
    return s1 !== undefined && !s1.withdrawn;
  }

  // A favourite of a visible status: one per account and status, its Like recorded once.
  favouriteS1(): { status: number; created: string | null } {
    if (!this.s1Visible()) {
      return { status: 404, created: null };
    }
    if (this.favourite !== null) {
      return { status: 200, created: null };
    }
    this.favourite = this.sym("fav");
    this.likes.push(this.favourite);
    this.record("Like", this.favourite, "expanded");
    return { status: 200, created: this.favourite };
  }

  // Decision (d): an explicit unfavourite that removes a favourite records its Undo(Like), also when it answers 404
  // because the status is being removed (it is found by its id, ID-7's "an unreblog, unfavourite ... answers 404").
  unfavouriteS1(): number {
    const s1 = this.statuses.get(this.ids.s1);
    if (s1 === undefined) {
      return 404;
    }
    if (this.favourite !== null) {
      this.supersede("Like", this.favourite);
      this.record("UndoLike", this.favourite, "expanded");
      this.unliked.push(this.favourite);
      this.favourite = null;
    }
    return s1.withdrawn ? 404 : 200;
  }

  // A boost of a visible status: one kept boost per account and status; a new one after an unboost is a new key.
  reblogS1(): { status: number; created: string | null } {
    if (!this.s1Visible()) {
      return { status: 404, created: null };
    }
    if (this.boosts.some((b) => !b.withdrawn)) {
      return { status: 200, created: null };
    }
    const sym = this.sym("boost");
    this.boosts.push({ sym, withdrawn: false });
    this.record("Announce", sym, "expanded");
    return { status: 200, created: sym };
  }

  // ID-7: an unboost withdraws the kept boost once, records its Undo with no targets for its job to stage, and answers
  // 404 while the original's removal runs.
  unreblogS1(now: number): number {
    if (!this.s1Visible()) {
      return 404;
    }
    const kept = this.boosts.find((b) => !b.withdrawn);
    if (kept !== undefined) {
      kept.withdrawn = true;
      this.supersede("Announce", kept.sym);
      this.record("UndoAnnounce", kept.sym, "waiting");
      this.jobs.push({ kind: "boost", ref: kept.sym, createdAt: now, key: null, doneAt: null });
    }
    return 200;
  }

  // ---- outbound intents and their lanes (NET-2) ----

  private supersede(type: IntentType, ref: string): void {
    for (const intent of this.intents) {
      if (intent.type === type && intent.ref === ref) {
        intent.superseded = true;
      }
    }
  }

  private record(type: IntentType, ref: string, stage: Intent["stage"]): Intent {
    const intent: Intent = {
      seq: ++this.seq,
      type,
      ref,
      superseded: false,
      stage: stage === "expanded" ? "staged" : stage,
    };
    this.intents.push(intent);
    if (stage === "expanded") {
      this.expandAll();
    }
    return intent;
  }

  // Expansion goes in intent id order (NET-2's lanes keep that order): a new intent's targets are expanded together
  // with every staged one before it, as a claim expands them.
  private expandAll(): void {
    for (const intent of this.intents.toSorted((a, b) => a.seq - b.seq)) {
      if (intent.stage === "staged") {
        this.expand(intent);
      }
    }
  }

  // The lanes an intent goes to. A Like and its Undo name the author (its shared inbox: the remote lane); an Announce
  // goes to the booster's followers (FAN, the fans lane) and the author; a boost's Undo and a forward to the
  // followers and the boost's receipts and earlier rows (VIS-3), which always include the author's.
  private targets(intent: Intent): Lane[] {
    return intent.type === "Like" || intent.type === "UndoLike" ? ["remote"] : ["fans", "remote"];
  }

  private expand(intent: Intent): void {
    intent.stage = "expanded";
    for (const lane of this.targets(intent)) {
      const rows = this.lanes.get(lane)!;
      rows.push({ intent: intent.seq, state: rows.length === 0 ? "pending" : "queued", token: null, until: 0 });
    }
  }

  intentOf(seq: number): Intent {
    return this.intents.find((i) => i.seq === seq)!;
  }

  // An Announce is sent only while its original exists (VIS-30's send-time check: "an original deleted since ...
  // refuses it").
  private refused(intent: Intent): boolean {
    return intent.type === "Announce" && !this.statuses.has(this.ids.s1);
  }

  // A row goes once delivered or dropped: the next row of its lane becomes its head, and an intent whose rows are all
  // gone goes with them.
  private settle(lane: Lane, row: Row): void {
    const rows = this.lanes.get(lane)!;
    rows.splice(rows.indexOf(row), 1);
    if (rows[0] !== undefined && rows[0].state === "queued") {
      rows[0].state = "pending";
    }
    const intent = this.intentOf(row.intent);
    if (intent.stage === "expanded" && LANES.every((l) => this.lanes.get(l)!.every((r) => r.intent !== intent.seq))) {
      this.intents = this.intents.filter((i) => i !== intent);
    }
  }

  // A claim expands the staged intents in id order, then leases every due lane head; a head the send-time check
  // refuses is dropped instead (its lane's next row waits for the next claim).
  claim(now: number, token: string, leaseMs: number): ClaimResult {
    this.expandAll();
    const result: ClaimResult = { leased: [], dropped: [] };
    const due = LANES.flatMap((lane) => {
      const head = this.lanes.get(lane)![0];
      return head !== undefined && (head.state === "pending" || (head.state === "leased" && head.until <= now))
        ? [{ lane, head }]
        : [];
    });
    for (const { lane, head } of due) {
      const intent = this.intentOf(head.intent);
      if (this.refused(intent)) {
        result.dropped.push(intent);
        this.settle(lane, head);
        continue;
      }
      head.state = "leased";
      head.token = token;
      head.until = now + leaseMs;
      result.leased.push({ lane, intent });
    }
    return result;
  }

  private leasedBy(lane: Lane, token: string): Row | undefined {
    return this.lanes.get(lane)!.find((r) => r.state === "leased" && r.token === token);
  }

  // A confirmation runs the claim's check again: stale when another claim took the row since.
  confirm(lane: Lane, token: string): { status: "send"; intent: Intent } | { status: "dropped" | "stale" } {
    const row = this.leasedBy(lane, token);
    if (row === undefined) {
      return { status: "stale" };
    }
    const intent = this.intentOf(row.intent);
    if (this.refused(intent)) {
      this.settle(lane, row);
      return { status: "dropped" };
    }
    return { status: "send", intent };
  }

  complete(lane: Lane, token: string): "delivered" | "stale" {
    const row = this.leasedBy(lane, token);
    if (row === undefined) {
      return "stale";
    }
    this.settle(lane, row);
    return "delivered";
  }

  // Nothing left for Kopje to do: no unfinished job, no intent waiting or staged, no delivery.
  quiet(): boolean {
    return (
      this.jobs.every((j) => j.doneAt !== null) &&
      this.intents.every((i) => i.stage === "expanded") &&
      LANES.every((lane) => this.lanes.get(lane)!.length === 0)
    );
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Peer: R's server, Mastodon v4.5.11, as the author
// ---------------------------------------------------------------------------------------------------------------

// ActivityPub::DeliveryWorker (app/workers/activitypub/delivery_worker.rb:11-20): 16 retries, the n-th after
// n**4 + 15 s, Sidekiq's jitter rand(10) * (n + 1) and Mastodon's rand(0.5 * n**4): at most this long in all.
export const RETRY_WINDOW_MS =
  Array.from({ length: 16 }, (_, n) => 1.5 * n ** 4 + 15 + 9 * (n + 1)).reduce((a, b) => a + b, 0) * 1000;

export type PeerStatus =
  | { state: "unposted" }
  | { state: "posted"; published: number; versions: { snapshot: Snapshot; at: number }[] }
  | { state: "deleted"; published: number | null };

export type Sent = { msg: Msg; at: number };

export class Peer {
  readonly statuses = new Map<string, PeerStatus>();
  // Messages not yet delivered to Kopje; every message sent, and those delivered at least once.
  outbox: Sent[] = [];
  readonly sent: Sent[] = [];
  readonly delivered: Sent[] = [];
  // The time of its last write: Mastodon's times increase strictly (one second apart here).
  private last = 0;

  constructor(
    readonly actor: string,
    readonly uris: readonly string[],
    // The status a reply goes to (s2's parent).
    readonly parents: ReadonlyMap<string, string>,
  ) {
    for (const uri of uris) {
      this.statuses.set(uri, { state: "unposted" });
    }
  }

  private tick(now: number): number {
    this.last = Math.max(now, this.last + 1000);
    return this.last;
  }

  private send(msg: Msg, at: number): void {
    const sent = { msg, at };
    this.outbox.push(sent);
    this.sent.push(sent);
  }

  private object(uri: string, snapshot: Snapshot, published: number, updated: number | null): Obj {
    return { uri, attributedTo: this.actor, snapshot, published, updated, inReplyTo: this.parents.get(uri) ?? null };
  }

  // PostStatusService: a reply only to a status that exists on its server (a deleted one cannot be replied to).
  post(uri: string, snapshot: Snapshot, now: number): boolean {
    const parent = this.parents.get(uri);
    if (
      this.statuses.get(uri)!.state !== "unposted" ||
      (parent !== undefined && this.statuses.get(parent)!.state !== "posted")
    ) {
      return false;
    }
    const at = this.tick(now);
    this.statuses.set(uri, { state: "posted", published: at, versions: [{ snapshot, at }] });
    this.send({ type: "Create", id: `${uri}/activity`, object: this.object(uri, snapshot, at, null) }, at);
    return true;
  }

  // UpdateStatusService: an edit with no change is refused (NoChangesSubmittedError, update_status_service.rb:121);
  // any change, the sensitive flag included (status.changed?, :171), sets edited_at to now (:123) and sends an Update
  // naming it as `updated`.
  edit(uri: string, snapshot: Snapshot, now: number): boolean {
    const status = this.statuses.get(uri)!;
    if (status.state !== "posted" || sameSnapshot(status.versions.at(-1)!.snapshot, snapshot)) {
      return false;
    }
    const at = this.tick(now);
    status.versions.push({ snapshot, at });
    this.send(
      { type: "Update", id: `${uri}#updates/${at}`, object: this.object(uri, snapshot, status.published, at) },
      at,
    );
    return true;
  }

  // RemoveStatusService: a Delete of the status, signed (proven) or not; a status never posted here is deleted too
  // (the generator's s3).
  delete(uri: string, now: number, proven: boolean): boolean {
    const status = this.statuses.get(uri)!;
    if (status.state === "deleted") {
      return false;
    }
    const at = this.tick(now);
    this.statuses.set(uri, { state: "deleted", published: status.state === "posted" ? status.published : null });
    this.send({ type: "Delete", id: `${uri}#delete`, object: uri, proven }, at);
    return true;
  }

  // The undelivered message at `index` (each delivery is its own job, in any order).
  take(index: number): Sent {
    const [sent] = this.outbox.splice(index, 1);
    this.delivered.push(sent!);
    return sent!;
  }

  // The oldest undelivered message's age at `now`, or 0.
  oldest(now: number): number {
    return this.outbox.reduce((age, s) => Math.max(age, now - s.at), 0);
  }

  // The final state of a posted status: its last version, and that version's time as Kopje must hold it.
  final(uri: string): { snapshot: Snapshot; version: string } | null {
    const status = this.statuses.get(uri)!;
    if (status.state !== "posted") {
      return null;
    }
    const last = status.versions.at(-1)!;
    return { snapshot: last.snapshot, version: iso(last.at) };
  }
}
