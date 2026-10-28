import { createExecutionContext, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { sign } from "hono/jwt";
import { vi } from "vitest";

import { type AppDeps, createApp } from "../src/app/app";
import { Db } from "../src/db/sql";
import { expandPending } from "../src/domain/deliveries";
import { allocateLocalId } from "../src/domain/ids";
import { writeOperation } from "../src/domain/operation";
import { accountSearchText } from "../src/domain/search-text";
import type { StoreStub } from "../src/platform/store-client";
import { NOW } from "./app-helpers";
import { BUILD, migratedStore, runStoreJobs } from "./helpers";

// Test-only seeding: tests insert accounts through this operation, run directly inside the Store.
type SeedAccount = {
  username: string;
  domain?: string;
  email?: string;
  displayName?: string;
  locked?: boolean;
  legacyId?: string;
  followersCount?: number;
};

const seedAccountOperation = writeOperation<SeedAccount & { now: number }, string>((db, input) => {
  const id = allocateLocalId(db, input.now);
  const domain = input.domain ?? null;
  const uri =
    domain === null ? `https://kopje.test/ap/users/${input.username}` : `https://${domain}/users/${input.username}`;
  const displayName = input.displayName ?? "";
  db.run(
    `INSERT INTO accounts (id, uri, username, domain, display_name, url, locked, followers_count, search_text,
			legacy_id, created_at, inbox_url, shared_inbox_url)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    uri,
    input.username,
    domain,
    displayName,
    domain === null ? null : `https://${domain}/@${input.username}`,
    input.locked === true ? 1 : 0,
    input.followersCount ?? 0,
    accountSearchText(input.username, domain, displayName),
    input.legacyId ?? null,
    new Date(input.now).toISOString(),
    // A remote account has its personal inbox and its server's shared inbox, as Mastodon publishes them.
    domain === null ? null : `${uri}/inbox`,
    domain === null ? null : `https://${domain}/inbox`,
  );
  if (domain === null) {
    db.run(
      "INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey) VALUES (?, ?, X'00', X'00', 'test')",
      id,
      input.email ?? `${input.username}@example.com`,
    );
  }
  return id;
});

export async function seedAccount(store: StoreStub, account: SeedAccount): Promise<string> {
  return runInDurableObject(store, (_instance, state) =>
    seedAccountOperation.run(state.storage.sql, { ...account, now: NOW }),
  );
}

export async function sql<T extends Record<string, SqlStorageValue>>(
  store: StoreStub,
  query: string,
  ...params: SqlStorageValue[]
): Promise<T[]> {
  return runInDurableObject(store, (_instance, state) => state.storage.sql.exec<T>(query, ...params).toArray());
}

// `count` new remote accounts of `domain` (ids from `base`), each with an accepted follow of `accountId`
// (`followers`) or followed by it (`following`), in one statement; then the account's counts are recomputed from its
// edges (recountFollows).
export async function seedFollows(
  store: StoreStub,
  accountId: string,
  count: number,
  options: { direction: "following" | "followers"; domain: string; base: number },
): Promise<void> {
  await sql(
    store,
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
		INSERT INTO accounts (id, uri, username, domain)
		SELECT printf('%018d', CAST(?2 AS INTEGER) + i), 'https://' || ?3 || '/users/u' || i, 'u' || i, ?3 FROM n`,
    count,
    options.base,
    options.domain,
  );
  const [mine, theirs] =
    options.direction === "following" ? ["account_id", "target_account_id"] : ["target_account_id", "account_id"];
  await sql(
    store,
    `INSERT INTO follows (${mine}, ${theirs}, state) SELECT ?1, id, 'accepted' FROM accounts WHERE domain = ?2`,
    accountId,
    options.domain,
  );
  await recountFollows(store, accountId);
}

// The account's counts as the follow writers keep them, recomputed from its accepted edges.
export async function recountFollows(store: StoreStub, accountId: string): Promise<void> {
  await sql(
    store,
    `UPDATE accounts SET
			followers_count = (SELECT COUNT(*) FROM follows WHERE target_account_id = ?1 AND state = 'accepted'),
			following_count = (SELECT COUNT(*) FROM follows WHERE account_id = ?1 AND state = 'accepted')
		WHERE id = ?1`,
    accountId,
  );
}

export async function setSetting(store: StoreStub, name: string, value: string): Promise<void> {
  await sql(store, "INSERT OR REPLACE INTO instance_settings (name, value) VALUES (?, ?)", name, value);
}

// A Cloudflare Access team of its own per test (the JWKS cache is per isolate and keyed by team domain).
export type AccessTeam = {
  teamDomain: string;
  aud: string;
  kid: string;
  assertion: (claims?: Record<string, unknown>, key?: CryptoKey | JsonWebKey) => Promise<string>;
  otherKey: JsonWebKey;
  fetch: ReturnType<typeof vi.fn<typeof fetch>>;
  // Publishes a new signing key next to the current one, as Access does before a rotation; returns its private key.
  rotate: () => Promise<JsonWebKey>;
};

async function rsaKey(kid: string): Promise<{ privateJwk: JsonWebKey; publicJwk: JsonWebKey }> {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const privateJwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  const publicJwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return {
    privateJwk: { ...privateJwk, alg: "RS256", kid } as JsonWebKey,
    publicJwk: { ...publicJwk, alg: "RS256", kid, use: "sig" } as JsonWebKey,
  };
}

export async function accessTeam(): Promise<AccessTeam> {
  const teamDomain = `team-${crypto.randomUUID().slice(0, 8)}.cloudflareaccess.com`;
  const aud = crypto.randomUUID().replace(/-/g, "");
  const kid = crypto.randomUUID();
  const key = await rsaKey(kid);
  // Same kid, different key: a token it signs must not verify.
  const other = await rsaKey(kid);
  const published = [key.publicJwk];
  const fetchJwks = vi.fn<typeof fetch>((input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== `https://${teamDomain}/cdn-cgi/access/certs`) {
      return Promise.resolve(new Response("not found", { status: 404 }));
    }
    return Promise.resolve(Response.json({ keys: published }));
  });
  return {
    teamDomain,
    aud,
    kid,
    otherKey: other.privateJwk,
    fetch: fetchJwks,
    rotate: async () => {
      const next = await rsaKey(crypto.randomUUID());
      published.push(next.publicJwk);
      return next.privateJwk;
    },
    assertion: (claims = {}, signingKey = key.privateJwk) =>
      sign(
        {
          aud: [aud],
          iss: `https://${teamDomain}`,
          email: "alice@example.com",
          sub: "user-1",
          iat: Math.floor(NOW / 1000) - 10,
          exp: Math.floor(NOW / 1000) + 3600,
          ...claims,
        },
        signingKey,
        "RS256",
      ),
  };
}

