import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { vi } from "vitest";

import { createApp } from "../src/app/app";
import { API_BASE } from "../src/platform/cloudflare-api";
import { type ImageCodec, ImageCodecError } from "../src/platform/images";
import type { StoreStub } from "../src/platform/store-client";
import { type AccessTeam, accessTeam, type ApiHarness, sql } from "./api-helpers";
import { NOW, offline } from "./app-helpers";
import { BUILD, migratedStore } from "./helpers";
import { QueueSim } from "./queue-sim";
import { ORIGIN, setCookies } from "./web-helpers";

// Driving /setup as an operator's browser would, against a fake of the Cloudflare API (never the real one).

export const SETUP_TOKEN = "setup-token-0123456789abcdefghijklmnopqrstuvwxyz";
export const SETUP = "__Host-kopje_setup";
export const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
export const SERVICE_TOKEN_CLIENT_ID = "abc123.access";
export const ADMIN = "owner@example.com";

type Item = Record<string, unknown> & { id: string; name: string };

export type Permission = "apps" | "org" | "tokens" | "accounts" | "zone" | "bot";

// A request the fake holds until the test releases it.
export type Hold = { reached: Promise<void>; release: () => void };

export type FakeCloudflare = {
  fetch: ReturnType<typeof vi.fn<typeof fetch>>;
  apps: Item[];
  policies: Item[];
  // Every API call: method, path and the bearer token it carried.
  calls: { method: string; path: string; token: string | null; body: unknown }[];
  writes: () => FakeCloudflare["calls"];
  // The token's accounts and their Zero Trust team.
  accounts: { id: string; name: string; authDomain: string }[];
  permissions: Set<Permission>;
  // The next API call fails with this status and an error message that echoes the token.
  failNext: (status: number, message?: (token: string) => string) => void;
  // The n-th write from now is applied, then answered with 500 (a failure after an external mutation).
  failAfterWrite: (n: number) => void;
  // The next API call answers with a redirect to a URL that carries the token.
  redirectNext: () => void;
  // The next fetch throws an error whose name and message are the token.
  throwNext: () => void;
  // Holds the first request that matches, until released.
  hold: (match: (method: string, path: string) => boolean) => Hold;
  botSettings: Record<string, unknown> | null;
  signInAud: () => string;
  serviceTokens: { id: string; client_id: string; name: string }[];
  // Policies are listed without app_count.
  omitAppCount: boolean;
  // The next write is applied but answered without the object's id.
  stripIdNext: () => void;
};

const MAX_PER_PAGE: Record<string, number> = { "/accounts": 50 };

