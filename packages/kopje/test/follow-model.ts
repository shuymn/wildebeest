// The follow lifecycle between one local account L and one remote account R, as two reference models in plain
// TypeScript (test/follow-lifecycle.test.ts drives the Store and the API against them):
//
// - Policy: Kopje's documented rules (docs/threat-model.md ID-7, NET-2 and VIS-13, the accepted risks, and
//   docs/mastodon-deviations.md for the unlock acceptance), written from the docs and never from src/: the edges
//   both ways, the blocks both ways, L's lock, R's retracted ids, L's counts and follow notifications, and Kopje's
//   outstanding intents for R in their lane, each with its delivery's state.
// - Peer: R's server, Mastodon v4.5.11, written from its source (each rule cites the file and line it models),
//   applying the bytes Kopje actually confirmed and sending back what Mastodon would.
//
// A change to a follow-lifecycle rule in docs/threat-model.md changes this file with it.

// ---------------------------------------------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------------------------------------------

export type Edge = { state: "pending" | "accepted"; uri: string } | null;

// NET-2: "the POST timeout (30 s) is shorter than the lease (60 s)".
export const LEASE_MS = 60_000;
// The most attempts a delivery gets: a run that reaches it has failed its eventual-delivery assumption.
export const ATTEMPTS_BOUND = 15;

// A delivery's state in its lane (NET-2: "Claims serialize each lane"): the head is pending (due at dueAt) or leased
// (under one lease token until `until`); every row behind it is queued.
export type Head = { kind: "pending"; dueAt: number } | { kind: "leased"; token: string; until: number };

export type IntentType = "Follow" | "Undo" | "Accept" | "Reject" | "Block" | "Update";

export type Intent = {
  seq: number;
  type: IntentType;
  // What identifies the activity: a Follow's or a Block's own id, else the id of the activity it undoes or answers;
  // null for L's profile Update, which only holds its place in the lane.
  ref: string | null;
  // What an Undo undoes (the type its embedded object names); null for every other activity.
  undoes: "Follow" | "Block" | null;
  // What the activity is about: the id a retraction of it names.
  subject: string | null;
  // An Accept or Reject of R's Follow (NET-2's follow answers).
  answer: boolean;
  // A retraction supersedes the earlier activities about its subject (an Undo, a Reject that withdraws an accepted
  // follow).
  retracts: boolean;
  superseded: boolean;
  head: Head | null;
  attempts: number;
};

export type Answer = { applied: boolean; reason: string };

export type InboundRef = { id: string | null; type: string | null; actor: string | null; object: string | null };

export type Inbound =
  | { type: "Follow"; id: string; object: string }
  | { type: "Block"; id: string; object: string }
  | { type: "Undo"; id: string; object: InboundRef }
  | { type: "Accept"; id: string; object: InboundRef }
  | { type: "Reject"; id: string; object: InboundRef };

// The events the quiescence exceptions read (rlException in follow-lifecycle.test.ts).
export type PolicyEvents = {
  // #1412: R's pending generation that R's Block removed at Kopje.
  blockRemovedRequest: Set<string>;
  // #1412: R's Follows refused because R blocks L.
  followOfBlocker: Set<string>;
};

export class Policy {
  rl: Edge = null;
  lr: Edge = null;
  blockRL: string | null = null;
  blockLR: string | null = null;
  locked = false;
  retracted = new Set<string>();
  notifications = new Set<"follow" | "follow_request">();
  lane: Intent[] = [];
  unlockJob = false;
  readonly events: PolicyEvents = { blockRemovedRequest: new Set(), followOfBlocker: new Set() };
  // Every follow and block id L has used, and every answer id recorded (ID-7: none is recorded twice).
  private readonly localIds = new Set<string>();
  private readonly answerIds = new Set<string>();
  private seq = 0;

  constructor(
    readonly lUri: string,
    readonly rUri: string,
  ) {}

  get followers(): number {
    return this.rl?.state === "accepted" ? 1 : 0;
  }

  get following(): number {
    return this.lr?.state === "accepted" ? 1 : 0;
  }