export type ApiHarness = Awaited<ReturnType<typeof apiHarness>>;

// The real app over a fresh migrated Store, with Access configured, an injected JWKS fetch and clock, and
// deterministic-looking but unique OAuth values.
// deps replaces the image codec, or wraps the Store stub the app calls (tests still reach the real Store as `store`).
export async function apiHarness(
  overrides: Record<string, unknown> = {},
  deps: Pick<AppDeps, "images" | "federation"> & { wrapStore?: ((store: StoreStub) => StoreStub) | undefined } = {},
) {
  const { wrapStore, ...seams } = deps;
  const store = await migratedStore();
  await setSetting(store, "domain", "kopje.test");
  const team = await accessTeam();
  await setSetting(store, "access_team_domain", team.teamDomain);
  await setSetting(store, "access_aud", team.aud);
  let counter = 0;
  const randomToken = () => `token-${++counter}-${crypto.randomUUID()}`;
  const now = vi.fn(() => NOW);
  const testEnv = { ...env, ...overrides };
  // Doorbells are recorded, never sent: the test pool's Queue would run the real consumer.
  const doorbell = vi.fn(() => Promise.resolve());
  const jobs = vi.fn(() => Promise.resolve());
  const app = createApp({
    build: () => env.CF_VERSION_METADATA.id,
    now,
    store: () => (wrapStore === undefined ? store : wrapStore(store)),
    fetch: team.fetch,
    randomToken,
    ...seams,
    doorbell,
    jobs,
  });
  // Work a response leaves running (waitUntil, such as the media sweep) settles before the request returns.
  const request = async (path: string, init?: RequestInit): Promise<Response> => {
    const ctx = createExecutionContext();
    const response = await app.fetch(new Request(`https://kopje.test${path}`, init), testEnv, ctx);
    await waitOnExecutionContext(ctx);
    return response;
  };
  return { store, team, request, now, env: testEnv, doorbell, jobs };
}

