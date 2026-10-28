import { verifySpooledRequest } from "../federation/inbound";
import { legacyInboxMessage, legacyRecipient } from "../federation/legacy-inbox";
import type { LoaderDeps } from "../federation/loader";
import { decodeSpoolRecord, inflate, SPOOL_MESSAGE_LIMIT } from "../federation/spool";
import { readConfig, userKek } from "../platform/config";
import { DeadlinePassed as DrainDeadline, within } from "../platform/deadline";
import { PACKAGE_VERSION } from "../platform/package-version";
import { readQueueBacklog } from "../platform/queue-backlog";
import {
  DRAIN_LEASE_MS,
  type ImportAuthority,
  JOURNAL_MAX_BYTES,
  JOURNAL_MAX_ENTRIES,
  type JournalCounts,
} from "../platform/store-admin";
import type { StoreStub } from "../platform/store-client";

// The rollback drain of a cutover (docs/cutover-runbook.md, "Rolling back"): the inbox requests Kopje accepted during
// the window go to the legacy instance, through an ordered lane, in the order they were spooled, before it receives
// anything new, so that a later Undo or Delete applies on top of them and nothing replays them into a later cutover.
//
// One round hands off at most one request, and only when:
//   - Kopje's Queue holds nothing (the collection barrier): every spooled request, the delayed ones included, is in the
//     journal, so none can arrive later than a newer one already sent;
//   - the legacy Queue holds nothing: the legacy consumer has acknowledged the previous request, retries included, so
//     no later request overtakes one it is still retrying;
//   - the legacy dead-letter queue holds nothing: a request it dead-lettered stops the drain until the operator
//     reconciles it.
// Each reading fails closed: a Queue whose metrics cannot be read stops the round.
// The request is verified first, against the time it was spooled, by Kopje's own rule (verifySpooledRequest), and
// becomes the legacy consumer's inbox message (federation/legacy-inbox.ts) for a recipient among the legacy local
// accounts the operator gives. A request that may verify later stops the round; one that fails for good, or has no
// legacy recipient, is kept for the operator. The record is marked as being sent before the send: after a crash it is
// sent again (at least once). One drain runs at a time (a Store lease).

type DrainRound = {
  sent: number;
  unverified: number;
  noRecipient: number;
  // The lane is busy; run the round again shortly.
  waiting: "kopje-backlog" | "legacy-backlog" | null;
  // The drain cannot go on by itself; the operator acts, then runs it again.
  stopped:
    | "legacy-dlq"
    | "metrics-unavailable"
    | "key-unavailable"
    | "legacy-queue-failed"
    | "legacy-queue-timeout"
    | "journal-full"
    | "lease-expiring"
    | null;
  journal: JournalCounts;
};

export type DrainResult = ({ ok: true } & DrainRound) | { ok: false; status: 400 | 409; code: string; message: string };

// What the round leaves of the lease unused, against clock differences between the Worker and the Store.
const LEASE_MARGIN_MS = 60_000;
// A send to the legacy Queue that takes longer is given up for this round (well inside DRAIN_LEASE_MS).
const SEND_TIMEOUT_MS = 10_000;
// Verification in one round stops after this long (well inside DRAIN_LEASE_MS).
const ROUND_BUDGET_MS = 60_000;
// Records one round may verify, and set aside, before it stops; it hands off at most one request.
const MAX_EXAMINED_PER_ROUND = 50;
const MAX_KEPT_PER_ROUND = 20;
// Queue messages are limited to 128 KB; keep room for serialization overhead.
const LEGACY_MESSAGE_LIMIT = 120 * 1024;
const USERNAME = /^[A-Za-z0-9_]{1,64}$/;

type DrainEnv = Env & { LEGACY_QUEUE?: Queue; LEGACY_DLQ?: Queue };

type Store = StoreStub & Record<string, (...args: unknown[]) => Promise<unknown>>;
type Refused = { ok: false; code: string; message: string };