  // ID-7: "a superseded, undone, refused or blocked Follow id is recorded as retracted" (and a Block's old id, and an
  // Undo's object). Only ids of R's own origin are recorded (an Undo is checked for that before).
  private retract(uri: string): void {
    this.retracted.add(uri);
  }

  // NET-2: a lane is (actor, inbox origin); everything L sends R's server is one lane, delivered in order.
  private promote(now: number): void {
    const head = this.lane[0];
    if (head !== undefined && head.head === null) {
      head.head = { kind: "pending", dueAt: now };
    }
  }

  private remove(intent: Intent, now: number): void {
    const index = this.lane.indexOf(intent);
    this.lane.splice(index, 1);
    if (index === 0) {
      this.promote(now);
    }
  }

  private record(
    now: number,
    input: Pick<Intent, "type" | "ref" | "subject"> & {
      undoes?: Intent["undoes"];
      answer?: boolean;
      retracts?: boolean;
    },
  ): void {
    const answer = input.answer === true;
    if (answer) {
      const key = `${input.type} ${input.ref}`;
      if (this.answerIds.has(key)) {
        throw new Error(`policy: the ${key} answer is recorded twice (ID-7)`);
      }
      this.answerIds.add(key);
    }
    const retracts = input.retracts === true;
    // A retraction supersedes every earlier activity about its object (VIS-13: the Block's Undo "supersedes a Block
    // still waiting"; NET-2: "The same holds for an Accept that a block's withdrawing Reject superseded").
    if (retracts && input.subject !== null) {
      for (const earlier of this.lane) {
        if (earlier.subject === input.subject) {
          earlier.superseded = true;
        }
      }
    }
    // A profile Update replaces the Updates still waiting for the same server, so it delivers only the latest.
    if (input.type === "Update") {
      for (const earlier of this.lane.filter((i) => i.type === "Update" && i.head?.kind !== "leased")) {
        this.remove(earlier, now);
      }
    }
    this.lane.push({
      ...input,
      undoes: input.undoes ?? null,
      seq: ++this.seq,
      answer,
      retracts,
      superseded: false,
      head: null,
      attempts: 0,
    });
    this.promote(now);
  }

  private answerOf(kind: "Accept" | "Reject", followUri: string, now: number, withdraws = false): void {
    this.record(now, {
      type: kind,
      ref: followUri,
      subject: followUri,
      answer: true,
      retracts: withdraws,
    });
  }

  // NET-2: "A remote Follow cancels, in its receive transaction, every Accept and Reject of its pair that is not
  // leased ... A leased answer is kept and holds its lane ... its intent is superseded". Returns how many it caught.
  private cancelAnswers(now: number): number {
    let caught = 0;
    for (const intent of this.lane.filter((i) => i.answer)) {
      caught++;
      if (intent.head?.kind === "leased") {
        intent.superseded = true;
      } else {
        this.remove(intent, now);
      }
    }
    return caught;
  }

  private undoOf(id: string, undoes: "Follow" | "Block", now: number): void {
    this.record(now, { type: "Undo", ref: id, subject: id, undoes, retracts: true });
  }

  // How the local account's follow notifications go with the follow (Mastodon destroys them with it).
  private dropFollowNotifications(): void {
    this.notifications.delete("follow");
    this.notifications.delete("follow_request");
  }

  // VIS-13: "A local block ... sends, in order, the Undo of our follow, a Reject of theirs (one that withdraws it if
  // it was accepted)". The ended remote Follow is recorded as retracted (ID-7).
  private endRemoteFollow(now: number): void {
    if (this.rl === null) {
      return;
    }
    this.retract(this.rl.uri);
    this.answerOf("Reject", this.rl.uri, now, this.rl.state === "accepted");
    this.rl = null;
    this.dropFollowNotifications();
  }

  private endLocalFollow(now: number): void {
    if (this.lr === null) {
      return;
    }
    this.undoOf(this.lr.uri, "Follow", now);
    this.lr = null;
  }

  private fresh(uri: string, kind: "follows" | "blocks"): void {
    if (!uri.startsWith(`${this.lUri}#${kind}/`) || this.localIds.has(uri)) {
      throw new Error(`policy: ${uri} is not a fresh ${kind} id of L`);
    }
    this.localIds.add(uri);
  }