// The Access API of the token's accounts (organizations, apps, reusable policies, service tokens), zones and Bot
// Management, with the API's pagination, permission errors and validation of what is written. Unknown routes are
// 404. The team's key set is served by `team`.
export function fakeCloudflare(team: AccessTeam): FakeCloudflare {
  const apps: Item[] = [];
  const policies: Item[] = [];
  const calls: FakeCloudflare["calls"] = [];
  let failure: { status: number; message: (token: string) => string } | null = null;
  let failAfter: number | null = null;
  let redirect = false;
  let throwing = false;
  let stripId = false;
  const holds: { match: (method: string, path: string) => boolean; reached: () => void; gate: Promise<void> }[] = [];
  const audOf = () => crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
  const fake: FakeCloudflare = {
    apps,
    policies,
    calls,
    writes: () => calls.filter((call) => call.method !== "GET"),
    accounts: [{ id: ACCOUNT_ID, name: "Operator", authDomain: team.teamDomain }],
    permissions: new Set<Permission>(["apps", "org", "tokens", "accounts", "zone", "bot"]),
    failNext: (status, message = (token) => `Authentication error for ${token}`) => {
      failure = { status, message };
    },
    failAfterWrite: (n) => {
      failAfter = n;
    },
    redirectNext: () => {
      redirect = true;
    },
    throwNext: () => {
      throwing = true;
    },
    hold: (match) => {
      let reached = () => {};
      let release = () => {};
      const reachedPromise = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      holds.push({ match, reached, gate });
      return { reached: reachedPromise, release };
    },
    botSettings: { fight_mode: false },
    serviceTokens: [{ id: "token-uuid-1", client_id: SERVICE_TOKEN_CLIENT_ID, name: "cli" }],
    omitAppCount: false,
    stripIdNext: () => {
      stripId = true;
    },
    signInAud: () => {
      const aud = apps.find((app) => String(app.domain).endsWith("/oauth/authorize"))?.aud;
      return typeof aud === "string" ? aud : "";
    },
    fetch: vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const apiPath = request.url.startsWith(API_BASE) ? url.pathname.slice(new URL(API_BASE).pathname.length) : null;
      const at = holds.findIndex((h) => h.match(request.method, apiPath ?? url.href));
      const held = holds[at];
      if (held !== undefined) {
        holds.splice(at, 1);
        held.reached();
        await held.gate;
      }
      if (apiPath === null) {
        return team.fetch(input, init);
      }
      const path = apiPath;
      const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? null;
      if (throwing) {
        throwing = false;
        const error = new Error(`fetch failed for ${token}`);
        error.name = `Token${token}`;
        throw error;
      }
      const body: unknown = request.method === "GET" ? undefined : await request.json();
      calls.push({ method: request.method, path, token, body });
      const error = (status: number, code: number, message = "error") =>
        Response.json({ success: false, errors: [{ code, message }], messages: [], result: null }, { status });
      if (redirect) {
        redirect = false;
        return new Response(null, { status: 302, headers: { location: `https://evil.test/?t=${token}` } });
      }
      if (failure !== null) {
        const { status, message } = failure;
        failure = null;
        return error(status, 10000, message(token ?? ""));
      }
      const ok = (result: unknown, info?: Record<string, number>) =>
        Response.json({ success: true, errors: [], messages: [], result, ...(info ? { result_info: info } : {}) });
      const page = (items: unknown[]) => {
        const max = MAX_PER_PAGE[path] ?? 100;
        const perPage = Number(url.searchParams.get("per_page") ?? "20");
        const number = Number(url.searchParams.get("page") ?? "1");
        if (!Number.isInteger(perPage) || perPage < 5 || perPage > max || !Number.isInteger(number) || number < 1) {
          return error(400, 1001, "per_page out of range");
        }
        const slice = items.slice((number - 1) * perPage, number * perPage);
        return ok(slice, {
          page: number,
          per_page: perPage,
          count: slice.length,
          total_count: items.length,
          total_pages: Math.max(1, Math.ceil(items.length / perPage)),
        });
      };
      const need = (permission: Permission) => (fake.permissions.has(permission) ? null : error(403, 10000));
      // A write is applied; the n-th is then answered with 500.
      const written = (result: unknown) => {
        if (failAfter !== null && --failAfter === 0) {
          failAfter = null;
          return error(500, 10001, "internal error");
        }
        if (stripId) {
          stripId = false;
          const { id: _id, ...rest } = result as Item;
          return ok(rest);
        }
        return ok(result);
      };

      if (path === "/accounts" && request.method === "GET") {
        return need("accounts") ?? page(fake.accounts.map(({ id, name }) => ({ id, name })));
      }
      const accountMatch = /^\/accounts\/([0-9a-f]{32})\/access(\/.*)$/.exec(path);
      const account = fake.accounts.find((a) => a.id === accountMatch?.[1]);
      if (accountMatch !== null) {
        if (account === undefined) {
          return error(403, 10000);
        }
        const rest = accountMatch[2] ?? "";
        if (rest === "/organizations" && request.method === "GET") {
          return need("org") ?? ok({ auth_domain: account.authDomain, name: account.name });
        }
        if (rest === "/service_tokens" && request.method === "GET") {
          return need("tokens") ?? page(fake.serviceTokens);
        }
        const denied = need("apps");
        if (denied !== null) {
          return denied;
        }
        const policyView = (policy: Item) =>
          fake.omitAppCount
            ? { ...policy }
            : {
                ...policy,
                app_count: apps.filter((app) => (app.policies as { id: string }[]).some((p) => p.id === policy.id))
                  .length,
              };
        if (rest === "/policies" || rest.startsWith("/policies/")) {
          const id = rest.slice("/policies/".length);
          const existing = policies.find((p) => p.id === id);
          if (request.method === "GET") {
            return rest === "/policies"
              ? page(policies.map(policyView))
              : existing === undefined
                ? error(404, 12130)
                : ok(policyView(existing));
          }
          const b = body as Item;
          if (
            typeof b?.name !== "string" ||
            !["allow", "deny", "non_identity", "bypass"].includes(String(b.decision)) ||
            !Array.isArray(b.include) ||
            b.include.length === 0
          ) {
            return error(400, 12130, "invalid policy");
          }
          if (request.method === "POST" && rest === "/policies") {
            const policy = { ...b, id: crypto.randomUUID() };
            policies.push(policy);
            return written(policyView(policy));
          }
          if (request.method === "PUT" && existing !== undefined) {
            Object.assign(existing, b, { id: existing.id });
            return written(policyView(existing));
          }
          return error(404, 12130);
        }
        if (rest === "/apps" || rest.startsWith("/apps/")) {
          const id = rest.slice("/apps/".length);
          const existing = apps.find((a) => a.id === id);
          if (request.method === "GET") {
            if (rest !== "/apps") {
              return existing === undefined ? error(404, 12130) : ok(existing);
            }
            const name = url.searchParams.get("name");
            const exact = url.searchParams.get("exact") === "true";
            return page(apps.filter((app) => name === null || (exact ? app.name === name : app.name.includes(name))));
          }
          const b = body as Item;
          const destinations = b?.destinations as { type?: unknown; uri?: unknown }[] | undefined;
          const links = b?.policies as { id?: unknown; precedence?: unknown }[] | undefined;
          const valid =
            typeof b?.name === "string" &&
            b.type === "self_hosted" &&
            typeof b.domain === "string" &&
            Array.isArray(destinations) &&
            destinations.length > 0 &&
            destinations.every((d) => d.type === "public" && typeof d.uri === "string") &&
            destinations[0]?.uri === b.domain &&
            Array.isArray(links) &&
            links.every((l) => policies.some((p) => p.id === l.id) && typeof l.precedence === "number") &&
            new Set(links.map((l) => l.precedence)).size === links.length;
          if (!valid) {
            return error(400, 12130, "invalid application");
          }
          if (request.method === "POST" && rest === "/apps") {
            const app = { ...b, id: crypto.randomUUID(), aud: audOf() };
            apps.push(app);
            return written(app);
          }
          if (request.method === "PUT" && existing !== undefined) {
            Object.assign(existing, b, { id: existing.id, aud: existing.aud });
            return written(existing);
          }
          return error(404, 12130);
        }
        return error(404, 7003);
      }
      if (path === "/zones" && request.method === "GET") {
        const name = url.searchParams.get("name");
        return need("zone") ?? ok(name === "kopje.test" ? [{ id: "zone-1", name }] : []);
      }
      if (path === "/zones/zone-1/bot_management" && request.method === "GET") {
        return need("bot") ?? (fake.botSettings === null ? error(403, 9109) : ok(fake.botSettings));
      }
      return error(404, 7003);
    }),
  };
  return fake;
}

