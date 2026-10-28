import { runInDurableObject } from "cloudflare:test";

import type { StoreStub } from "../src/platform/store-client";
import { base64ToBytes, importPublicKeyPem, RSA_ALGORITHM, type KeyGen } from "../src/security/key-wrap";
import legacy from "./fixtures/legacy-keys.json";

// A key pair wrapped by the legacy wildebeest code (fixtures/legacy-keys.json), with its KEK.
export const LEGACY = {
  kek: legacy.kek.kek,
  privkey: base64ToBytes(legacy.kek.privkey),
  salt: base64ToBytes(legacy.kek.salt),
  pubkey: legacy.kek.pubkey,
  pkcs8: base64ToBytes(legacy.kek.pkcs8),
};

// Makes `accountId` sign with LEGACY's key, so a delivery round can load its signer.
export async function signAsLegacy(store: StoreStub, accountId: string): Promise<void> {
  await runInDurableObject(store, (_instance, state) => {
    state.storage.sql.exec(
      "UPDATE local_accounts SET privkey = ?, privkey_salt = ?, pubkey = ? WHERE account_id = ?",
      LEGACY.privkey.slice().buffer,
      LEGACY.salt.slice().buffer,
      LEGACY.pubkey,
      accountId,
    );
  });
}

export const LEGACY_EMPTY_KEK = {
  kek: legacy.emptyKek.kek,
  privkey: base64ToBytes(legacy.emptyKek.privkey),
  salt: base64ToBytes(legacy.emptyKek.salt),
  pubkey: legacy.emptyKek.pubkey,
  pkcs8: base64ToBytes(legacy.emptyKek.pkcs8),
};

// Keygen that returns the fixture pair instead of generating a 4096-bit key.
export const fixtureKeyGen: KeyGen = async () => ({
  privateKey: await crypto.subtle.importKey("pkcs8", LEGACY_EMPTY_KEK.pkcs8, RSA_ALGORITHM, true, ["sign"]),
  publicKey: await importPublicKeyPem(LEGACY_EMPTY_KEK.pubkey),
});

export async function setDomain(store: StoreStub, domain: string): Promise<void> {
  await runInDurableObject(store, (_instance, state) => {
    state.storage.sql.exec("INSERT OR REPLACE INTO instance_settings (name, value) VALUES ('domain', ?)", domain);
  });
}

export type SeedAccount = {
  id: string;
  username: string;
  displayName?: string;
  note?: string;
  locked?: boolean;
  key?: { privkey: Uint8Array; salt: Uint8Array; pubkey: string };
  createdAt?: string;
};

// A local account as /setup or the account API would create it, with the legacy fixture key by default.
export async function seedLocalAccount(store: StoreStub, domain: string, account: SeedAccount): Promise<void> {
  const key = account.key ?? LEGACY;
  await runInDurableObject(store, (_instance, state) => {
    const sql = state.storage.sql;
    sql.exec(
      `INSERT INTO accounts (id, uri, username, domain, display_name, note, locked, discoverable, created_at)
			VALUES (?, ?, ?, NULL, ?, ?, ?, 1, ?)`,
      account.id,
      `https://${domain}/ap/users/${account.username}`,
      account.username,
      account.displayName ?? "",
      account.note ?? "",
      account.locked === true ? 1 : 0,
      account.createdAt ?? "2026-10-01T00:00:00.000Z",
    );
    sql.exec(
      "INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, ?, ?, ?, ?)",
      account.id,
      `${account.username}@mail.example`,
      key.privkey,
      key.salt,
      key.pubkey,
    );
  });
}

export async function seedRemoteAccount(store: StoreStub, id: string, uri: string, domain: string): Promise<void> {
  await runInDurableObject(store, (_instance, state) => {
    state.storage.sql.exec(
      "INSERT INTO accounts (id, uri, username, domain, inbox_url) VALUES (?, ?, ?, ?, ?)",
      id,
      uri,
      uri.split("/").at(-1) ?? "remote",
      domain,
      `${uri}/inbox`,
    );
  });
}

// Verifies a draft-cavage signature by rebuilding the signing string, independently of Fedify's verifier.
export async function verifyCavage(request: Request, pubkey: string): Promise<boolean> {
  const header = request.headers.get("signature") ?? "";
  const params: Record<string, string | undefined> = Object.fromEntries(
    [...header.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]),
  );
  const url = new URL(request.url);
  const lines = (params.headers ?? "").split(" ").map((name: string) =>
    name === "(request-target)"
      ? `(request-target): ${request.method.toLowerCase()} ${url.pathname}${url.search}`
      : // Host is the URL's when the header is absent, as Fedify and Mastodon rebuild it.
        `${name}: ${request.headers.get(name) ?? (name === "host" ? url.host : "")}`,
  );
  return crypto.subtle.verify(
    RSA_ALGORITHM,
    await importPublicKeyPem(pubkey),
    base64ToBytes(params.signature ?? ""),
    new TextEncoder().encode(lines.join("\n")),
  );
}

export async function seedFollow(
  store: StoreStub,
  follower: string,
  target: string,
  state = "accepted",
): Promise<void> {
  await runInDurableObject(store, (_instance, s) => {
    s.storage.sql.exec(
      "INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, ?)",
      follower,
      target,
      state,
    );
  });
}
