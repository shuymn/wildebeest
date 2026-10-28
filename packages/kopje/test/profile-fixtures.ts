import {
  MAX_REMOTE_FIELDS,
  MOVED_ACCOUNT_CAPS,
  MOVED_URL_LIMIT,
  REMOTE_FIELDS_BYTES,
} from "../src/domain/account-columns";
import { USERNAME_LIMIT } from "../src/domain/accounts";
import { DOMAIN_BYTES } from "../src/platform/identity-bounds";
import type { StoreStub } from "../src/platform/store-client";
import { sanitizeRemoteBio } from "../src/security/html";
import { sql } from "./api-helpers";
import { ACCOUNT_EMOJIS_FULL } from "./emoji-fixtures";
import { LEGACY } from "./federation-helpers";
import { community, remoteAccount, remoteFollows } from "./status-helpers";

// Remote profile parts at their bounds (RES-2), shared by the answer-size tests, and a local profile with a remote
// follower, shared by the profile credential tests.

// The bytes of `text`, each code unit below 256 one byte (0xFF: no UTF-8 lead byte, so malformed UTF-8), for a value
// bound as raw bytes (CAST(? AS TEXT) stores them as they are).
export const rawBytes = (text: string) => new Uint8Array([...text].map((c) => c.charCodeAt(0))).buffer;

// A static image URL that migration 0061_account_static_images stores (exactly 512 bytes: 11, then 192 malformed
// bytes, then 309 backslashes) and that serializes within PROFILE_URL_LIMIT (each 0xFF becomes %EF%BF%BD), but whose
// JSON doubles the backslashes past it.
export const ESCAPED_STATIC_WITNESS = rawBytes(`https://x/?${"\u00ff".repeat(192)}${"\\".repeat(309)}`);

// alice with the legacy public key and a remote follower (fan@fans.example), so her profile Updates are recorded.
export async function aliceWithFollower(deps: Parameters<typeof community>[2] = {}, scope = "read write follow") {
  const h = await community(["alice"], scope, deps);
  await sql(h.store, "UPDATE local_accounts SET pubkey = ?", LEGACY.pubkey);
  await remoteFollows(h.store, await remoteAccount(h.store, "fan", "fans.example"), h.users.alice.id);
  return h;
}

// One profile field of an actor document.
export const field = (name: string, value: string) => ({ type: "PropertyValue", name, value });

// A bio of REMOTE_BIO_BYTES as a JSON string: control characters that escape to six bytes, among links the sanitizer
// grows.
export const MAX_BIO = sanitizeRemoteBio(`<p>${'\u0001"<a>x</a>'.repeat(20_000)}</p>`);

// MAX_REMOTE_FIELDS fields of names and values at their read bounds, about REMOTE_FIELDS_BYTES of JSON.
export const maxFields = () =>
  Array.from({ length: MAX_REMOTE_FIELDS }, () => field("n".repeat(255), "v".repeat(4096)));

// The largest attachment a read takes (REMOTE_ATTACHMENT_SQL): seven fields at their name and value bounds, and an
// eighth whose value fills the list's JSON to exactly REMOTE_FIELDS_BYTES.
export function fullestFields() {
  const entry = (value: number) => JSON.stringify({ name: "n".repeat(255), value: "v".repeat(value) }).length;
  const seven = 1 + 7 * (entry(4096) + 1);
  const last = 4096 - (entry(4096) + 1 - (REMOTE_FIELDS_BYTES - seven));
  return [
    ...Array.from({ length: 7 }, () => field("n".repeat(255), "v".repeat(4096))),
    field("n".repeat(255), "v".repeat(last)),
  ];
}

// What a moved-to account's row reads from SQLite at most (MOVED_ACCOUNT_CAPS), eight bytes for a number, as the
// answer-size tests count values.
export const MOVED_ROW_SQLITE_MAX = Object.values(MOVED_ACCOUNT_CAPS).reduce(
  (sum, bytes) => sum + (bytes === 0 ? 8 : bytes),
  0,
);

// Moves each of `sources` to an account of its own (ids from `base`) that reads at every cap of a moved-to account:
// URLs and actor id at MOVED_URL_LIMIT, a username of USERNAME_LIMIT, a domain of DOMAIN_BYTES, four-byte characters
// past the display name's and created_at's caps, and an emoji snapshot at its stored bound.
export async function movedAtCaps(store: StoreStub, sources: readonly string[], base: bigint): Promise<void> {
  const at = (prefix: string, bytes: number) => `${prefix}${"u".repeat(bytes)}`.slice(0, bytes);
  for (const [i, source] of sources.entries()) {
    const id = String(base + BigInt(i));
    await sql(
      store,
      `INSERT INTO accounts (id, uri, username, domain, display_name, url, avatar_url, header_url, emojis, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      at(`https://moved.example/users/${id}/`, MOVED_URL_LIMIT),
      `${"u".repeat(USERNAME_LIMIT - id.length)}${id}`,
      `${"d".repeat(DOMAIN_BYTES - 4)}.com`,
      "𠀀".repeat(2048),
      at(`https://moved.example/@${id}/`, MOVED_URL_LIMIT),
      at(`https://moved.example/a/${id}/`, MOVED_URL_LIMIT),
      at(`https://moved.example/h/${id}/`, MOVED_URL_LIMIT),
      ACCOUNT_EMOJIS_FULL,
      "𠀀".repeat(24),
    );
    await sql(store, "UPDATE accounts SET moved_to_account_id = ? WHERE id = ?", id, source);
  }
}
