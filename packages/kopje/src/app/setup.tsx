import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

import {
  ACCESS_DISPATCH_MARGIN_MS,
  ACCESS_REQUEST_TIMEOUT_MS,
  type ImagesCheck,
  type ImagesOutcome,
  SETUP_SESSION_MS,
  type SetupAuthority,
  type SetupView,
} from "../domain/setup";
import { type ApiDeps, storeCall } from "../mastodon/context";
import { type Params, readParams } from "../mastodon/params";
import {
  botFightMode,
  checkTeam,
  CloudflareApiError,
  type DispatchFence,
  DispatchFenced,
  cloudflareApi,
  reconcileAccess,
  type ReconcileHooks,
  type ReconcileMode,
  teamDomainOf,
} from "../platform/cloudflare-api";
import { readConfig, userKek } from "../platform/config";
import { normalizeDomain } from "../platform/domain-name";
import { errorFields } from "../platform/error-message";
import { sniffImageType } from "../platform/image-bytes";
import { ImageCodecError } from "../platform/images";
import { LOCAL_USERNAME } from "../platform/stored-bounds";
import { generateWrappedKey, type KeyGen } from "../security/key-wrap";
import { constantTimeEqual, sha256Hex } from "../security/tokens";
import { csrfMatches, csrfToken, sameOrigin, SESSION_COOKIE, SETUP_COOKIE, SETUP_CSRF_CONTEXT } from "../web/session";
import {
  ChecklistPage,
  type CheckResult,
  SetupDonePage,
  SetupLoginPage,
  SetupPage,
  type SetupStep,
} from "../web/setup-pages";
import { PRIVATE_HEADERS } from "./web-headers";

// The /setup wizard. Who may use it, and what for (domain/setup.ts authorizes each operation again):
//   - before bootstrap: a browser that entered SETUP_TOKEN (compared as fixed-size digests, AUTH-5) holds a setup
//     session (an opaque __Host- cookie, SameSite=Strict, an hour at most); the token itself is kept nowhere;
//   - after bootstrap (SETUP-2): only the admin's web session, for the status, the checks and reconciling Access;
//     SETUP_TOKEN opens nothing and cannot change the domain, the admin or the Access configuration.
// Every POST checks Origin before reading the body (missing, `null` and foreign answer 403), then the form's
// anti-forgery token, derived from the session that authorizes it (WEB-1, WEB-4). Pages carry the web UI's CSP without
// script, deny framing and are never cached (WEB-2); no CORS headers (WEB-3); HTML with nosniff (WEB-5).
// SETUP-4: a Cloudflare API token is read from the one request that carries it, used there, and dropped: it is not
// stored, logged, rendered or put in a redirect.

export type SetupDeps = ApiDeps & { fetch: typeof fetch; keygen: KeyGen };

type SetupEnv = { Bindings: Env };
type SetupContext = Context<SetupEnv>;

const MIN_SETUP_TOKEN_LENGTH = 32;
const FORM_LIMIT = 16 * 1024;
// A probe the consumer has not marked within this long is a failure.
const PROBE_PATIENCE_MS = 2 * 60 * 1000;
// The cron runs every 5 minutes (wrangler.jsonc); three missed runs is a failure.
const CRON_PATIENCE_MS = 15 * 60 * 1000;

// A 1x1 PNG, transformed by the Images check.
const TINY_PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="),
  (char) => char.charCodeAt(0),
);