  // ---- Inbound activities of R (ID-7, VIS-13, NET-2) ----

  receive(activity: Inbound, now: number): Answer & { caught?: number } {
    switch (activity.type) {
      case "Follow":
        return this.follow(activity.id, now);
      case "Block":
        return this.block(activity.id, now);
      case "Undo":
        return this.undo(activity.object);
      case "Accept":
        return this.accept(activity.object);
      case "Reject":
        return this.reject(activity.object);
    }
  }

  private follow(id: string, now: number): Answer & { caught?: number } {
    if (this.retracted.has(id)) {
      return { applied: false, reason: "retracted" };
    }
    // The follower blocks the target: its server would not have sent this; nothing is recorded.
    if (this.blockRL !== null) {
      // #1412: Mastodon takes it (follow.rb:18 refuses only a follower the target blocks).
      this.events.followOfBlocker.add(id);
      return { applied: false, reason: "blocked" };
    }
    // VIS-13: while the block lasts the blocked account may not follow (a remote Follow is answered with a Reject);
    // the refused id is recorded (ID-7), and NET-2: "A Follow the target refuses because it blocks the follower
    // records its Reject and cancels nothing".
    if (this.blockLR !== null) {
      this.retract(id);
      this.answerOf("Reject", id, now);
      return { applied: true, reason: "follow-rejected" };
    }
    if (this.rl?.uri === id) {
      return { applied: false, reason: "duplicate" };
    }
    const caught = this.cancelAnswers(now);
    if (this.rl !== null) {
      // ID-7: a new generation; the superseded id is recorded as retracted. A pending request keeps waiting; an
      // accepted follow is accepted again under the new id.
      this.retract(this.rl.uri);
      this.rl = { state: this.rl.state, uri: id };
      if (this.rl.state === "pending") {
        return { applied: true, reason: "follow-request-updated", caught };
      }
      this.answerOf("Accept", id, now);
      return { applied: true, reason: "follow-reaccepted", caught };
    }
    if (this.locked) {
      this.rl = { state: "pending", uri: id };
      this.notifications.add("follow_request");
      return { applied: true, reason: "follow-requested", caught };
    }
    this.rl = { state: "accepted", uri: id };
    this.answerOf("Accept", id, now);
    this.notifications.add("follow");
    return { applied: true, reason: "followed", caught };
  }

  private block(id: string, now: number): Answer {
    if (this.retracted.has(id)) {
      return { applied: false, reason: "retracted" };
    }
    if (this.blockRL !== null) {
      if (this.blockRL === id) {
        return { applied: false, reason: "duplicate" };
      }
      // ID-7: "A Block that takes a new id records its old id as retracted first".
      this.retract(this.blockRL);
      this.blockRL = id;
      return { applied: true, reason: "block-updated" };
    }
    // VIS-13: a remote Block "ends the follows between the two accounts in both directions and in either state".
    if (this.rl !== null) {
      if (this.rl.state === "pending") {
        // #1412: Mastodon keeps the blocker's request here (block.rb:14-16).
        this.events.blockRemovedRequest.add(this.rl.uri);
      }
      this.retract(this.rl.uri);
      this.rl = null;
      this.dropFollowNotifications();
    }
    this.endLocalFollow(now);
    this.blockRL = id;
    return { applied: true, reason: "blocked" };
  }

  // ID-7: "an Undo decides the undone type first (embedded, or a stored block with that id)"; its object is recorded
  // as retracted whether or not it matched, so an Undo that overtook its activity keeps it from applying later.
  private undo(ref: InboundRef): Answer {
    if (ref.actor !== null && ref.actor !== this.rUri) {
      return { applied: false, reason: "not-own" };
    }
    const id = ref.id;
    if (id === null) {
      return { applied: false, reason: "unknown-object" };
    }
    if (this.retracted.has(id)) {
      return { applied: false, reason: "retracted" };
    }
    const followMatch = (ref.type === null || ref.type === "Follow") && this.rl?.uri === id;
    const undoesBlock = ref.type === "Block" || (ref.type === null && !followMatch && this.blockRL === id);
    let undone = false;
    if (followMatch) {
      this.rl = null;
      this.dropFollowNotifications();
      undone = true;
    } else if (undoesBlock && this.blockRL === id) {
      this.blockRL = null;
      undone = true;
    }
    this.retract(id);
    return { applied: true, reason: undone ? "undone" : "retraction-recorded" };
  }