export function bearer(token: string, init: RequestInit = {}): RequestInit {
  return { ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` } };
}

export function json(body: unknown, init: RequestInit = {}): RequestInit {
  return {
    method: "POST",
    ...init,
    headers: { "content-type": "application/json", ...(init.headers as Record<string, string>) },
    body: JSON.stringify(body),
  };
}

export function form(body: Record<string, string>, init: RequestInit = {}): RequestInit {
  return {
    method: "POST",
    ...init,
    headers: { "content-type": "application/x-www-form-urlencoded", ...(init.headers as Record<string, string>) },
    body: new URLSearchParams(body).toString(),
  };
}

export type App = { client_id: string; client_secret: string; redirect_uri: string };

// The harness with the local account alice (alice@example.com, the default Access identity), and its id.
export async function withAlice() {
  const h = await apiHarness();
  const aliceId = await seedAccount(h.store, { username: "alice", email: "alice@example.com", displayName: "Alice" });
  return { ...h, aliceId };
}

export async function registerApp(
  h: ApiHarness,
  { scopes = "read write follow push", redirectUri = "https://client.test/callback" } = {},
): Promise<App> {
  const response = await h.request(
    "/api/v1/apps",
    json({ client_name: "Test Client", redirect_uris: redirectUri, scopes, website: "https://client.test" }),
  );
  if (response.status !== 200) {
    throw new Error(`app registration failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

export type AuthorizeOptions = {
  scope?: string;
  codeChallenge?: string;
  email?: string;
  state?: string;
  // The Access assertion sent instead of a valid one for `email`; null sends none.
  assertion?: string | null;
};

async function accessHeader(h: ApiHarness, options: AuthorizeOptions): Promise<Record<string, string>> {
  const assertion =
    options.assertion === undefined
      ? await h.team.assertion({ email: options.email ?? "alice@example.com" })
      : options.assertion;
  return assertion === null ? {} : { "cf-access-jwt-assertion": assertion };
}

function authorizeQuery(app: App, options: AuthorizeOptions): Record<string, string> {
  return {
    response_type: "code",
    client_id: app.client_id,
    redirect_uri: app.redirect_uri,
    scope: options.scope ?? "read write follow",
    ...(options.state === undefined ? {} : { state: options.state }),
    ...(options.codeChallenge === undefined
      ? {}
      : { code_challenge: options.codeChallenge, code_challenge_method: "S256" }),
  };
}

export async function consentPage(h: ApiHarness, app: App, options: AuthorizeOptions = {}): Promise<Response> {
  return h.request(`/oauth/authorize?${new URLSearchParams(authorizeQuery(app, options)).toString()}`, {
    headers: await accessHeader(h, options),
  });
}

// Posts the consent decision the way the consent page's form does.
export async function decide(
  h: ApiHarness,
  app: App,
  decision: "approve" | "deny",
  options: AuthorizeOptions = {},
): Promise<Response> {
  const { response_type: _, ...fields } = authorizeQuery(app, options);
  return h.request(
    "/oauth/authorize",
    form({ ...fields, decision }, { headers: { ...(await accessHeader(h, options)), origin: "https://kopje.test" } }),
  );
}

export async function authorizationCode(h: ApiHarness, app: App, options: AuthorizeOptions = {}): Promise<string> {
  const response = await decide(h, app, "approve", options);
  const location = response.headers.get("location");
  if (response.status !== 302 || location === null) {
    throw new Error(`authorization failed: ${response.status} ${await response.text()}`);
  }
  const code = new URL(location).searchParams.get("code");
  if (code === null) {
    throw new Error(`no code in ${location}`);
  }
  return code;
}

export function exchange(h: ApiHarness, app: App, code: string, extra: Record<string, string> = {}): Promise<Response> {
  return h.request(
    "/oauth/token",
    form({
      grant_type: "authorization_code",
      code,
      client_id: app.client_id,
      client_secret: app.client_secret,
      redirect_uri: app.redirect_uri,
      ...extra,
    }),
  );
}

// A full login: register an app, consent, and exchange the code.
export async function login(
  h: ApiHarness,
  options: AuthorizeOptions & { app?: App } = {},
): Promise<{ app: App; token: string }> {
  const app = options.app ?? (await registerApp(h));
  const code = await authorizationCode(h, app, options);
  const response = await exchange(h, app, code);
  if (response.status !== 200) {
    throw new Error(`token exchange failed: ${response.status} ${await response.text()}`);
  }
  const { access_token } = await response.json<{ access_token: string }>();
  return { app, token: access_token };
}

// A token of the local account with `email`, from an app registered with `scope`.
export async function userToken(h: ApiHarness, email: string, scope: string): Promise<string> {
  const app = await registerApp(h, { scopes: scope });
  return (await login(h, { app, scope, email })).token;
}

// Runs the Store's jobs (the moderation jobs among them, as the Queue and the cron do) until none is left; how many
// calls it took.
export async function settle(store: StoreStub): Promise<number> {
  for (let call = 1; call <= 200; call++) {
    if (!(await runStoreJobs(store, BUILD, { now: NOW })).pending) {
      return call;
    }
  }
  throw new Error("the jobs did not settle");
}

// settle, then every target the jobs staged (a status's Delete, a boost's Undo) written as deliveries rows at `now`,
// as a delivery round's claims expand them (expandPending), without claiming any.
export async function settleDeliveries(store: StoreStub, now = NOW): Promise<void> {
  await settle(store);
  await runInDurableObject(store, (_instance, state) => {
    const db = new Db(state.storage.sql);
    state.storage.transactionSync(() => expandPending(db, now, Number.MAX_SAFE_INTEGER));
  });
}