export async function drainJournal(
  env: Env,
  deps: {
    build: string;
    store: StoreStub;
    loader: Omit<LoaderDeps, "userAgent">;
    holder: string;
    now?: () => number;
    sendTimeoutMs?: number;
  },
  authority: ImportAuthority,
  options: { accounts: unknown; fallback: unknown; unordered?: unknown },
): Promise<DrainResult> {
  const config = readConfig(env);
  const { LEGACY_QUEUE: legacy, LEGACY_DLQ: legacyDlq } = env as DrainEnv;
  if (!config.ok || legacy === undefined || legacyDlq === undefined || config.config.LEGACY_VAPID_JWK === undefined) {
    return refused(
      409,
      "legacy-binding-missing",
      "bind the legacy Queue as LEGACY_QUEUE and its dead-letter queue as LEGACY_DLQ, and set LEGACY_VAPID_JWK",
    );
  }
  let vapidKeys: unknown;
  try {
    vapidKeys = JSON.parse(config.config.LEGACY_VAPID_JWK);
  } catch {
    return refused(409, "legacy-binding-missing", "LEGACY_VAPID_JWK is not JSON");
  }
  const { accounts, fallback } = options;
  if (
    !Array.isArray(accounts) ||
    accounts.length === 0 ||
    !accounts.every((a) => typeof a === "string" && USERNAME.test(a))
  ) {
    return refused(400, "invalid-accounts", "accounts must list the legacy local usernames");
  }
  if (fallback !== undefined && fallback !== null && (typeof fallback !== "string" || !accounts.includes(fallback))) {
    return refused(400, "invalid-fallback", "the fallback must be one of the accounts");
  }
  const stored = (await deps.store.config(deps.build)).values.domain;
  if (stored === undefined) {
    return refused(409, "domain-missing", "the Store has no domain");
  }
  const domain: string = stored;
  const kek = userKek(config.config);
  const lane: Queue = legacy;
  const store = deps.store as unknown as Store;
  const call = async <T>(method: string, ...args: unknown[]): Promise<T> => {
    const result = (await store[method]!(deps.build, authority, ...args)) as ({ ok: true } & T) | Refused;
    if (!result.ok) {
      throw new DrainRefusal(result.code, result.message);
    }
    return result;
  };
  const now = deps.now ?? (() => Date.now());
  const started = now();
  // The lease fences the round: it ends, and above all sends nothing, once too little of the lease is left for a send
  // to finish inside it, however long an awaited RPC took. Counted from before the lease was taken, with a margin.
  const deadline = started + DRAIN_LEASE_MS - LEASE_MARGIN_MS;
  const leaseEnd = started + DRAIN_LEASE_MS;
  const sendTimeout = deps.sendTimeoutMs ?? SEND_TIMEOUT_MS;
  const leaseLeft = () => deadline - now() > sendTimeout;
  // Every awaited call of the round is bounded by the round's deadline: past it, the round stops and sends nothing more.
  const bounded = <T>(work: () => Promise<T>) => within(work, deadline, now);
  // A send that timed out, or a call given up at the deadline, may still land until this invocation ends: the lease
  // is then kept, so no other drain starts until it has expired (DRAIN_LEASE_MS).
  let keepLease = false;
  try {
    await bounded(() => call("drainLease", { holder: deps.holder }));
    try {
      return { ok: true, ...(await round()) };
    } finally {
      if (!keepLease) {
        await within(() => call("drainLease", { holder: deps.holder, release: true }), leaseEnd, now);
      }
    }
  } catch (error) {
    if (error instanceof DrainRefusal) {
      return refused(409, error.code, error.message);
    }
    if (error instanceof DrainDeadline) {
      // Past the lease itself (even the report could not be read): nothing was sent after the deadline.
      return refused(409, "lease-expiring", "the drain round ran out of time; run it again");
    }
    throw error;
  }

  async function round(): Promise<DrainRound> {
    const result: Omit<DrainRound, "journal"> = {
      sent: 0,
      unverified: 0,
      noRecipient: 0,
      waiting: null,
      stopped: null,
    };
    // The report is read after the round stopped, and sends nothing: bounded by the lease itself.
    const finish = async () => ({
      ...result,
      journal: (await within(() => deps.store.cutoverStatus(deps.build), leaseEnd, now)).journal,
    });
    try {
      await steps(result);
    } catch (error) {
      if (!(error instanceof DrainDeadline)) {
        throw error;
      }
      result.stopped = "lease-expiring";
      result.waiting = null;
      keepLease = true;
    }
    return finish();
  }

  async function steps(result: Omit<DrainRound, "journal">): Promise<void> {
    // Read one after another: Kopje's Queue, the legacy Queue, and only after the legacy Queue was seen empty its
    // dead-letter queue, so a message that left the legacy Queue for its DLQ between the readings is seen there.
    const kopjeBacklog = await bounded(() => readQueueBacklog(env.QUEUE));
    const legacyBacklog = kopjeBacklog === null ? null : await bounded(() => readQueueBacklog(legacy));
    const legacyDead = legacyBacklog === null ? null : await bounded(() => readQueueBacklog(legacyDlq));
    if (kopjeBacklog === null || legacyBacklog === null || legacyDead === null) {
      result.stopped = "metrics-unavailable";
      return;
    }
    if (!legacyDead.empty) {
      result.stopped = "legacy-dlq";
      return;
    }
    // While the lane is busy, nothing is sent; the records are still verified, so that what fails for good is set
    // aside (and the journal's quota freed by the operator) without waiting.
    const legacyBusy = legacyBacklog.empty ? null : "legacy-backlog";
    let busy: DrainRound["waiting"] = kopjeBacklog.empty ? legacyBusy : "kopje-backlog";
    result.waiting = busy;
    const full = busy === "kopje-backlog" && (await journalFull());
    // The operator's escape from a full journal: only after the drain stopped on journal-full and reported it, and
    // while the journal is still in the state of that stop (the Store checks it); otherwise the drain stays ordered.
    const escape =
      full &&
      options.unordered === true &&
      (await bounded(() => call<{ matches: boolean }>("journalFullStop", deps.holder, "check"))).matches;
    if (escape) {
      // The journal's head goes past the collection barrier, so it may overtake an older request still in Kopje's
      // Queue (ordinary delivery reordering). The legacy lane still holds.
      busy = legacyBusy;
      result.waiting = busy;
    } else if (full) {
      // The barrier waits for requests the full journal cannot take: an operator decision, not a wait.
      await bounded(() => call("journalFullStop", deps.holder, "record"));
      result.waiting = null;
      result.stopped = "journal-full";
    }
    const loader = { ...deps.loader, userAgent: `Kopje/${PACKAGE_VERSION} (+https://${domain}/)` };
    const known = new Set(accounts as string[]);
    const ready: string[] = [];
    for (
      let kept = 0, examined = 0;
      kept < MAX_KEPT_PER_ROUND &&
      examined < MAX_EXAMINED_PER_ROUND &&
      now() - started < ROUND_BUDGET_MS &&
      leaseLeft();
      examined++
    ) {
      const { entry } = await bounded(() =>
        call<{
          entry: { id: string; spooledAt: number; record: Uint8Array; resend: boolean } | null;
        }>("journalNext", deps.holder, ready),
      );
      if (entry === null) {
        break;
      }
      const message = await decodeSpoolRecord(entry.record);
      const check =
        message === null
          ? ({ ok: false, transient: false, reason: "invalid-record" } as const)
          : await bounded(async () =>
              verifySpooledRequest(loader, domain, {
                url: message.url,
                method: message.method,
                headers: message.headers,
                body: await inflate(message.body),
                receivedAt: message.spooledAt,
              }),
            );
      if (!check.ok) {
        if (check.transient) {
          result.stopped ??= busy === null ? "key-unavailable" : null;
          break;
        }
        console.warn({ event: "kopje.cutover.drain.unverified", reason: check.reason });
        await bounded(() => call("journalMark", deps.holder, entry.id, "unverified"));
        result.unverified++;
        kept++;
        continue;
      }
      const recipient = legacyRecipient(
        new URL(message!.url).pathname,
        check.activity,
        domain,
        known,
        (fallback as string | undefined) ?? null,
      );
      const body =
        recipient === null
          ? null
          : legacyInboxMessage({
              activity: check.activity,
              recipient,
              signer: check.actor,
              userKek: kek,
              vapidKeys,
            });
      // No legacy recipient, or a message the legacy Queue cannot carry (its own inbox route had the same limit).
      if (body === null || new TextEncoder().encode(JSON.stringify(body)).byteLength > LEGACY_MESSAGE_LIMIT) {
        await bounded(() => call("journalMark", deps.holder, entry.id, "no-recipient"));
        result.noRecipient++;
        kept++;
        continue;
      }
      if (busy !== null) {
        // Verified and kept in its place; it is sent once the lane is free.
        ready.push(entry.id);
        continue;
      }
      if (!leaseLeft()) {
        result.stopped = "lease-expiring";
        break;
      }
      await bounded(() => call("journalMark", deps.holder, entry.id, "sending"));
      // The mark may have come back late: never send once the lease cannot cover the send.
      if (!leaseLeft()) {
        result.stopped = "lease-expiring";
        keepLease = true;
        break;
      }
      const sent = await withTimeout(lane.send(body), sendTimeout);
      if (sent !== "sent") {
        // The record stays 'sending' and is sent again by a later round (at least once).
        result.stopped = sent === "timeout" ? "legacy-queue-timeout" : "legacy-queue-failed";
        keepLease = sent === "timeout";
        break;
      }
      result.sent = 1;
      await bounded(() => call("journalMark", deps.holder, entry.id, "done"));
      break;
    }
  }

  async function journalFull(): Promise<boolean> {
    const journal = (await bounded(() => deps.store.cutoverStatus(deps.build))).journal;
    const entries = journal.pending + journal.sending + journal.unverified + journal.noRecipient;
    const settings = readConfig(env);
    const maxEntries = Math.min(
      (settings.ok ? settings.config.CUTOVER_JOURNAL_MAX_ENTRIES : undefined) ?? JOURNAL_MAX_ENTRIES,
      JOURNAL_MAX_ENTRIES,
    );
    const maxBytes = Math.min(
      (settings.ok ? settings.config.CUTOVER_JOURNAL_MAX_BYTES : undefined) ?? JOURNAL_MAX_BYTES,
      JOURNAL_MAX_BYTES,
    );
    return entries >= maxEntries || journal.bytes + SPOOL_MESSAGE_LIMIT > maxBytes;
  }
}

async function withTimeout(send: Promise<unknown>, ms: number): Promise<"sent" | "failed" | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  try {
    return await Promise.race([
      send.then(
        () => "sent" as const,
        () => "failed" as const,
      ),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

class DrainRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function refused(status: 400 | 409, code: string, message: string): DrainResult {
  return { ok: false, status, code, message };
}