  // ID-6: only the followed side answers our Follow, by its id (every follow of L names one).
  private accept(ref: InboundRef): Answer {
    if (ref.object !== null && ref.object !== this.rUri) {
      return { applied: false, reason: "not-target" };
    }
    if (this.lr === null || this.lr.uri !== ref.id) {
      return { applied: false, reason: "unknown-follow" };
    }
    if (this.lr.state === "accepted") {
      return { applied: false, reason: "duplicate" };
    }
    this.lr = { state: "accepted", uri: this.lr.uri };
    return { applied: true, reason: "follow-accepted" };
  }

  private reject(ref: InboundRef): Answer {
    if (ref.object !== null && ref.object !== this.rUri) {
      return { applied: false, reason: "not-target" };
    }
    if (this.lr === null || this.lr.uri !== ref.id) {
      return { applied: false, reason: "unknown-follow" };
    }
    this.lr = null;
    return { applied: true, reason: "follow-rejected" };
  }

  // ---- L's actions through the API ----

  // VIS-13: while a block lasts neither may follow the other. An existing follow only changes its options.
  localFollow(now: number, uri: () => string): number {
    if (this.blockLR !== null || this.blockRL !== null) {
      return 403;
    }
    if (this.lr === null) {
      const id = uri();
      this.fresh(id, "follows");
      this.lr = { state: "pending", uri: id };
      this.record(now, { type: "Follow", ref: id, subject: id });
    }
    return 200;
  }

  localUnfollow(now: number): number {
    this.endLocalFollow(now);
    return 200;
  }

  authorize(now: number): number {
    if (this.rl?.state !== "pending") {
      return 404;
    }
    this.rl = { state: "accepted", uri: this.rl.uri };
    this.notifications.delete("follow_request");
    this.answerOf("Accept", this.rl.uri, now);
    return 200;
  }

  // ID-7: "a local reject of a request (which records the remote Follow as retracted ...)".
  rejectRequest(now: number): number {
    if (this.rl?.state !== "pending") {
      return 404;
    }
    this.retract(this.rl.uri);
    this.answerOf("Reject", this.rl.uri, now);
    this.rl = null;
    this.notifications.delete("follow_request");
    return 200;
  }

  // remove_from_followers ends an accepted follow as a block ends it; a pending request is left alone.
  removeFromFollowers(now: number): number {
    if (this.rl?.state === "accepted") {
      this.endRemoteFollow(now);
    }
    return 200;
  }

  localBlock(now: number, uri: () => string): number {
    if (this.blockLR === null) {
      this.endLocalFollow(now);
      this.endRemoteFollow(now);
      const id = uri();
      this.fresh(id, "blocks");
      this.blockLR = id;
      this.record(now, { type: "Block", ref: id, subject: id });
    }
    return 200;
  }

  // VIS-13: "an unblock sends the Block's Undo, which supersedes a Block still waiting".
  localUnblock(now: number): number {
    if (this.blockLR !== null) {
      this.undoOf(this.blockLR, "Block", now);
      this.blockLR = null;
    }
    return 200;
  }

  // docs/mastodon-deviations.md: unlocking accepts the pending requests as a job; relocking stops it. A profile
  // change sends L's followers an Update; an update that changes nothing sends none.
  lock(locked: boolean, now: number): number {
    const was = this.locked;
    this.locked = locked;
    if (locked) {
      this.unlockJob = false;
    } else if (was && this.rl?.state === "pending") {
      this.unlockJob = true;
    }
    if (locked !== was) {
      // A profile Update supersedes the earlier ones, whoever it reaches.
      for (const earlier of this.lane.filter((i) => i.type === "Update")) {
        earlier.superseded = true;
      }
      if (this.rl?.state === "accepted") {
        this.record(now, { type: "Update", ref: null, subject: null });
      }
    }
    return 200;
  }

