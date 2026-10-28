import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";

import { ringDoorbell } from "../federation/delivery";
import { inboxHandler, precheckInbox, requestInboundJobs } from "../federation/inbox";
import { activityStreamsRequest, INBOX_ROUTES } from "../federation/inbox-request";
import { signAsAuthor } from "../federation/ld-sign";
import { createResolver } from "../federation/resolve";
import { FEDERATION_GET_ROUTES, federationHandler, type FederationRouteDeps } from "../federation/routes";
import { FEDERATION_PATHS, requireSetup } from "../federation/setup-gate";
import { rescueFromSnapshot } from "../federation/snapshot";
import { createAdmission, INBOX_BODY_LIMIT, spoolInbox } from "../federation/spool";
import { ActivityMemo } from "../mastodon/activity";
import type { AuthorSignature } from "../mastodon/context";
import { maintenanceError, mastodonError } from "../mastodon/errors";
import { mastodonApi } from "../mastodon/routes";
import { streamingRoutes } from "../mastodon/streaming";
import { readBackupConfig } from "../platform/backup-config";
import { readBoundedBody } from "../platform/body";
import { readConfig, userKek } from "../platform/config";
import { errorFields } from "../platform/error-message";
import { type ImageCodec, imagesCodec } from "../platform/images";
import { loggedMethod } from "../platform/log";
import { defaultStore, type StoreResolver } from "../platform/store-client";
import { StoreUnavailableError } from "../platform/store-errors";
import { generateRsaKeyPair } from "../security/key-wrap";
import { randomToken, type TokenGenerator } from "../security/tokens";
import { MEDIA_ROUTE, REMOTE_MEDIA_ROUTE, serveMedia, serveRemoteMedia } from "../web/media";
import { ADMIN_PREFIX, adminRoutes, isAdminPath } from "./admin";
import { authorizeRoutes } from "./authorize";
import { errorPage, type ErrorStatus } from "./error-pages";
import { classifyRequest, decide, type RequestClass } from "./gate";
import { publicHealth } from "./health";
import { interactionRoutes } from "./interaction";
import { documentPath, isRead, JSON_TYPE, type MediaType, pageRoutes, PLAIN_TEXT, prefersPage } from "./negotiation";
import { publicPageRoutes } from "./public-pages";
import { setupRoutes } from "./setup";
import { webRoutes } from "./web";

export type AppDeps = {
  // The build identity sent on every Store RPC (the Workers version id in production; tests inject one).
  build: (env: Env) => string;
  now: () => number;
  store?: StoreResolver;
  // Remote fetches and key generation of the federation layer (tests inject both).
  federation?: Partial<Pick<FederationRouteDeps, "keygen" | "loader">>;
  // Seams for tests: the Access JWKS fetch, the generator of OAuth values and media tokens, and image re-encoding.
  fetch?: typeof fetch;
  randomToken?: TokenGenerator;
  images?: (env: Env) => ImageCodec;
  // Rings the delivery doorbell after an API write (default: a message on env.QUEUE).
  doorbell?: (env: Env) => Promise<void>;
  // Asks for a round of the Store's jobs (default: a message on env.QUEUE): after an admin suspension or unsuspension,
  // an unlock that leaves follow requests to accept, and a resolved status's quote to verify.
  jobs?: (env: Env) => Promise<unknown>;
  // The memo of recorded activity (mastodon/activity.ts): one per app, so one per isolate in worker.ts.
  activity?: ActivityMemo;
};

// The admin API writes that leave moderation jobs (domain/suspension.ts): the action and the unsuspension of an
// account.
const MODERATION_WRITE = /^\/api\/v1\/admin\/accounts\/[^/]+\/(?:action|unsuspend)$/;

const API_CORS_PATHS = ["/api/*", "/oauth/token", "/oauth/revoke", "/oauth/userinfo"];

// WEB-3: cross-origin GET for /.well-known, NodeInfo and local actor documents; the profile page (HTML) stays closed.
// As Mastodon v4.5.11 opens them (config/initializers/cors.rb).
const DOCUMENT_CORS_PATHS = ["/.well-known/*", "/nodeinfo/*", "/ap/users/:username"];

type AppEnv = { Bindings: Env; Variables: { requestClass: RequestClass; inboxBody: Uint8Array; domain: string } };

