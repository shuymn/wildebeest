// The Cloudflare API calls of /setup: checking the Zero Trust team, making the two Access applications and
// their policies, and reading Bot Fight Mode. Plain fetch against https://api.cloudflare.com/client/v4: a handful of
// endpoints does not need the official SDK, and the Worker stays within its size budget.
//
// SETUP-4: the API token lives only in the closure of one request's client. It is sent only to api.cloudflare.com as a
// bearer token, redirects are never followed, and nothing the API or the runtime says is kept as text: a failure is a
// CloudflareApiError of a fixed category, with the step (a literal of this module), the HTTP status and the API's
// numeric error codes, validated. Its message is made from those alone.

export const API_BASE = "https://api.cloudflare.com/client/v4";

// Pages of a listing read at most. Reaching it fails the run: a partial listing is never taken for a complete one.
const MAX_PAGES = 20;
const TIMEOUT_MS = 10_000;

export type ApiErrorCategory =
  | "unreachable"
  | "redirect"
  | "unauthorized"
  | "not_found"
  | "rate_limited"
  | "rejected"
  | "server"
  | "malformed"
  | "incomplete"
  | "invalid_account"
  | "no_account"
  | "account_count"
  | "team_mismatch"
  | "no_service_token"
  | "ambiguous"
  | "foreign"
  | "shared_policy"
  | "no_aud";

const DESCRIPTIONS: Record<ApiErrorCategory, string> = {
  unreachable: "the Cloudflare API could not be reached",
  redirect: "the Cloudflare API answered with a redirect, which is not followed",
  unauthorized: "the token lacks a permission this step needs, or it expired",
  not_found: "the object was not found",
  rate_limited: "the Cloudflare API is rate limiting this token; try again in a minute",
  rejected: "the Cloudflare API refused the request",
  server: "the Cloudflare API failed; try again later",
  malformed: "the Cloudflare API answered with something unexpected",
  incomplete: "the listing is longer than Kopje reads; nothing was changed",
  invalid_account: "the account ID must be 32 hexadecimal characters",
  no_account: "the token reaches no account; give it Account Settings Read, or enter the account ID",
  account_count: "the token reaches several accounts; enter the account ID of the one to use",
  team_mismatch: "the team is not this account's Zero Trust organization",
  no_service_token: "no service token of this account has that client ID",
  ambiguous: "several objects have this name; delete the extra ones, or create new objects",
  foreign: "an object of this name exists but is not what Kopje expects; adopt it deliberately, or create new objects",
  shared_policy:
    "this reusable policy is attached to other applications too; adopt it deliberately, or create new objects",
  no_aud: "the Cloudflare API returned an application without an AUD tag",
};

// Thrown instead of dispatching a request when too little of the run's lease is left (DispatchFence).
export class DispatchFenced extends Error {
  constructor() {
    super("the reservation does not leave time for another request");
    this.name = "DispatchFenced";
  }
}

// Called immediately before each request: the abort signal the request gets, or DispatchFenced when it must not be
// sent at all. /setup binds it to the lease deadline the Store issued (app/setup.tsx).
export type DispatchFence = () => AbortSignal;

const unfenced: DispatchFence = () => AbortSignal.timeout(TIMEOUT_MS);

export class CloudflareApiError extends Error {
  constructor(
    readonly category: ApiErrorCategory,
    readonly step: string,
    readonly status: number = 0,
    readonly codes: readonly number[] = [],
    // Kopje's own name of the object concerned (ambiguous, foreign, shared_policy).
    readonly subject: string | null = null,
  ) {
    const detail = [status === 0 ? null : `HTTP ${status}`, codes.length === 0 ? null : `codes ${codes.join(", ")}`]
      .filter((part) => part !== null)
      .join(", ");
    super(
      `${step}: ${DESCRIPTIONS[category]}${subject === null ? "" : ` (${subject})`}${detail === "" ? "" : ` [${detail}]`}`,
    );
    this.name = "CloudflareApiError";
  }
}

type Envelope = {
  success?: unknown;
  result?: unknown;
  errors?: unknown;
  result_info?: { page?: unknown; per_page?: unknown; total_pages?: unknown };
};

// The API's error codes: integers only, at most three.
function codesOf(errors: unknown): number[] {
  if (!Array.isArray(errors)) {
    return [];
  }
  return errors
    .map((e) => (typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined))
    .filter((code): code is number => typeof code === "number" && Number.isInteger(code) && code >= 0 && code < 1e7)
    .slice(0, 3);
}