  // One round of the unlock acceptance: it authorizes the pending request, as the authorize API does, and ends.
  unlockRound(now: number): boolean {
    if (!this.unlockJob) {
      return false;
    }
    this.unlockJob = false;
    if (this.locked || this.rl?.state !== "pending") {
      return false;
    }
    this.authorize(now);
    return true;
  }

  // ---- Deliveries (NET-2) ----

  private leased(token: string): Intent | undefined {
    const head = this.lane[0];
    return head?.head?.kind === "leased" && head.head.token === token ? head : undefined;
  }

  // A claim leases the lane's head once it is due (an expired lease is due again); a superseded follow answer is
  // dropped instead, and the lane promoted.
  claim(now: number, token: string): { leased: Intent | null; dropped: Intent | null; gaveUp: Intent | null } {
    const head = this.lane[0];
    const none = { leased: null, dropped: null, gaveUp: null };
    if (head?.head == null) {
      return none;
    }
    const due = head.head.kind === "pending" ? head.head.dueAt <= now : head.head.until <= now;
    if (!due) {
      return none;
    }
    if (head.answer && head.superseded) {
      this.remove(head, now);
      return { ...none, dropped: head };
    }
    if (head.attempts >= ATTEMPTS_BOUND) {
      return { ...none, gaveUp: head };
    }
    head.head = { kind: "leased", token, until: now + LEASE_MS };
    head.attempts++;
    return { ...none, leased: head };
  }

  // Completion and confirmation require the current lease token (NET-2), so a stale one settles nothing; a
  // superseded answer under lease is dropped at its confirmation and at a failed completion, never sent or retried.
  confirm(token: string, now: number): { status: "send"; intent: Intent } | { status: "stale" | "dropped" } {
    const intent = this.leased(token);
    if (intent === undefined) {
      return { status: "stale" };
    }
    if (intent.answer && intent.superseded) {
      this.remove(intent, now);
      return { status: "dropped" };
    }
    return { status: "send", intent };
  }

