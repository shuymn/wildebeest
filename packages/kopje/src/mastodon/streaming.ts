import { Hono } from "hono";

import { callStore } from "../platform/store-client";
import { sha256Hex } from "../security/tokens";
import type { ApiDeps } from "./context";

// The streaming API's Worker side (Mastodon 4.5's streaming server; the sockets live in the Store, stream-hub.ts).
// Kopje announces wss://<domain> as configuration.urls.streaming, and serves the WebSocket at /api/v1/streaming (and
// any path below it, as Mastodon's server takes an upgrade on any path) and the health check. SSE is not served: no
// surveyed client uses it, and a request that is not an upgrade answers 404.
//
// The token comes from the Authorization header, else Sec-WebSocket-Protocol (streaming/index.js accountFromRequest);
// the subprotocol a client offered is echoed, or browsers fail the handshake. Unlike Mastodon, an access_token query
// parameter is not read, as the REST API reads none (mastodon/access.ts): a URL reaches the platform's invocation logs,
// and a token there would too (DATA-5). masto.js and Ice Cubes send the subprotocol. Only the token's sha256 goes to
// the Store, which validates it.

const STORE_UPGRADE = "https://store.internal/stream/upgrade";

export function streamingRoutes(deps: Pick<ApiDeps, "build" | "now" | "store">) {
  const app = new Hono<{ Bindings: Env }>();

  app.get(
    "/api/v1/streaming/health",
    () =>
      new Response("OK", {
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "private, no-store" },
      }),
  );

  const stream = async (c: { req: { raw: Request }; env: Env }) => {
    const request = c.req.raw;
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    const url = new URL(request.url);
    const protocol = request.headers.get("sec-websocket-protocol")?.split(",")[0]?.trim() || undefined;
    const authorization = request.headers.get("authorization");
    const token = authorization ? authorization.replace(/^Bearer /, "") : protocol;
    if (!token) {
      return refusal(401, "Missing access token");
    }
    const forward = new URL(STORE_UPGRADE);
    for (const name of ["stream", "tag", "list"]) {
      const value = url.searchParams.get(name);
      if (value !== null) {
        forward.searchParams.set(name, value);
      }
    }
    const tokenHash = await sha256Hex(token);
    const response = await callStore(() =>
      deps.store(c.env).fetch(forward.toString(), {
        headers: {
          upgrade: "websocket",
          "x-kopje-build": deps.build(c.env),
          "x-kopje-token-hash": tokenHash,
          "x-kopje-now": String(deps.now()),
        },
      }),
    );
    if (response.status !== 101 || response.webSocket === null) {
      return refusal(response.status, response.headers.get("x-error-message") ?? "");
    }
    return new Response(null, {
      status: 101,
      webSocket: response.webSocket,
      headers: protocol === undefined ? {} : { "sec-websocket-protocol": protocol },
    });
  };
  app.get("/api/v1/streaming", stream);
  app.get("/api/v1/streaming/*", stream);
  return app;
}

// Mastodon's refused upgrade: the status, an empty body, and the message in X-Error-Message.
function refusal(status: number, message: string): Response {
  return new Response(null, { status, headers: { "content-type": "text/plain", "x-error-message": message } });
}