// A codec that answers like the Images binding: a WebP, or the given error code.
export function fakeImages(error: number | null = null): ImageCodec {
  const webp = new TextEncoder().encode("RIFF\u0000\u0000\u0000\u0000WEBPVP8 ");
  return {
    info: () => Promise.resolve({ format: "image/webp", width: 1, height: 1 }),
    encode: () => (error === null ? Promise.resolve(webp) : Promise.reject(new ImageCodecError(error, "images"))),
  };
}

export type SetupHarness = Awaited<ReturnType<typeof setupHarness>>;

export async function setupHarness(
  options: {
    overrides?: Record<string, unknown>;
    images?: ImageCodec;
    store?: StoreStub;
    // Wraps the Store stub the app calls (tests still reach the real Store as `store`).
    wrapStore?: ((store: StoreStub) => StoreStub) | undefined;
  } = {},
) {
  const store = options.store ?? (await migratedStore());
  const team = await accessTeam();
  const cf = fakeCloudflare(team);
  const queue = new QueueSim();
  let counter = 0;
  const testEnv = {
    ...env,
    QUEUE: queue.queue,
    SETUP_TOKEN,
    ...options.overrides,
  } as unknown as Env;
  let clock = NOW;
  const app = createApp({
    build: () => BUILD,
    now: () => clock,
    store: () => (options.wrapStore === undefined ? store : options.wrapStore(store)),
    fetch: cf.fetch,
    federation: offline,
    randomToken: () => `token-${++counter}-${crypto.randomUUID()}`,
    images: () => options.images ?? fakeImages(),
    doorbell: () => Promise.resolve(),
  });
  const request = async (path: string, init?: RequestInit, origin = ORIGIN): Promise<Response> => {
    const ctx = createExecutionContext();
    const response = await app.fetch(new Request(`${origin}${path}`, init), testEnv, ctx);
    await waitOnExecutionContext(ctx);
    return response;
  };
  const advance = (ms: number) => {
    clock += ms;
  };
  // web-helpers' sign-in drives this harness like apiHarness: request and team are what it uses.
  const signInTeam = {
    ...team,
    assertion: (claims: Record<string, unknown> = {}, key?: CryptoKey | JsonWebKey) =>
      team.assertion({ aud: [cf.signInAud()], ...claims }, key),
  };
  const asApi = { store, team: signInTeam, request, env: testEnv } as unknown as ApiHarness;
  return { store, team, cf, queue, request, env: testEnv, advance, asApi };
}