const EMAIL = /^[^\s@<>"]{1,64}@[A-Za-z0-9.-]{1,189}\.[A-Za-z]{2,63}$/;
const CLIENT_ID = /^[A-Za-z0-9._-]{1,100}$/;
const API_TOKEN = /^[\x21-\x7e]{1,200}$/;
const MODES: readonly ReconcileMode[] = ["reconcile", "adopt", "recreate"];

// Thrown from a checkpoint when the Store no longer holds this run's reservation: the run stops before its next write.
class ReconcileStopped extends Error {}

type Status = 200 | 400 | 403 | 409 | 422 | 429 | 503;

// Step 1: why the host the request came to cannot be the instance domain, or null. A workers.dev host is refused:
// Access protects paths only on a zone of the account, and the domain can never change afterwards.
export function hostProblem(host: string): string | null {
  const domain = normalizeDomain(host);
  if (domain === null || domain !== host) {
    return `${host} is not a domain name Kopje can use (no IP address, port or unusual spelling).`;
  }
  if (domain === "workers.dev" || domain.endsWith(".workers.dev")) {
    return "A workers.dev address cannot be the instance domain: open this page on the custom domain of your zone.";
  }
  return null;
}

type Session =
  | { mode: "setup"; authority: SetupAuthority; secret: string; view: SetupView }
  | { mode: "admin"; authority: SetupAuthority; secret: string; view: SetupView };

function page(c: SetupContext, status: Status, body: Parameters<SetupContext["html"]>[0]) {
  return c.html(body, status, PRIVATE_HEADERS);
}

function redirect(path: string): Response {
  return new Response(null, { status: 303, headers: { location: path, "cache-control": "no-store" } });
}

const SETUP_COOKIE_OPTIONS = {
  prefix: "host",
  path: "/",
  secure: true,
  httpOnly: true,
  sameSite: "Strict",
  maxAge: SETUP_SESSION_MS / 1000,
} as const;

const CLEARED = { prefix: "host", path: "/", secure: true } as const;

function hostOf(c: SetupContext): string {
  return new URL(c.req.url).host;
}

function queueResult(view: SetupView, now: number): CheckResult {
  const probe = view.probe;
  if (probe === null) {
    return { status: "warn", text: "No probe message has been sent yet." };
  }
  if (probe.consumedAt !== null) {
    return { status: "pass", text: `The consumer received the probe at ${new Date(probe.consumedAt).toISOString()}.` };
  }
  return now - probe.sentAt > PROBE_PATIENCE_MS
    ? {
        status: "fail",
        text: `The probe sent at ${new Date(probe.sentAt).toISOString()} has not been received.`,
        hint: "Check that the Queue named by the QUEUE binding in wrangler.jsonc exists and that this Worker is its consumer (Queues in the dashboard), and that maintenance is off.",
      }
    : { status: "warn", text: "The probe is on its way. Reload in a few seconds." };
}

// Images error 9432: the account still has the legacy Image Resizing billing, under which the binding is unavailable.
const LEGACY_BILLING_ERROR = 9432;

function imagesResult(images: ImagesCheck | null): CheckResult | undefined {
  if (images === null) {
    return undefined;
  }
  const at = ` (checked at ${new Date(images.at).toISOString()})`;
  switch (images.outcome) {
    case "pass":
      return { status: "pass", text: `The Images binding transformed the test image${at}.` };
    case "quota":
      return {
        status: "warn",
        text: `The account's Images transformation allowance is used up for this month${at}.`,
        hint: "Uploads fail until the month turns, unless you enable paid transformations.",
      };
    case "budget":
      return {
        status: "warn",
        text: `This month's transformation budget (IMAGES_MONTHLY_TRANSFORMS) is used up, so nothing was tried${at}.`,
      };
    case "invalid":
      return {
        status: "fail",
        text: `The Images binding answered with something that is not the requested image${at}.`,
      };
    case "failed":
      return {
        status: "fail",
        text: `The Images binding could not transform the test image${images.code === null ? "" : ` (error ${images.code})`}${at}.`,
        hint:
          images.code === LEGACY_BILLING_ERROR
            ? "The account is on the legacy Image Resizing billing, which has no Images binding. Move it to an Images plan (Images in the dashboard), then check again."
            : "Check that Images is available on the account (Images, Transformations) and that the Worker has the IMAGES binding.",
      };
  }
}

// The Access reconciliation's state, when it needs attention.
function accessResult(view: SetupView): CheckResult | undefined {
  switch (view.access?.state) {
    case "running":
      return { status: "warn", text: "A run of this step is in progress. Reload in a minute." };
    case "unresolved":
      return {
        status: "fail",
        text: "The last run of this step did not finish, so the Access applications may be half updated.",
        hint: "Run the step again with a fresh token. Setup cannot finish until a run completes.",
      };
    default:
      if (view.access?.lateFailureAt != null && view.access.state === "completed") {
        const at = new Date(view.access.lateFailureAt).toISOString();
        return {
          status: "warn",
          text: `A run that a newer one had replaced reported a failure at ${at}. It sent nothing after it was replaced; the newer run's outcome stands.`,
        };
      }
      if (view.draft !== null && view.draft.access !== null && !view.draft.accessReady) {
        return {
          status: "warn",
          text: "Another run of this step replaced the one this browser made.",
          hint: "Run the step again here before creating the admin.",
        };
      }
      return undefined;
  }
}

function cronResult(view: SetupView, now: number): CheckResult {
  const last = view.cronLastRun;
  if (last === null) {
    return {
      status: "warn",
      text: "No cron run has been recorded yet. It runs every 5 minutes.",
      hint: "If none shows up, check the Worker's cron trigger (Settings, Triggers).",
    };
  }
  return now - last > CRON_PATIENCE_MS
    ? {
        status: "fail",
        text: `The cron last ran at ${new Date(last).toISOString()}.`,
        hint: "Check the Worker's cron trigger and that maintenance is off.",
      }
    : { status: "pass", text: `The cron last ran at ${new Date(last).toISOString()}.` };
}

export function setupRoutes(deps: SetupDeps): Hono<SetupEnv> {
  const app = new Hono<SetupEnv>();

  const view = (c: SetupContext, authority: SetupAuthority | null) =>
    storeCall(c, deps, (s, b) => s.setupView(b, { authority, now: deps.now() })) as Promise<SetupView>;

  // The setup session, or after bootstrap the admin's web session; null when neither authorizes anything now.
  async function sessionOf(c: SetupContext): Promise<{ session: Session | null; bootstrapped: boolean }> {
    const setupSecret = getCookie(c, SETUP_COOKIE, "host");
    let bootstrapped = false;
    if (setupSecret !== undefined) {
      const authority: SetupAuthority = { kind: "setup", sessionHash: await sha256Hex(setupSecret) };
      const seen = await view(c, authority);
      if (seen.authorized) {
        return { session: { mode: "setup", authority, secret: setupSecret, view: seen }, bootstrapped: false };
      }
      bootstrapped = seen.bootstrapped;
    }
    const webSession = getCookie(c, SESSION_COOKIE, "host");
    if (webSession !== undefined) {
      const authority: SetupAuthority = {
        kind: "admin",
        credential: { tokenHash: await sha256Hex(webSession), scope: "write:accounts", now: deps.now() },
      };
      const seen = await view(c, authority);
      if (seen.authorized) {
        return { session: { mode: "admin", authority, secret: webSession, view: seen }, bootstrapped: true };
      }
      bootstrapped = seen.bootstrapped;
    }
    if (setupSecret === undefined && webSession === undefined) {
      bootstrapped = (await view(c, null)).bootstrapped;
    }
    return { session: null, bootstrapped };
  }

  const csrfOf = (session: Session) =>
    session.mode === "setup" ? csrfToken(session.secret, SETUP_CSRF_CONTEXT) : csrfToken(session.secret);

  async function render(
    c: SetupContext,
    session: Session,
    results: Partial<Record<SetupStep, CheckResult>> = {},
    status: Status = 200,
  ) {
    const now = deps.now();
    const host = hostOf(c);
    return page(
      c,
      status,
      <SetupPage
        mode={session.mode}
        host={host}
        hostProblem={session.mode === "setup" ? hostProblem(host) : null}
        csrf={await csrfOf(session)}
        view={session.view}
        results={results}
        queue={queueResult(session.view, now)}
        images={imagesResult(session.view.images)}
        accessState={accessResult(session.view)}
        cron={cronResult(session.view, now)}
      />,
    );
  }

  // Re-reads the view after a change, so the page shows it.
  async function refreshed(c: SetupContext, session: Session): Promise<Session> {
    return { ...session, view: await view(c, session.authority) };
  }

  const forbidden = (c: SetupContext) =>
    page(
      c,
      403,
      <SetupLoginPage problem="This form was not sent from this setup page, or the setup session ended. Reload the page." />,
    );

  // The session that sent a form no longer authorizes it: setup was completed, or the session ended.
  const ended = async (c: SetupContext) =>
    (await view(c, null)).bootstrapped
      ? page(c, 403, <SetupDonePage />)
      : page(c, 403, <SetupLoginPage problem="The setup session ended. Enter the setup token again." />);

  // WEB-1, WEB-4: Origin first (no body is read for a cross-site post), then the session and its form token.
  async function checkForm(c: SetupContext): Promise<{ session: Session; params: Params } | Response> {
    if (!sameOrigin(c.req.raw)) {
      await c.req.raw.body?.cancel();
      return forbidden(c);
    }
    const read = await readParams(c.req.raw, { limit: FORM_LIMIT });
    if (!read.ok) {
      return page(c, 400, <SetupLoginPage problem="The form could not be read." />);
    }
    const { session } = await sessionOf(c);
    if (session === null) {
      return ended(c);
    }
    const context = session.mode === "setup" ? SETUP_CSRF_CONTEXT : undefined;
    if (!(await csrfMatches(session.secret, read.params.get("csrf"), context))) {
      return forbidden(c);
    }
    return { session, params: read.params };
  }

  app.get("/setup/checklist", (c) => page(c, 200, <ChecklistPage />));

  app.get("/setup", async (c) => {
    const { session, bootstrapped } = await sessionOf(c);
    if (session !== null) {
      return render(c, session);
    }
    return bootstrapped ? page(c, 200, <SetupDonePage />) : page(c, 200, <SetupLoginPage problem={null} />);
  });

  app.post("/setup/login", async (c) => {
    if (!sameOrigin(c.req.raw)) {
      await c.req.raw.body?.cancel();
      return forbidden(c);
    }
    const ip = c.req.header("cf-connecting-ip") ?? "unknown";
    if (!(await c.env.LOGIN_LIMIT.limit({ key: `setup:${ip}` })).success) {
      await c.req.raw.body?.cancel();
      return page(c, 429, <SetupLoginPage problem="Too many attempts from this address. Try again in a minute." />);
    }
    const read = await readParams(c.req.raw, { limit: FORM_LIMIT });
    const presented = read.ok ? read.params.get("token") : undefined;
    const secret = (c.env as { SETUP_TOKEN?: unknown }).SETUP_TOKEN;
    if (typeof secret !== "string" || secret.length < MIN_SETUP_TOKEN_LENGTH) {
      return page(
        c,
        503,
        <SetupLoginPage
          problem={`The SETUP_TOKEN secret is not set on this Worker (it must be at least ${MIN_SETUP_TOKEN_LENGTH} characters).`}
        />,
      );
    }
    // AUTH-5: fixed-size digests, compared in constant time.
    if (presented === undefined || !constantTimeEqual(presented, secret)) {
      return page(c, 403, <SetupLoginPage problem="The setup token is not correct." />);
    }
    const id = deps.randomToken();
    const begun = await storeCall(c, deps, async (s, b) =>
      s.beginSetupSession(b, { sessionHash: await sha256Hex(id), now: deps.now() }),
    );
    if (begun === "complete") {
      // SETUP-2: a setup token used again after bootstrap opens nothing.
      return page(c, 403, <SetupDonePage />);
    }
    setCookie(c, SETUP_COOKIE, id, SETUP_COOKIE_OPTIONS);
    return c.body(null, 303, { location: "/setup", "cache-control": "no-store" });
  });

  app.post("/setup/logout", async (c) => {
    const checked = await checkForm(c);
    if (checked instanceof Response) {
      return checked;
    }
    if (checked.session.authority.kind === "setup") {
      const sessionHash = checked.session.authority.sessionHash;
      await storeCall(c, deps, (s, b) => s.endSetupSession(b, { sessionHash }));
    }
    deleteCookie(c, SETUP_COOKIE, CLEARED);
    return c.body(null, 303, { location: "/setup", "cache-control": "no-store" });
  });

  // Step 1. Only the host of this request, and only before bootstrap.
  app.post("/setup/domain", async (c) => {
    const checked = await checkForm(c);
    if (checked instanceof Response) {
      return checked;
    }
    const { session, params } = checked;
    if (session.authority.kind !== "setup") {
      return forbidden(c);
    }
    const host = hostOf(c);
    const problem = hostProblem(host);
    if (problem !== null || params.get("domain") !== host) {
      return render(
        c,
        session,
        { domain: { status: "fail", text: problem ?? "Confirm the domain this page is on." } },
        422,
      );
    }
    const sessionHash = session.authority.sessionHash;
    const saved = await storeCall(c, deps, (s, b) =>
      s.confirmSetupDomain(b, { sessionHash, domain: host, now: deps.now() }),
    );
    return saved === "ok" ? redirect("/setup") : ended(c);
  });

  // Steps 2 and 3: the team, then the Access applications, with the API token of this request only (SETUP-4).
  app.post("/setup/access", async (c) => {
    const checked = await checkForm(c);
    if (checked instanceof Response) {
      return checked;
    }
    const { session, params } = checked;
    const fail = (text: string, hint?: string) =>
      render(c, session, { access: { status: "fail", text, ...(hint === undefined ? {} : { hint }) } }, 422);
    const domain = session.mode === "admin" ? session.view.config?.domain : session.view.draft?.domain;
    if (domain === undefined || domain === null || domain !== hostOf(c)) {
      return fail("Confirm the domain first.");
    }
    const teamDomain = teamDomainOf(params.get("team") ?? "");
    const adminEmail =
      session.mode === "admin" ? (session.view.config?.adminEmail ?? "") : (params.get("admin_email") ?? "").trim();
    const accountId = (params.get("account_id") ?? "").trim().toLowerCase();
    const clientId = (params.get("service_token_client_id") ?? "").trim();
    const apiToken = params.get("api_token") ?? "";
    if (teamDomain === null) {
      return fail("Enter the team name of your Zero Trust organization.");
    }
    if (!EMAIL.test(adminEmail)) {
      return fail("Enter the admin's email address.");
    }
    if (clientId !== "" && !CLIENT_ID.test(clientId)) {
      return fail("The service token client ID is not valid.");
    }
    if (!API_TOKEN.test(apiToken)) {
      return fail("Enter a Cloudflare API token.");
    }
    const teamProblem = await checkTeam(teamDomain, deps.fetch);
    if (teamProblem !== null) {
      return fail(
        `${teamDomain} does not look like a Zero Trust team: ${teamProblem}.`,
        "Create the Zero Trust organization first (see the checklist), and enter its team name.",
      );
    }
    const mode = MODES.find((m) => m === params.get("mode")) ?? "reconcile";
    const authority = session.authority;
    const serviceTokenClientId = clientId === "" ? null : clientId;
    // The reconciliation is reserved in the Store before any call that could write (items of SETUP-2 and SETUP-3).
    const reserved = await storeCall(c, deps, (s, b) =>
      s.reserveAccess(b, { authority, domain, adminEmail, now: deps.now() }),
    );
    switch (reserved.status) {
      case "denied":
        return ended(c);
      case "busy":
        return fail(
          "Another run of this step is in progress.",
          "Wait for it to finish (at most two minutes), then reload the page.",
        );
      case "no_domain":
        return fail("Confirm the domain first.");
      case "admin_mismatch":
        return fail("The admin changed meanwhile. Reload the page.");
    }
    const revision = reserved.revision;
    // The lease deadline the Store issued, renewed at each checkpoint. Every request is fenced by it.
    let deadline = reserved.deadline;
    const fence: DispatchFence = () => {
      const left = deadline - deps.now();
      if (left < ACCESS_DISPATCH_MARGIN_MS) {
        throw new DispatchFenced();
      }
      return AbortSignal.any([AbortSignal.timeout(ACCESS_REQUEST_TIMEOUT_MS), AbortSignal.timeout(left)]);
    };
    const hooks: ReconcileHooks = {
      managed: {},
      checkpoint: async (managed) => {
        const held = await storeCall(c, deps, (s, b) =>
          s.checkpointAccess(b, { authority, revision, managed, now: deps.now() }),
        );
        if (held.status !== "ok") {
          throw new ReconcileStopped();
        }
        deadline = held.deadline;
      },
    };
    let result;
    try {
      result = await reconcileAccess(
        cloudflareApi(apiToken, deps.fetch, fence),
        {
          domain,
          teamDomain,
          adminEmail,
          accountId: accountId === "" ? null : accountId,
          serviceTokenClientId,
          mode,
          managed: reserved.managed,
        },
        hooks,
      );
    } catch (error) {
      const managed = { ...hooks.managed };
      await storeCall(c, deps, (s, b) => s.failAccess(b, { authority, revision, managed, now: deps.now() }));
      if (error instanceof ReconcileStopped || error instanceof DispatchFenced) {
        return fail(
          "This run was stopped: another run replaced it, setup finished, or your sign-in ended. Nothing more was changed.",
        );
      }
      if (error instanceof CloudflareApiError) {
        return fail(
          `The Access step failed: ${error.message}.`,
          error.category === "unauthorized"
            ? "Check the token’s permissions (listed below) and that it has not expired."
            : "Run the step again once this is fixed.",
        );
      }
      // SETUP-4: only allowlisted fields of the error (DATA-5), never its name or message.
      console.error({ event: "kopje.setup.access_failed", ...errorFields(error) });
      return fail("The Access applications could not be set up. Run the step again.");
    }
    const access = {
      teamDomain,
      accountId: result.accountId,
      signInAud: result.signInAud,
      adminAud: result.adminAud,
      adminEmail,
      serviceTokenClientId,
    };
    const managed = result.managed;
    const completed = await storeCall(c, deps, (s, b) =>
      s.completeAccess(b, { authority, revision, access, managed, now: deps.now() }),
    );
    if (completed !== "ok") {
      return fail(
        "This run was stopped: another run replaced it, setup finished, or your sign-in ended. Run the step again.",
      );
    }
    return render(c, await refreshed(c, session), {
      access: { status: "pass", text: `The Access applications for ${domain} are in place on ${teamDomain}.` },
    });
  });

  // Step 4: the fixed probe through the binding. Its charge to the instance's monthly budget is taken once per UTC
  // month (a recheck runs uncharged); the outcome is kept, and the answer redirects so a reload does not run it again.
  app.post("/setup/check/images", async (c) => {
    const checked = await checkForm(c);
    if (checked instanceof Response) {
      return checked;
    }
    const { session } = checked;
    const config = readConfig(c.env);
    const limit = config.ok ? config.config.IMAGES_MONTHLY_TRANSFORMS : 0;
    const authority = session.authority;
    const charged = await storeCall(c, deps, (s, b) =>
      s.chargeSetupTransform(b, { authority, limit, now: deps.now() }),
    );
    if (charged === "denied") {
      return ended(c);
    }
    let outcome: ImagesOutcome = "budget";
    let code: number | null = null;
    if (charged === "ok") {
      try {
        const output = await deps.images(c.env).encode(TINY_PNG, { format: "image/webp" });
        outcome = sniffImageType(output) === "image/webp" ? "pass" : "invalid";
      } catch (error) {
        code =
          error instanceof ImageCodecError && error.code !== null && Number.isInteger(error.code) ? error.code : null;
        outcome = code === 9422 ? "quota" : "failed";
      }
    }
    const recorded = await storeCall(c, deps, (s, b) =>
      s.recordSetupImages(b, { authority, outcome, code, now: deps.now() }),
    );
    return recorded ? redirect("/setup") : ended(c);
  });

  // Step 5: a probe through the Queue; the page shows when the consumer marks it.
  app.post("/setup/check/queue", async (c) => {
    const checked = await checkForm(c);
    if (checked instanceof Response) {
      return checked;
    }
    const { session } = checked;
    const id = deps.randomToken();
    const authority = session.authority;
    const sent = await storeCall(c, deps, (s, b) => s.sendSetupProbe(b, { authority, id, now: deps.now() }));
    if (!sent) {
      return ended(c);
    }
    try {
      await c.env.QUEUE.send({ kind: "setup-probe", id });
    } catch {
      return render(c, await refreshed(c, session), {
        queue: {
          status: "fail",
          text: "The probe could not be sent to the Queue.",
          hint: "Check that the Worker has the QUEUE binding and that the Queue it names in wrangler.jsonc exists.",
        },
      });
    }
    return redirect("/setup");
  });

  // Step 6: the warning, and the setting itself when the token given can read it (SETUP-4).
  app.post("/setup/check/bot-fight", async (c) => {
    const checked = await checkForm(c);
    if (checked instanceof Response) {
      return checked;
    }
    const { session, params } = checked;
    const apiToken = params.get("api_token") ?? "";
    const domain = (session.mode === "admin" ? session.view.config?.domain : null) ?? hostOf(c);
    let result: CheckResult;
    if (apiToken === "" || !API_TOKEN.test(apiToken)) {
      result = {
        status: "warn",
        text: "Not checked. Make sure Bot Fight Mode is off for this zone.",
      };
    } else {
      const mode = await botFightMode(cloudflareApi(apiToken, deps.fetch), domain);
      result =
        mode.state === "on"
          ? {
              status: "fail",
              text: "Bot Fight Mode is on for this zone.",
              hint: "Turn it off under Security, Bots: it challenges other servers and breaks federation.",
            }
          : mode.state === "off"
            ? { status: "pass", text: "Bot Fight Mode is off." }
            : {
                status: "warn",
                text: `Could not read the setting (${mode.reason ?? "unknown"}). Make sure Bot Fight Mode is off.`,
              };
    }
    return render(c, session, { bot: result });
  });

  // Step 7: the admin, and the bootstrap (SETUP-3).
  app.post("/setup/admin", async (c) => {
    const checked = await checkForm(c);
    if (checked instanceof Response) {
      return checked;
    }
    const { session, params } = checked;
    if (session.authority.kind !== "setup") {
      return forbidden(c);
    }
    const fail = (text: string) => render(c, session, { admin: { status: "fail", text } }, 422);
    const username = (params.get("username") ?? "").trim();
    const email = (params.get("email") ?? "").trim();
    if (!LOCAL_USERNAME.test(username)) {
      return fail("A username is 1 to 30 letters, digits or underscores.");
    }
    if (!EMAIL.test(email)) {
      return fail("Enter an email address.");
    }
    const config = readConfig(c.env);
    if (!config.ok) {
      return fail("The Worker is misconfigured.");
    }
    const key = await generateWrappedKey(userKek(config.config), deps.keygen);
    const sessionHash = session.authority.sessionHash;
    const result = await storeCall(c, deps, (s, b) =>
      s.bootstrapInstance(b, { sessionHash, domain: hostOf(c), username, email, key, now: deps.now() }),
    );
    switch (result) {
      case "ok":
        deleteCookie(c, SETUP_COOKIE, CLEARED);
        return c.body(null, 303, { location: "/setup", "cache-control": "no-store" });
      case "complete":
        deleteCookie(c, SETUP_COOKIE, CLEARED);
        return page(c, 409, <SetupDonePage />);
      case "denied":
        return ended(c);
      case "incomplete":
        return fail("Confirm the domain and set up the Access applications first.");
      case "stale":
        return fail("The Access step must complete again first: another run replaced this one, or one did not finish.");
      case "email_mismatch":
        return fail("Access admits another email. Use that one, or run the Access step again with this one.");
    }
  });

  return app;
}