  complete(
    token: string,
    delivered: boolean,
    now: number,
    retryAt: number | null,
  ): "delivered" | "retry" | "dropped" | "stale" {
    const intent = this.leased(token);
    if (intent === undefined) {
      return "stale";
    }
    if (delivered) {
      this.remove(intent, now);
      return "delivered";
    }
    if (intent.answer && intent.superseded) {
      this.remove(intent, now);
      return "dropped";
    }
    if (retryAt === null || retryAt <= now) {
      throw new Error("policy: a retry must be due later");
    }
    intent.head = { kind: "pending", dueAt: retryAt };
    return "retry";
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Peer: R's server, Mastodon v4.5.11
// ---------------------------------------------------------------------------------------------------------------

export type PeerEdge = { state: "requested" | "accepted"; uri: string } | null;

// Six hours, activity.rb:96-98 (delete_later!).
export const UNDO_CACHE_MS = 6 * 60 * 60 * 1000;

// What R's server sends Kopje, as the Store's receive takes it.
export type PeerMessage = { seq: number; activity: Inbound };

// A body Kopje sent, as the peer parses it.
export type Body = {
  type: string;
  id: string;
  actor?: string;
  object: string | { id?: string; type?: string; actor?: string; object?: string };
};

// The events the quiescence exceptions read, each naming the generation it concerns.
export type PeerEvents = {
  // block.rb:16: Kopje's Block dropped R's request g (RejectFollowService, nothing sent).
  blockDroppedRequest: Set<string>;
  // block_service.rb:9-11: R's Block kept R's own request g.
  blockKeptRequest: Set<string>;
  // accept.rb:24 and reject.rb:25: an answer of another generation applied to R's request g by the account pair.
  pairAnswer: Set<string>;
  // follow.rb:9: a Follow of L's that a cached Undo suppressed.
  undoBeforeFollow: number;
  // A Follow of L's processed again after an Undo removed that very follow: the follow is recreated.
  replayAfterUndo: Set<string>;
  // The id named by the typed Undo that ended L's follow of R (undo.rb:89-101) and L's block of R (undo.rb:116-126)
  // at R's server, while that end stands. Mastodon matches both by the account pair, so the id may be an older one
  // than the relationship it ended.
  undoEnded: { follow: string | null; block: string | null };
  // The ids named by a typed Undo that ended a different follow or block of L's (by the pair): no cached Undo then
  // suppresses the named Follow or Block (activity.rb:92-98), which applies when it is processed later.
  undoNamedOther: { follow: Set<string>; block: Set<string> };
};

export class Peer {
  // R's follow of L, and L's follow of R as R's server holds them (Follow or FollowRequest).
  rl: PeerEdge = null;
  rBlocks: string | null = null;
  locked = false;
  private lrEdge: PeerEdge = null;
  private lBlock: string | null = null;
  // AuthorizeFollowWorker jobs, each for L's request (update_account_service.rb:22-28).
  jobs = 0;
  // delete_upon_arrival keys (activity.rb:92-98): the undone object's id and its expiry.
  readonly cache = new Map<string, number>();
  // Messages to Kopje not yet delivered, and bodies from Kopje received but not processed.
  outbox: PeerMessage[] = [];
  inbox: { seq: number; body: Body }[] = [];
  readonly sent: PeerMessage[] = [];
  readonly events: PeerEvents = {
    blockDroppedRequest: new Set(),
    blockKeptRequest: new Set(),
    pairAnswer: new Set(),
    undoBeforeFollow: 0,
    replayAfterUndo: new Set(),
    undoEnded: { follow: null, block: null },
    undoNamedOther: { follow: new Set(), block: new Set() },
  };
  // R's newest Follow id.
  lastRGeneration: string | null = null;
  // R's Follow ids, oldest first.
  readonly generations: string[] = [];
  // L's follow ids an Undo removed at R's server (the follow it removed, whatever id the Undo named).
  private readonly undoneLocal = new Set<string>();
  private n = 0;
  private seq = 0;

  constructor(
    readonly origin: string,
    readonly rUri: string,
    readonly lUri: string,
  ) {}

  // L's follow of R and L's block of R: any change of either but an Undo's (processUndoFollow, processUndoBlock) ends
  // what undoEnded records for it.
  get lr(): PeerEdge {
    return this.lrEdge;
  }

  set lr(edge: PeerEdge) {
    this.lrEdge = edge;
    this.events.undoEnded.follow = null;
  }

  get lBlocks(): string | null {
    return this.lBlock;
  }

  set lBlocks(uri: string | null) {
    this.lBlock = uri;
    this.events.undoEnded.block = null;
  }

  private id(kind: string): string {
    return `${this.origin}/peer/${kind}/${++this.n}`;
  }

  private send(activity: Inbound): void {
    const message = { seq: ++this.seq, activity };
    this.outbox.push(message);
    this.sent.push(message);
  }

  private ref(id: string, type: string, actor: string, object: string): InboundRef {
    return { id, type, actor, object };
  }

  // UnfollowService#send_undo_follow (unfollow_service.rb:62-64, UndoFollowSerializer).
  private sendUndoFollow(uri: string): void {
    this.send({ type: "Undo", id: `${uri}/undo`, object: this.ref(uri, "Follow", this.rUri, this.lUri) });
  }

  // A Reject of L's follow (RejectFollowSerializer of L's request or follow, named by its uri).
  private sendReject(uri: string): void {
    this.send({ type: "Reject", id: this.id("rejects"), object: this.ref(uri, "Follow", this.lUri, this.rUri) });
  }

  private sendAccept(uri: string): void {
    this.send({ type: "Accept", id: this.id("accepts"), object: this.ref(uri, "Follow", this.lUri, this.rUri) });
  }

  private cached(uri: string, now: number): boolean {
    const expiry = this.cache.get(uri);
    return expiry !== undefined && expiry > now;
  }

  // ---- R's actions ----

  // FollowService (follow_service.rb:23-44): refused while either blocks the other; an existing follow or request only
  // changes its options; a remote target always gets a request (activitypub?, line 39) and the Follow.
  follow(): boolean {
    if (this.rl !== null || this.rBlocks !== null || this.lBlocks !== null) {
      return false;
    }
    const uri = this.id("follows");
    this.rl = { state: "requested", uri };
    this.lastRGeneration = uri;
    this.generations.push(uri);
    this.send({ type: "Follow", id: uri, object: this.lUri });
    return true;
  }

  // RefollowWorker (refollow_worker.rb:12-26): R's accepted follow is dropped locally, then FollowService runs; a
  // refusal is rescued and sends nothing.
  refollow(): boolean {
    if (this.rl?.state !== "accepted") {
      return false;
    }
    this.rl = null;
    this.follow();
    return true;
  }

  // UnfollowService (unfollow_service.rb:18-60): the follow or the request goes, with an Undo.
  unfollow(): boolean {
    if (this.rl === null) {
      return false;
    }
    const uri = this.rl.uri;
    this.rl = null;
    this.sendUndoFollow(uri);
    return true;
  }

  // BlockService (block_service.rb:6-20): R's accepted follow is undone (UnfollowService), L's follow of R ends with a
  // Reject (UnfollowService sends one for a remote follower, unfollow_service.rb:35-36) and L's request is rejected
  // (RejectFollowService); R's own request stays. Then the Block. Nothing guards a block R already holds (the API's
  // block calls BlockService every time, accounts_controller.rb:54-57): the cleanup runs again, and the Block is sent
  // again under its id (block! finds the existing block, interactions.rb:75-78, whose uri BlockSerializer names).
  block(): boolean {
    if (this.rl?.state === "accepted") {
      this.unfollow();
    } else if (this.rl !== null) {
      this.events.blockKeptRequest.add(this.rl.uri);
    }
    if (this.lr !== null) {
      const uri = this.lr.uri;
      this.lr = null;
      this.sendReject(uri);
    }
    this.rBlocks ??= this.id("blocks");
    this.send({ type: "Block", id: this.rBlocks, object: this.lUri });
    return true;
  }

  // UnblockService (unblock_service.rb:6-12, UndoBlockSerializer).
  unblock(): boolean {
    if (this.rBlocks === null) {
      return false;
    }
    const uri = this.rBlocks;
    this.rBlocks = null;
    this.send({ type: "Undo", id: `${uri}/undo`, object: this.ref(uri, "Block", this.rUri, this.lUri) });
    return true;
  }

  // AuthorizeFollowService (authorize_follow_service.rb:6-16): L's request becomes a follow, with an Accept.
  authorize(): boolean {
    if (this.lr?.state !== "requested") {
      return false;
    }
    this.lr = { state: "accepted", uri: this.lr.uri };
    this.sendAccept(this.lr.uri);
    return true;
  }

  // RejectFollowService (reject_follow_service.rb:6-11).
  reject(): boolean {
    if (this.lr?.state !== "requested") {
      return false;
    }
    const uri = this.lr.uri;
    this.lr = null;
    this.sendReject(uri);
    return true;
  }

  // RemoveFromFollowersService (remove_from_followers_service.rb:6-12): L's accepted follow goes, with a Reject.
  removeFollower(): boolean {
    if (this.lr?.state !== "accepted") {
      return false;
    }
    const uri = this.lr.uri;
    this.lr = null;
    this.sendReject(uri);
    return true;
  }

  // UpdateAccountService (update_account_service.rb:5-11, 22-28): an unlock queues one AuthorizeFollowWorker per
  // pending request; relocking cancels none, and the worker does not read `locked`.
  lock(locked: boolean): void {
    if (this.locked && !locked && this.lr?.state === "requested") {
      this.jobs++;
    }
    this.locked = locked;
  }

  // AuthorizeFollowWorker (authorize_follow_worker.rb:6-13): a request gone since is rescued (RecordNotFound).
  runJob(): boolean {
    if (this.jobs === 0) {
      return false;
    }
    this.jobs--;
    return this.authorize();
  }

  // ---- Bodies from Kopje, processed in any order (each is its own job) ----

  receive(body: Body): void {
    this.inbox.push({ seq: ++this.seq, body });
  }

  process(index: number, now: number): Body | null {
    const [item] = this.inbox.splice(index, 1);
    if (item === undefined) {
      return null;
    }
    const { body } = item;
    const object = typeof body.object === "string" ? { id: body.object } : body.object;
    switch (body.type) {
      case "Follow":
        this.processFollow(body.id, now);
        break;
      case "Undo":
        if (object.type === "Follow") {
          this.processUndoFollow(object.id ?? "", now);
        } else if (object.type === "Block") {
          this.processUndoBlock(object.id ?? "", now);
        }
        break;
      case "Block":
        this.processBlock(body.id, now);
        break;
      case "Accept":
        this.processAccept(object.id ?? null);
        break;
      case "Reject":
        this.processReject(object.id ?? null);
        break;
      default:
        // A profile Update changes no relationship.
        break;
    }
    return body;
  }

  // follow.rb:6-39.
  private processFollow(uri: string, now: number): void {
    if (this.cached(uri, now)) {
      this.events.undoBeforeFollow++;
      return;
    }
    if (this.undoneLocal.has(uri)) {
      this.events.replayAfterUndo.add(uri);
    }
    if (this.lr?.state === "requested") {
      this.lr = { state: "requested", uri };
      return;
    }
    if (this.rBlocks !== null) {
      this.sendReject(uri);
      return;
    }
    if (this.lr?.state === "accepted") {
      this.lr = { state: "accepted", uri };
      this.sendAccept(uri);
      return;
    }
    this.lr = { state: "requested", uri };
    if (!this.locked) {
      this.authorize();
    }
  }

  // undo.rb:89-101: matched by the pair, not by the Follow's id, so it removes whichever follow or request L holds.
  private processUndoFollow(uri: string, now: number): void {
    if (this.lr === null) {
      this.cache.set(uri, now + UNDO_CACHE_MS);
      return;
    }
    if (this.lr.uri !== uri) {
      this.events.undoNamedOther.follow.add(uri);
    }
    this.undoneLocal.add(this.lr.uri);
    this.lr = null;
    this.events.undoEnded.follow = uri;
  }

  // undo.rb:116-126: matched by the pair (blocking?), not by the Block's id.
  private processUndoBlock(uri: string, now: number): void {
    if (this.lBlocks === null) {
      this.cache.set(uri, now + UNDO_CACHE_MS);
      return;
    }
    if (this.lBlocks !== uri) {
      this.events.undoNamedOther.block.add(uri);
    }
    this.lBlocks = null;
    this.events.undoEnded.block = uri;
  }

  // block.rb:4-22: an existing block takes the new id; else L's follow of R ends with a Reject, R's follow of L with
  // an Undo, R's request is rejected silently; then the block, unless its Undo arrived first.
  private processBlock(uri: string, now: number): void {
    if (this.lBlocks !== null) {
      this.lBlocks = uri;
      return;
    }
    if (this.lr?.state === "accepted") {
      const follow = this.lr.uri;
      this.lr = null;
      this.sendReject(follow);
    }
    if (this.rl?.state === "accepted") {
      this.unfollow();
    } else if (this.rl?.state === "requested") {
      this.events.blockDroppedRequest.add(this.rl.uri);
      this.rl = null;
    }
    if (!this.cached(uri, now)) {
      this.lBlocks = uri;
    }
  }

  // accept.rb:4-35: R's request by the Follow's id, else (embedded Follow) by the account pair.
  private processAccept(uri: string | null): void {
    if (this.rl?.state !== "requested") {
      return;
    }
    if (this.rl.uri !== uri) {
      this.events.pairAnswer.add(this.rl.uri);
    }
    this.rl = { state: "accepted", uri: this.rl.uri };
  }

  // reject.rb:4-29: R's request by id, else R's follow by id (UnfollowService, which sends an Undo), else by the pair:
  // the request is rejected and a follow undone.
  private processReject(uri: string | null): void {
    if (this.rl === null) {
      return;
    }
    if (this.rl.uri !== uri) {
      this.events.pairAnswer.add(this.rl.uri);
    }
    if (this.rl.state === "requested") {
      this.rl = null;
    } else {
      this.unfollow();
    }
  }
}
