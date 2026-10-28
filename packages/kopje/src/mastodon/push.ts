import { base64url } from "jose";

import { ALERT_TYPES, POLICIES, type PushData, type PushPolicy, type StoredSubscription } from "../domain/push";
import { webPushKeys } from "../platform/config";
import { publicShapeRefusal } from "../platform/http-url";
import { AUTH_SECRET_LENGTH, importClientKey, sealPushToken } from "../security/web-push";
import { bearerToken } from "./access";
import {
  type ApiHandler,
  authorized,
  refuseAfterAuth,
  requestParams,
  storeCall,
  userCredential,
  vapidKey,
} from "./context";
import { mastodonError } from "./errors";
import { type Params, parseBoolean } from "./params";

// /api/v1/push/subscription (Mastodon 4.5): the subscription of the request's own token (PUSH-1), under the push
// scope. Without a VAPID_JWK Web Push is unavailable: the instance advertises no key, and reading, creating or
// updating a subscription answers 404, as on a server without the endpoint; deleting still works. The endpoint is an
// outbound sink (PUSH-2): it must pass NET-3's host rules here, and passes them again with a DNS check at every send.

const NOT_FOUND = () => mastodonError(404, "Record not found");
const MISSING = () => mastodonError(400, "param is missing or the value is empty or invalid: subscription");
const invalid = (what: string) => mastodonError(422, `Validation failed: ${what}`);

const MAX_ENDPOINT_LENGTH = 2048;

// The JWK when Web Push is available.
const vapidJwk = (env: Env): JsonWebKey | null => webPushKeys(env)?.jwk ?? null;

function present(subscription: StoredSubscription, env: Env) {
  const { id, endpoint, standard, alerts, policy } = subscription;
  return { id, endpoint, standard, alerts, server_key: vapidKey(env), policy };
}

// A client key as Ruby's urlsafe_decode64 reads it: either alphabet, padding optional.
function decodeKey(value: string): Uint8Array | null {
  try {
    return base64url.decode(value.replace(/=+$/, "").replaceAll("+", "-").replaceAll("/", "_"));
  } catch {
    return null;
  }
}

// The data parameter (Mastodon permits data[policy] and data[alerts][<type>] for its notification types). Alerts
// left out stay out, as Mastodon stores them; a blank value is left out too.
function dataParams(p: Params): PushData | Response {
  const alerts: Record<string, boolean> = {};
  for (const type of ALERT_TYPES) {
    const value = parseBoolean(p.get(`data[alerts][${type}]`));
    if (value !== undefined) {
      alerts[type] = value;
    }
  }
  const policy = p.get("data[policy]") ?? "";
  if (policy === "") {
    return { alerts, policy: "all" };
  }
  return (POLICIES as readonly string[]).includes(policy)
    ? { alerts, policy: policy as PushPolicy }
    : invalid("Policy is not included in the list");
}

type Keys = { endpoint: string; p256dh: string; auth: string };

async function subscriptionParams(p: Params): Promise<Keys | Response> {
  const endpoint = p.get("subscription[endpoint]") ?? "";
  const p256dh = p.get("subscription[keys][p256dh]") ?? "";
  const auth = p.get("subscription[keys][auth]") ?? "";
  if (endpoint === "" || p256dh === "" || auth === "") {
    return MISSING();
  }
  const url = endpoint.length > MAX_ENDPOINT_LENGTH ? null : URL.parse(endpoint);
  if (url === null || publicShapeRefusal(url) !== null) {
    return invalid("Endpoint is invalid");
  }
  const key = decodeKey(p256dh);
  if (key === null || (await importClientKey(key)) === null) {
    return invalid("Key p256dh is invalid");
  }
  const secret = decodeKey(auth);
  if (secret?.length !== AUTH_SECRET_LENGTH) {
    return invalid("Key auth is invalid");
  }
  return { endpoint: url.href, p256dh: base64url.encode(key), auth: base64url.encode(secret) };
}

export const createSubscription: ApiHandler = async (c, deps) => {
  const p = await requestParams(c, deps);
  if (p instanceof Response) {
    return p;
  }
  const jwk = vapidJwk(c.env);
  if (jwk === null) {
    return refuseAfterAuth(c, deps, NOT_FOUND());
  }
  const keys = await subscriptionParams(p);
  if (keys instanceof Response) {
    return refuseAfterAuth(c, deps, keys);
  }
  const data = dataParams(p);
  if (data instanceof Response) {
    return refuseAfterAuth(c, deps, data);
  }
  // The access middleware read this token and the route requires one.
  const token = bearerToken(c.req.header("authorization")) ?? "";
  const tokenSealed = await sealPushToken(jwk, c.get("credential")?.tokenHash ?? "", token);
  const credential = userCredential(c, deps);
  const standard = parseBoolean(p.get("subscription[standard]")) ?? false;
  const subscription = authorized(
    await storeCall(c, deps, (s, b) =>
      s.createPushSubscription(b, { credential, ...keys, ...data, standard, tokenSealed }),
    ),
  );
  return c.json(present(subscription, c.env));
};

export const getSubscription: ApiHandler = async (c, deps) => {
  if (vapidJwk(c.env) === null) {
    return refuseAfterAuth(c, deps, NOT_FOUND());
  }
  const credential = userCredential(c, deps);
  const subscription = authorized(await storeCall(c, deps, (s, b) => s.getPushSubscription(b, { credential })));
  return subscription === null ? NOT_FOUND() : c.json(present(subscription, c.env));
};

export const updateSubscription: ApiHandler = async (c, deps) => {
  const p = await requestParams(c, deps);
  if (p instanceof Response) {
    return p;
  }
  if (vapidJwk(c.env) === null) {
    return refuseAfterAuth(c, deps, NOT_FOUND());
  }
  const data = dataParams(p);
  if (data instanceof Response) {
    return refuseAfterAuth(c, deps, data);
  }
  const credential = userCredential(c, deps);
  const subscription = authorized(
    await storeCall(c, deps, (s, b) => s.updatePushSubscription(b, { credential, ...data })),
  );
  return subscription === null ? NOT_FOUND() : c.json(present(subscription, c.env));
};

export const deleteSubscription: ApiHandler = async (c, deps) => {
  const credential = userCredential(c, deps);
  authorized(await storeCall(c, deps, (s, b) => s.deletePushSubscription(b, { credential })));
  return c.json({});
};