// A browser that entered the setup token: its Cookie header and the setup page's form token.
export type SetupBrowser = { cookie: string; secret: string };

export async function setupLogin(h: SetupHarness, token = SETUP_TOKEN): Promise<SetupBrowser> {
  const response = await h.request("/setup/login", {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }).toString(),
  });
  const secret = setCookies(response).values.get(SETUP);
  if (response.status !== 303 || secret === undefined) {
    throw new Error(`setup login failed: ${response.status}`);
  }
  return { cookie: `${SETUP}=${encodeURIComponent(secret)}`, secret };
}

export async function formToken(h: SetupHarness, cookie: string): Promise<string> {
  const page = await h.request("/setup", { headers: { cookie } });
  const token = /name="csrf" value="([^"]+)"/.exec(await page.text())?.[1];
  if (token === undefined) {
    throw new Error(`no form token on /setup (${page.status})`);
  }
  return token;
}

// A form post from the setup page (origin null leaves the header out). The form token is fetched unless given.
export async function setupPost(
  h: SetupHarness,
  cookie: string,
  path: string,
  fields: Record<string, string> = {},
  options: { origin?: string | null; csrf?: string | null } = {},
): Promise<Response> {
  const origin = options.origin === undefined ? ORIGIN : options.origin;
  const csrf = options.csrf === undefined ? await formToken(h, cookie) : options.csrf;
  const headers: Record<string, string> = { cookie, "content-type": "application/x-www-form-urlencoded" };
  if (origin !== null) {
    headers.origin = origin;
  }
  const body = new URLSearchParams({ ...fields, ...(csrf === null ? {} : { csrf }) });
  return h.request(path, { method: "POST", headers, body: body.toString() });
}

// Low entropy on purpose (no secret scanner should mistake it), and no 6-character run of it appears elsewhere.
export const API_TOKEN = "qzqzqzqzwxwxwxwxjvjvjvjvkykykyky";

export function accessFields(h: SetupHarness, apiToken = API_TOKEN, extra: Record<string, string> = {}) {
  return {
    team: h.team.teamDomain.split(".")[0] ?? "",
    admin_email: ADMIN,
    api_token: apiToken,
    ...extra,
  };
}

// Steps 1, 3 and 7 for one setup browser.
export async function completeWizard(h: SetupHarness, browser: SetupBrowser, username = "owner"): Promise<Response> {
  await setupPost(h, browser.cookie, "/setup/domain", { domain: "kopje.test" });
  const access = await setupPost(h, browser.cookie, "/setup/access", accessFields(h));
  if (access.status !== 200) {
    throw new Error(`access step failed: ${access.status} ${await access.text()}`);
  }
  return setupPost(h, browser.cookie, "/setup/admin", { username, email: ADMIN });
}

export async function pageText(h: SetupHarness, cookie: string): Promise<string> {
  return (await h.request("/setup", { headers: { cookie } })).text();
}

// A setup browser with the domain confirmed.
export async function readyBrowser(h: SetupHarness): Promise<SetupBrowser> {
  const browser = await setupLogin(h);
  await setupPost(h, browser.cookie, "/setup/domain", { domain: "kopje.test" });
  return browser;
}

// The Store's record of Access reconciliations (domain/setup.ts).
export async function accessRecord(h: SetupHarness): Promise<{
  revision: number;
  reservation: { revision: number } | null;
  completed: { revision: number; access: { adminEmail: string } } | null;
  needsReconcile: boolean;
  managed: Record<string, string>;
  lateFailure?: { revision: number; at: number };
} | null> {
  const [row] = await sql<{ value: string }>(h.store, "SELECT value FROM kopje_state WHERE name = 'setup_access'");
  return row === undefined ? null : (JSON.parse(row.value) as Awaited<ReturnType<typeof accessRecord>>);
}

// Every substring of the secret of at least `length` characters that appears in the text.
export function fragmentsOf(secret: string, text: string, length = 6): string[] {
  const found: string[] = [];
  for (let i = 0; i + length <= secret.length; i++) {
    const part = secret.slice(i, i + length);
    if (text.includes(part)) {
      found.push(part);
    }
  }
  return found;
}

// A Store stub whose named RPCs are replaced; every other call goes to the real Store.
export function storeWith(
  store: StoreStub,
  replaced: Record<string, (...args: unknown[]) => Promise<unknown>>,
): StoreStub {
  return new Proxy(store, {
    get(target, property) {
      // An RPC method is taken from the stub as it is: detached from it, it does not reach the Store.
      return typeof property === "string" && property in replaced
        ? replaced[property]
        : (Reflect.get(target, property) as unknown);
    },
  });
}
