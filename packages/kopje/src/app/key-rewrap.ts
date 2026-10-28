import type { RewrapKey } from "../domain/actors";
import type { ImportAuthority } from "../platform/store-admin";
import type { StoreStub } from "../platform/store-client";
import { rewrapPkcs8, wrapsAlike } from "../security/key-wrap";
import { checkKey } from "../security/keyring";

// The KEK rewrap (`kopje-admin keys rewrap`, docs/setup.md "Rotating the KEK"): every local key (the local users and
// the instance actor, the keys healthReport checks) moves from USER_KEK_PREVIOUS to USER_KEK, the same private key under
// a new wrapping with a fresh salt. The key pair does not change, so nothing is announced to other servers. One call
// handles one page of the Store's keys (KEY_PAGE); the CLI follows `next` until `done`.
//
// Per key: one that already passes checkKey under USER_KEK is current and left alone, so a rerun after an interruption
// changes nothing it has done. One that passes under USER_KEK_PREVIOUS is unwrapped and wrapped again here, in the
// Worker, checked under USER_KEK (unwrap and a signature that verifies against the stored public key), and then written
// by the Store only if the stored key is still the one that was read. Any other key is reported by owner with a fixed
// reason and left unchanged. Unwrapped material lives only inside this call; the result carries counts, owners and
// reason codes only, never a key, a KEK or anything derived from them (DATA-1, DATA-5).
//
// There is no fallback in the keyring: from the moment USER_KEK changes until the rewrap has run, every key under the
// previous KEK fails to sign (docs/setup.md says how to hold outgoing work meanwhile).

// unwrap-failed: neither KEK unwraps it; pubkey-mismatch: a KEK unwraps it, but its signature does not verify against
// the stored public key; changed: the stored key changed after it was read (run the rewrap again); recheck-failed: the
// rewrapped key did not pass the check, so it was not written.
export type RewrapFailure = {
  owner: string;
  reason: "unwrap-failed" | "pubkey-mismatch" | "changed" | "recheck-failed";
};

export type RewrapStep =
  | {
      ok: true;
      counts: { rewrapped: number; current: number; failed: number };
      failures: RewrapFailure[];
      // True when this call handled the last page; otherwise the next call continues after `next`.
      done: boolean;
      next: string | null;
    }
  | { ok: false; code: "kek-empty" | "kek-unchanged" | "wrong-authority"; message: string };

export type RewrapDeps = {
  build: string;
  store: StoreStub;
  authority: ImportAuthority;
  // USER_KEK and USER_KEK_PREVIOUS as userKek and previousUserKek read them.
  kek: string;
  previous: string;
};

export const INSTANCE_ACTOR_OWNER = "(instance actor)";

export async function rewrapKeys(deps: RewrapDeps, input: { after: string | null }): Promise<RewrapStep> {
  const { build, store, authority, kek, previous } = deps;
  // Compared by what they unwrap, not as strings (wrapsAlike): a KEK the empty KEK can stand in for protects nothing.
  if (await wrapsAlike(kek, "")) {
    return { ok: false, code: "kek-empty", message: "set USER_KEK to the new KEK before rewrapping" };
  }
  if (await wrapsAlike(kek, previous)) {
    return {
      ok: false,
      code: "kek-unchanged",
      message: "USER_KEK equals USER_KEK_PREVIOUS (unset reads as empty); there is nothing to rewrap to",
    };
  }
  const page = await store.rewrapKeys(build, { after: input.after });
  const counts = { rewrapped: 0, current: 0, failed: 0 };
  const failures: RewrapFailure[] = [];
  const fail = (entry: RewrapKey, reason: RewrapFailure["reason"]) => {
    counts.failed++;
    failures.push({ owner: entry.owner ?? INSTANCE_ACTOR_OWNER, reason });
  };
  for (const entry of page.keys) {
    const { key } = entry;
    const now = await checkKey(kek, key);
    if (now === "ok") {
      counts.current++;
      continue;
    }
    const before = await checkKey(previous, key);
    if (before !== "ok") {
      fail(entry, now === "pubkey-mismatch" ? now : before);
      continue;
    }
    const wrapped = await rewrapPkcs8(previous, kek, key);
    if ((await checkKey(kek, { ...wrapped, pubkey: key.pubkey })) !== "ok") {
      fail(entry, "recheck-failed");
      continue;
    }
    const written = await store.rewrapKey(build, { authority, account: entry.account, read: key, wrapped });
    if (written.status === "denied") {
      return { ok: false, code: "wrong-authority", message: written.reason };
    }
    if (written.status === "changed") {
      fail(entry, "changed");
      continue;
    }
    counts.rewrapped++;
  }
  return { ok: true, counts, failures, done: page.done, next: page.next };
}