function categoryOf(status: number): ApiErrorCategory {
  if (status >= 300 && status < 400) {
    return "redirect";
  }
  if (status === 401 || status === 403) {
    return "unauthorized";
  }
  if (status === 404) {
    return "not_found";
  }
  if (status === 429) {
    return "rate_limited";
  }
  return status >= 500 ? "server" : "rejected";
}

export type CloudflareApi = {
  get<T>(step: string, path: string, query?: Record<string, string>): Promise<T>;
  list<T>(step: string, path: string, perPage: number, query?: Record<string, string>): Promise<T[]>;
  send<T>(step: string, method: "POST" | "PUT", path: string, body: unknown): Promise<T>;
};

export function cloudflareApi(token: string, fetcher: typeof fetch, fence: DispatchFence = unfenced): CloudflareApi {
  async function call(step: string, method: string, path: string, query: Record<string, string>, body?: unknown) {
    const url = new URL(`${API_BASE}${path}`);
    for (const [name, value] of Object.entries(query)) {
      url.searchParams.set(name, value);
    }
    const signal = fence();
    let response: Response;
    try {
      response = await fetcher(url.toString(), {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        // Workers have no 'error': a redirect answers 3xx, which is refused below.
        redirect: "manual",
        signal,
      });
    } catch {
      throw new CloudflareApiError("unreachable", step);
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new CloudflareApiError("redirect", step, response.status);
    }
    let envelope: Envelope;
    try {
      envelope = (await response.json()) as Envelope;
    } catch {
      throw new CloudflareApiError(response.ok ? "malformed" : categoryOf(response.status), step, response.status);
    }
    if (!response.ok || envelope.success !== true) {
      throw new CloudflareApiError(
        response.ok ? "rejected" : categoryOf(response.status),
        step,
        response.status,
        codesOf(envelope.errors),
      );
    }
    if (envelope.result === undefined || envelope.result === null) {
      throw new CloudflareApiError("malformed", step, response.status);
    }
    return envelope;
  }
  return {
    async get<T>(step: string, path: string, query: Record<string, string> = {}) {
      return (await call(step, "GET", path, query)).result as T;
    },
    async list<T>(step: string, path: string, perPage: number, query: Record<string, string> = {}) {
      const items: T[] = [];
      for (let page = 1; page <= MAX_PAGES; page++) {
        const envelope = await call(step, "GET", path, {
          ...query,
          page: String(page),
          per_page: String(perPage),
        });
        if (!Array.isArray(envelope.result)) {
          throw new CloudflareApiError("malformed", step);
        }
        items.push(...(envelope.result as T[]));
        const info = envelope.result_info;
        const total = typeof info?.total_pages === "number" ? info.total_pages : null;
        // The page size the API applied (it may clamp the one asked for).
        const size = typeof info?.per_page === "number" && info.per_page > 0 ? info.per_page : perPage;
        if (total !== null ? page >= total : envelope.result.length < size || envelope.result.length === 0) {
          return items;
        }
      }
      throw new CloudflareApiError("incomplete", step);
    },
    async send<T>(step: string, method: "POST" | "PUT", path: string, body: unknown) {
      return (await call(step, method, path, {}, body)).result as T;
    },
  };
}

// Page sizes per listing: /accounts allows at most 50.
const PAGE_SIZE = { accounts: 50, access: 50 } as const;

// ---- step 2: the Zero Trust team

// A team name (the first label of <team>.cloudflareaccess.com) or the whole team domain.
export function teamDomainOf(input: string): string | null {
  const name = input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "")
    .replace(/\.cloudflareaccess\.com$/, "");
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name) ? `${name}.cloudflareaccess.com` : null;
}