export function createApp({
  build,
  now,
  store = defaultStore,
  fetch = globalThis.fetch,
  federation = {},
  doorbell = (env) => ringDoorbell(env.QUEUE),
  jobs = (env) => requestInboundJobs(env.QUEUE),
  activity = new ActivityMemo(),
  ...seams
}: AppDeps) {
  const app = new Hono<AppEnv>();

  // WEB-5: every response, API, federation, media, errors and maintenance answers alike, is read only as the type it
  // declares.
  app.use(async (c, next) => {
    await next();
    try {
      c.res.headers.set("x-content-type-options", "nosniff");
    } catch {
      // A response with immutable headers (Response.redirect, a fetched response) is copied first.
      c.res = new Response(c.res.body, c.res);
      c.res.headers.set("x-content-type-options", "nosniff");
    }
  });

  // Browser clients call the API and the token endpoints cross-origin; errors and maintenance answers carry the
  // headers too. The consent page (/oauth/authorize) is not opened to other origins.
  const apiCors = cors({ origin: "*", exposeHeaders: ["Link"], maxAge: 86400 });
  for (const path of API_CORS_PATHS) {
    app.use(path, apiCors);
  }
  const documentCors = cors({ origin: "*", allowMethods: ["GET"], maxAge: 86400 });
  for (const path of DOCUMENT_CORS_PATHS) {
    app.use(path, documentCors);
  }

  // Spooling within the Queue's admission budget (federation/spool.ts): over it, or when it cannot be read, 503.
  const admission = createAdmission(now);
  const spool = async (queue: Queue, request: Request, body: Uint8Array) => {
    if (await admission.full(queue)) {
      console.warn({ event: "kopje.spool.backlog-full" });
      return maintenanceError();
    }
    return spoolInbox(request, body, queue, now());
  };

  // Maintenance gate, max(env, Store). The env mode (MAINTENANCE) is applied here. The Store applies its own readonly
  // state to each RPC by operation kind, and a refusal arrives as StoreUnavailableError in onError: inbox requests
  // are spooled, everything else gets 503.
  app.use(async (c, next) => {
    // The admin API authenticates itself and must work in every maintenance mode and with an invalid env.
    if (isAdminPath(c.req.path)) {
      return next();
    }
    const requestClass = classifyRequest(c.req.method, c.req.path);
    c.set("requestClass", requestClass);
    const config = readConfig(c.env);
    if (!config.ok) {
      if (c.req.path === "/health") {
        return next();
      }
      console.error({ event: "kopje.config.invalid", issues: config.issues });
      return mastodonError(503, "This server is misconfigured");
    }
    const decision = decide(requestClass, config.config.MAINTENANCE);
    if (decision === "unavailable") {
      return failed(c, 503, maintenanceError());
    }
    if (requestClass === "inbox") {
      // Read once, bounded, before anything else: both the handler and a later spool use these bytes.
      const body = await readBoundedBody(c.req.raw, INBOX_BODY_LIMIT);
      if (body === "too-large") {
        return new Response(null, { status: 413 });
      }
      c.set("inboxBody", body);
      if (!activityStreamsRequest(c.req.raw)) {
        return new Response(null, { status: 415 });
      }
      // Refused before anything is spooled: a personal inbox of nobody (404). Served at once, the handler's gate
      // (processInbox) answers it in its one Store read.
      if (decision === "spool") {
        if ((await precheckInbox(c.env, { build, store }, c.req.raw)) === "not-found") {
          return new Response(null, { status: 404 });
        }
        return spool(c.env.QUEUE, c.req.raw, body);
      }
    }
    await next();
    // A successful API write may have recorded deliveries (statuses, favourites, boosts, follows): ring once it has
    // committed. A lost ring only delays them until the cron.
    if (requestClass === "write" && c.req.path.startsWith("/api/") && c.res.status < 400) {
      c.executionCtx.waitUntil(
        doorbell(c.env).catch((error: unknown) => {
          console.error({ event: "kopje.delivery.doorbell.failed", ...errorFields(error) });
        }),
      );
      // A suspension's jobs start at once rather than at the next cron (requestInboundJobs logs its own failure).
      if (MODERATION_WRITE.test(c.req.path)) {
        c.executionCtx.waitUntil(jobs(c.env));
      }
    }
  });

  app.get("/health", (c) => publicHealth(build(c.env), readConfig(c.env), () => store(c.env), readBackupConfig(c.env)));

  const keygen = federation.keygen ?? generateRsaKeyPair;
  const images = seams.images ?? ((env: Env) => imagesCodec(env.IMAGES));
  const loader = federation.loader ?? { fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init) };

  app.route(
    ADMIN_PREFIX,
    adminRoutes({ build, now, store, doorbell, jobs, loader, images, fetch: (input, init) => fetch(input, init) }),
  );

  // The inbox POSTs read the domain in their own gate (federation/inbox.ts processInbox).
  const setupGate = requireSetup(build, store, (c) => c.get("requestClass") === "inbox");
  for (const path of FEDERATION_PATHS) {
    app.use(path, setupGate);
  }

  const inbox = inboxHandler({ build, store, now, keygen, loader });
  for (const path of INBOX_ROUTES) {
    app.post(path, inbox);
  }

  const federationGet = federationHandler({ build, now, store, keygen, loader });
  for (const path of FEDERATION_GET_ROUTES) {
    app.get(path, federationGet);
  }
  const apiDeps = {
    build,
    now,
    store,
    randomToken: seams.randomToken ?? randomToken,
    images,
    resolve: createResolver({ build, store, now, keygen, loader }),
    requestJobs: jobs,
    activity,
    signAsAuthor: (env: Env, sign: AuthorSignature) => {
      const config = readConfig(env);
      return signAsAuthor(config.ok ? userKek(config.config) : "", sign);
    },
  };
  app.get(REMOTE_MEDIA_ROUTE, serveRemoteMedia);
  app.get(MEDIA_ROUTE, serveMedia);
  const authorize = authorizeRoutes({ ...apiDeps, fetch: (input, init) => fetch(input, init), keygen });
  const setup = setupRoutes({ ...apiDeps, fetch: (input, init) => fetch(input, init), keygen });
  const web = webRoutes(apiDeps);
  const interaction = interactionRoutes({ ...apiDeps, doorbell });
  const publicPages = publicPageRoutes({ ...apiDeps, dispatch: (request, env, ctx) => app.fetch(request, env, ctx) });
  app.route("/", authorize);
  app.route("/", streamingRoutes(apiDeps));
  app.route("/", mastodonApi(apiDeps));
  app.route("/", setup);
  app.route("/", web);
  app.route("/", interaction);
  app.route("/", publicPages);

  // The error answers that negotiate (negotiation.ts): a GET or HEAD of a page route (its 500 and 503, the env's
  // maintenance included), and of a path outside the document namespaces that no route serves (its 404). Both of
  // their variants vary with Accept; every other answer is the API's, unchanged.
  const pageRoute = pageRoutes([authorize, setup, web, interaction, publicPages]);
  function negotiate(c: Context, status: ErrorStatus, document: Response, type: MediaType) {
    if (prefersPage(c.req.header("accept"), type)) {
      return errorPage(c, status);
    }
    document.headers.append("vary", "Accept");
    return document;
  }
  function failed(c: Context, status: 500 | 503, document: Response) {
    // A page route is a GET route, which a HEAD matches too.
    return pageRoute(c.req.matchedRoutes) ? negotiate(c, status, document, JSON_TYPE) : document;
  }

  app.notFound((c) => {
    if (c.req.path.startsWith("/api/")) {
      return mastodonError(404, "Record not found");
    }
    const plain = c.text("Not Found", 404);
    return isRead(c.req.method) && !documentPath(c.req.path) ? negotiate(c, 404, plain, PLAIN_TEXT) : plain;
  });

  app.onError(async (error, c) => {
    if (error instanceof StoreUnavailableError) {
      // By its reason only. Maintenance that the env sets is the operator's own choice and is not logged.
      const { reason } = errorFields(error);
      const config = readConfig(c.env);
      if (!(reason === "maintenance" && config.ok && config.config.MAINTENANCE !== "off")) {
        console.warn({ event: "kopje.store.unavailable", reason: reason ?? null, class: c.get("requestClass") });
      }
      const body = c.get("requestClass") === "inbox" ? c.get("inboxBody") : undefined;
      if (body !== undefined) {
        return spool(c.env.QUEUE, c.req.raw, body);
      }
      // Actor documents, WebFinger and NodeInfo stay up from the last good snapshot.
      if (c.get("requestClass") === "always") {
        const rescued = await rescueFromSnapshot(c.req.raw, store(c.env), build(c.env));
        if (rescued !== null) {
          return rescued;
        }
      }
      return failed(c, 503, maintenanceError());
    }
    if (error instanceof HTTPException) {
      return error.res === undefined ? mastodonError(error.status, error.message || "Error") : error.getResponse();
    }
    // The route template, not the URL: a path or query can carry a token or content (DATA-5).
    console.error({
      event: "kopje.error",
      method: loggedMethod(c.req.method),
      route: c.req.routePath,
      status: 500,
      ...errorFields(error),
    });
    return failed(c, 500, mastodonError(500, "Internal Server Error"));
  });

  return app;
}