// The team exists when its key set (what security/access-jwt.ts verifies against) lists a key.
export async function checkTeam(teamDomain: string, fetcher: typeof fetch): Promise<string | null> {
  try {
    const response = await fetcher(`https://${teamDomain}/cdn-cgi/access/certs`, {
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return `the team's key set answered HTTP ${response.status}`;
    }
    const body = (await response.json()) as { keys?: unknown };
    return Array.isArray(body.keys) && body.keys.length > 0 ? null : "the team's key set lists no keys";
  } catch {
    return "the team's key set could not be read";
  }
}

// ---- step 3: the Access applications

export type ManagedIds = {
  accountId?: string;
  adminPolicyId?: string;
  cliPolicyId?: string;
  signInAppId?: string;
  adminAppId?: string;
};

// reconcile: managed ids first, then a single object of the expected name that passes the checks.
// adopt: as reconcile, but an object of the expected name is taken over whatever it is (a recovery).
// recreate: new objects, whatever exists (a recovery; the old ones are left for the operator to delete).
export type ReconcileMode = "reconcile" | "adopt" | "recreate";

export type AccessPlan = {
  domain: string;
  teamDomain: string;
  adminEmail: string;
  // The account to use; null finds it (the token must then reach exactly one account).
  accountId: string | null;
  serviceTokenClientId: string | null;
  mode: ReconcileMode;
  // The ids the Store kept from earlier runs.
  managed: ManagedIds;
};

// The run's progress: it calls checkpoint before every external write (the Store renews the reservation, or throws to
// stop the run), and `managed` holds the ids made so far, also when it fails.
export type ReconcileHooks = { checkpoint: (managed: ManagedIds) => Promise<void>; managed: ManagedIds };

export type AccessResult = { accountId: string; signInAud: string; adminAud: string; managed: ManagedIds };

// Names that identify Kopje's objects for this domain.
export function accessNames(domain: string) {
  return {
    adminPolicy: `Kopje ${domain} admin`,
    cliPolicy: `Kopje ${domain} admin CLI`,
    signInApp: `Kopje ${domain} sign-in`,
    adminApp: `Kopje ${domain} admin`,
  };
}

const ACCOUNT_ID = /^[0-9a-f]{32}$/;
const OBJECT_ID = /^[A-Za-z0-9-]{1,64}$/;

type App = {
  id: string;
  name: string;
  aud?: unknown;
  type?: unknown;
  domain?: unknown;
  destinations?: unknown;
  policies?: unknown;
};
type Policy = { id: string; name: string; app_count?: unknown };

async function findAccount(api: CloudflareApi, given: string | null): Promise<string> {
  if (given !== null) {
    if (!ACCOUNT_ID.test(given)) {
      throw new CloudflareApiError("invalid_account", "account");
    }
    return given;
  }
  const accounts = await api.list<{ id: string }>("account", "/accounts", PAGE_SIZE.accounts);
  const [only] = accounts;
  if (only === undefined) {
    throw new CloudflareApiError("no_account", "account");
  }
  if (accounts.length !== 1 || !ACCOUNT_ID.test(only.id)) {
    throw new CloudflareApiError("account_count", "account");
  }
  return only.id;
}

// Checks that the team the operator named is this account's organization: a team of another account would be saved
// beside this account's AUD tags, and no token would verify.
async function checkOrganization(api: CloudflareApi, accountId: string, teamDomain: string): Promise<void> {
  const org = await api.get<{ auth_domain?: unknown }>("organization", `/accounts/${accountId}/access/organizations`);
  const authDomain = typeof org.auth_domain === "string" ? org.auth_domain.trim().toLowerCase() : null;
  if (authDomain !== teamDomain) {
    throw new CloudflareApiError("team_mismatch", "organization");
  }
}

// The object of a managed id, or null when it is gone.
async function byId<T>(api: CloudflareApi, step: string, path: string, id: string | undefined): Promise<T | null> {
  if (id === undefined || !OBJECT_ID.test(id)) {
    return null;
  }
  try {
    return await api.get<T>(step, `${path}/${id}`);
  } catch (error) {
    if (error instanceof CloudflareApiError && error.category === "not_found") {
      return null;
    }
    throw error;
  }
}

function single<T extends { name: string }>(items: T[], name: string, step: string): T | null {
  const found = items.filter((item) => item.name === name);
  if (found.length > 1) {
    throw new CloudflareApiError("ambiguous", step, 0, [], name);
  }
  return found[0] ?? null;
}

function appMatches(app: App, uri: string): boolean {
  const destinations = Array.isArray(app.destinations) ? (app.destinations as { type?: unknown; uri?: unknown }[]) : [];
  return (
    app.type === "self_hosted" &&
    app.domain === uri &&
    destinations.length === 1 &&
    destinations[0]?.type === "public" &&
    destinations[0]?.uri === uri
  );
}

function policyIdsOf(app: App | null): string[] {
  if (app === null || !Array.isArray(app.policies)) {
    return [];
  }
  return (app.policies as unknown[]).flatMap((p) =>
    typeof p === "string"
      ? [p]
      : typeof p === "object" && p !== null && typeof (p as { id?: unknown }).id === "string"
        ? [(p as { id: string }).id]
        : [],
  );
}

// Creates or updates the reusable policies and the two self-hosted applications:
//   sign-in: <domain>/oauth/authorize, admitting the admin's email;
//   admin:   <domain>/admin, admitting the admin's email and, when given, the admin CLI's service token.
// Everything is read and checked before the first write. Returns the AUD tags and the managed ids.
export async function reconcileAccess(
  api: CloudflareApi,
  plan: AccessPlan,
  hooks: ReconcileHooks,
): Promise<AccessResult> {
  const accountId = await findAccount(api, plan.accountId);
  await checkOrganization(api, accountId, plan.teamDomain);
  const base = `/accounts/${accountId}/access`;
  const names = accessNames(plan.domain);
  const known: ManagedIds = plan.mode !== "recreate" && plan.managed.accountId === accountId ? plan.managed : {};
  const managed = hooks.managed;
  managed.accountId = accountId;

  let tokenId: string | null = null;
  if (plan.serviceTokenClientId !== null) {
    const tokens = await api.list<{ id: string; client_id?: unknown }>(
      "service token",
      `${base}/service_tokens`,
      PAGE_SIZE.access,
    );
    tokenId = tokens.find((t) => t.client_id === plan.serviceTokenClientId)?.id ?? null;
    if (tokenId === null) {
      throw new CloudflareApiError("no_service_token", "service token");
    }
  }

  // The applications: managed ids, else one of the expected name (checked unless adopting), else none.
  const resolveApp = async (id: string | undefined, name: string, uri: string): Promise<App | null> => {
    if (plan.mode === "recreate") {
      return null;
    }
    const managedApp = await byId<App>(api, "application", `${base}/apps`, id);
    if (managedApp !== null) {
      return managedApp;
    }
    const named = single(
      await api.list<App>("application", `${base}/apps`, PAGE_SIZE.access, { name, exact: "true" }),
      name,
      "application",
    );
    if (named !== null && plan.mode === "reconcile" && !appMatches(named, uri)) {
      throw new CloudflareApiError("foreign", "application", 0, [], name);
    }
    return named;
  };
  const signInUri = `${plan.domain}/oauth/authorize`;
  const adminUri = `${plan.domain}/admin`;
  const signInApp = await resolveApp(known.signInAppId, names.signInApp, signInUri);
  const adminApp = await resolveApp(known.adminAppId, names.adminApp, adminUri);

  // The policies: likewise; one attached to applications other than these two is refused unless adopting.
  let allPolicies: Policy[] | null = null;
  const resolvePolicy = async (id: string | undefined, name: string): Promise<Policy | null> => {
    if (plan.mode === "recreate") {
      return null;
    }
    let policy = await byId<Policy>(api, "policy", `${base}/policies`, id);
    if (policy === null) {
      allPolicies ??= await api.list<Policy>("policy", `${base}/policies`, PAGE_SIZE.access);
      policy = single(allPolicies, name, "policy");
    }
    if (policy !== null && plan.mode === "reconcile") {
      const ours = [signInApp, adminApp].filter((app) => policyIdsOf(app).includes(policy.id)).length;
      if (typeof policy.app_count !== "number" || policy.app_count > ours) {
        throw new CloudflareApiError("shared_policy", "policy", 0, [], name);
      }
    }
    return policy;
  };
  const adminPolicy = await resolvePolicy(known.adminPolicyId, names.adminPolicy);
  const cliPolicy = tokenId === null ? null : await resolvePolicy(known.cliPolicyId, names.cliPolicy);

  // The writes, each after a checkpoint.
  const write = async <T extends { id: string }>(
    step: string,
    collection: string,
    existing: { id: string } | null,
    body: Record<string, unknown>,
  ): Promise<T> => {
    await hooks.checkpoint({ ...managed });
    const result =
      existing === null
        ? await api.send<T>(step, "POST", collection, body)
        : await api.send<T>(step, "PUT", `${collection}/${existing.id}`, body);
    if (typeof result.id !== "string" || !OBJECT_ID.test(result.id)) {
      throw new CloudflareApiError("malformed", step);
    }
    return result;
  };
  const admin = await write<Policy>("policy", `${base}/policies`, adminPolicy, {
    name: names.adminPolicy,
    decision: "allow",
    include: [{ email: { email: plan.adminEmail } }],
    exclude: [],
    require: [],
  });
  managed.adminPolicyId = admin.id;
  const adminPolicies = [{ id: admin.id, precedence: 1 }];
  if (tokenId !== null) {
    const cli = await write<Policy>("policy", `${base}/policies`, cliPolicy, {
      name: names.cliPolicy,
      decision: "non_identity",
      include: [{ service_token: { token_id: tokenId } }],
      exclude: [],
      require: [],
    });
    managed.cliPolicyId = cli.id;
    adminPolicies.push({ id: cli.id, precedence: 2 });
  }
  const appBody = (name: string, uri: string, policies: { id: string; precedence: number }[]) => ({
    name,
    type: "self_hosted",
    domain: uri,
    destinations: [{ type: "public", uri }],
    session_duration: "24h",
    app_launcher_visible: false,
    policies,
  });
  const signIn = await write<App>(
    "application",
    `${base}/apps`,
    signInApp,
    appBody(names.signInApp, signInUri, [{ id: admin.id, precedence: 1 }]),
  );
  managed.signInAppId = signIn.id;
  const adminResult = await write<App>(
    "application",
    `${base}/apps`,
    adminApp,
    appBody(names.adminApp, adminUri, adminPolicies),
  );
  managed.adminAppId = adminResult.id;
  if (typeof signIn.aud !== "string" || typeof adminResult.aud !== "string") {
    throw new CloudflareApiError("no_aud", "application");
  }
  return { accountId, signInAud: signIn.aud, adminAud: adminResult.aud, managed: { ...managed } };
}

// ---- step 6: Bot Fight Mode

type Zone = { id: string; name: string };

type BotSettings = {
  fight_mode?: unknown;
  sbfm_definitely_automated?: unknown;
  sbfm_likely_automated?: unknown;
  stale_zone_configuration?: unknown;
};

const CHALLENGING = new Set(["block", "managed_challenge", "challenge", "js_challenge"]);

// Whether the zone's bot settings challenge automated clients: Bot Fight Mode (fight_mode), Super Bot Fight Mode
// (sbfm_*), or a stale configuration still in force after a plan change. 'off' only when the answer establishes it.
export function botFightState(settings: BotSettings): "on" | "off" | "unknown" {
  const stale =
    typeof settings.stale_zone_configuration === "object" && settings.stale_zone_configuration !== null
      ? (settings.stale_zone_configuration as BotSettings)
      : null;
  const layers = stale === null ? [settings] : [settings, stale];
  const on = layers.some(
    (layer) =>
      layer.fight_mode === true ||
      CHALLENGING.has(String(layer.sbfm_definitely_automated)) ||
      CHALLENGING.has(String(layer.sbfm_likely_automated)),
  );
  if (on) {
    return "on";
  }
  const off = (layer: BotSettings) =>
    layer.fight_mode === false ||
    (layer.fight_mode === undefined &&
      layer.sbfm_definitely_automated === "allow" &&
      (layer.sbfm_likely_automated === undefined || layer.sbfm_likely_automated === "allow"));
  return off(settings) && (stale === null || stale.fight_mode === undefined || stale.fight_mode === false)
    ? "off"
    : "unknown";
}

// on/off when the token can read the zone and its bot settings; unknown otherwise (the static warning stands).
export async function botFightMode(
  api: CloudflareApi,
  domain: string,
): Promise<{ state: "on" | "off" | "unknown"; reason: string | null }> {
  try {
    const labels = domain.split(".");
    let zone: Zone | undefined;
    for (let i = 0; i < labels.length - 1 && zone === undefined; i++) {
      const name = labels.slice(i).join(".");
      zone = (await api.get<Zone[]>("zone", "/zones", { name })).find((z) => z.name === name);
    }
    if (zone === undefined || !OBJECT_ID.test(zone.id)) {
      return { state: "unknown", reason: "the token sees no zone for this domain" };
    }
    const settings = await api.get<BotSettings>("bot management", `/zones/${zone.id}/bot_management`);
    const state = botFightState(settings);
    return { state, reason: state === "unknown" ? "the answer does not show that it is off" : null };
  } catch (error) {
    if (error instanceof CloudflareApiError) {
      return { state: "unknown", reason: error.message };
    }
    throw error;
  }
}
