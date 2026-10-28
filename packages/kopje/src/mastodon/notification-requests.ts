import { POLICY_DEFAULTS, type PolicyChoice, type PolicyColumn } from "../domain/audience";
import { MAX_BULK_REQUESTS, type Policy, type PolicyView } from "../domain/notification-requests";
import {
  type ApiContext,
  type ApiDeps,
  type ApiHandler,
  authorized,
  present,
  refuseAfterAuth,
  requestParams,
  storeCall,
  userCredential,
} from "./context";
import { mastodonError } from "./errors";
import { pageQuery, pageResponse } from "./pagination";
import { parseBoolean } from "./params";

// The notification policy (Mastodon 4.5's /api/v1 and /api/v2/notifications/policy) and notification requests
// (/api/v1/notifications/requests); the Store does the work (domain/notification-requests.ts).

const NOT_FOUND = () => mastodonError(404, "Record not found");

const COLUMNS = Object.keys(POLICY_DEFAULTS) as PolicyColumn[];

// The v1 columns: for_limited_accounts has no v1 form.
const V1_COLUMNS = ["for_not_following", "for_not_followers", "for_new_accounts", "for_private_mentions"] as const;

const CHOICES: readonly PolicyChoice[] = ["accept", "filter", "drop"];

// REST::NotificationPolicySerializer.
function v2Policy({ policy, summary }: PolicyView) {
  return { ...policy, summary };
}

// REST::V1::NotificationPolicySerializer: each condition as whether it is anything but accept.
function v1Policy({ policy, summary }: PolicyView) {
  return {
    ...Object.fromEntries(
      V1_COLUMNS.map((column) => [column.replace(/^for_/, "filter_"), policy[column] !== "accept"]),
    ),
    summary,
  };
}

export const getPolicyV1: ApiHandler = async (c, deps) => {
  const credential = userCredential(c, deps);
  return c.json(v1Policy(authorized(await storeCall(c, deps, (s, b) => s.getNotificationPolicy(b, { credential })))));
};

export const getPolicyV2: ApiHandler = async (c, deps) => {
  const credential = userCredential(c, deps);
  return c.json(v2Policy(authorized(await storeCall(c, deps, (s, b) => s.getNotificationPolicy(b, { credential })))));
};

async function update(c: ApiContext, deps: ApiDeps, changes: Partial<Policy>) {
  const credential = userCredential(c, deps);
  return authorized(
    await storeCall(c, deps, (s, b) => s.updateNotificationPolicy(b, { credential, changes, now: deps.now() })),
  );
}

// PATCH and PUT /api/v1/notifications/policy: filter_not_following, filter_not_followers, filter_new_accounts and
// filter_private_mentions, each setting its condition to filter (true) or accept (false), as NotificationPolicy's v1
// setters do. Mastodon's setter takes any value Ruby holds true, so a form's "false" filters there; Kopje reads the
// values as Rails casts booleans ("0", "f", "false", "off" and blank are false), as clients mean them.
export const updatePolicyV1: ApiHandler = async (c, deps) => {
  const p = await requestParams(c, deps);
  if (p instanceof Response) {
    return p;
  }
  const changes: Partial<Policy> = {};
  for (const column of V1_COLUMNS) {
    const value = p.get(column.replace(/^for_/, "filter_"));
    if (value !== undefined) {
      changes[column] = parseBoolean(value) === true ? "filter" : "accept";
    }
  }
  return c.json(v1Policy(await update(c, deps, changes)));
};

// PATCH and PUT /api/v2/notifications/policy: for_not_following, for_not_followers, for_new_accounts,
// for_private_mentions and for_limited_accounts, each accept, filter or drop (or the enum's integer, 0 to 2).
// Mastodon's enum refuses any other value with an ArgumentError ("'x' is not a valid for_not_following"), which no
// handler rescues, so it answers 500; Kopje answers 422 with that message, and changes nothing.
export const updatePolicyV2: ApiHandler = async (c, deps) => {
  const p = await requestParams(c, deps);
  if (p instanceof Response) {
    return p;
  }
  const changes: Partial<Policy> = {};
  for (const column of COLUMNS) {
    const value = p.get(column);
    if (value === undefined) {
      continue;
    }
    const choice = CHOICES.find((name, index) => value === name || value === String(index));
    if (choice === undefined) {
      return refuseAfterAuth(c, deps, mastodonError(422, `'${value}' is not a valid ${column}`));
    }
    changes[column] = choice;
  }
  return c.json(v2Policy(await update(c, deps, changes)));
};

// GET /api/v1/notifications/requests: 40 by default, at most 80, by max_id, since_id and min_id, with Link headers.
export const listRequests: ApiHandler = async (c, deps) => {
  const p = await requestParams(c, deps);
  if (p instanceof Response) {
    return p;
  }
  const page = pageQuery(p);
  const credential = userCredential(c, deps);
  const result = authorized(
    await storeCall(c, deps, (s, b) => s.listNotificationRequests(b, { credential, page, present: present(c) })),
  );
  return pageResponse(c, result, page.limit);
};

export const getRequest: ApiHandler = async (c, deps) => {
  const id = c.req.param("id") ?? "";
  const credential = userCredential(c, deps);
  const request = authorized(
    await storeCall(c, deps, (s, b) => s.getNotificationRequest(b, { credential, id, present: present(c) })),
  );
  return request === null ? NOT_FOUND() : c.json(request);
};

export const acceptRequest: ApiHandler = async (c, deps) => {
  const input = { credential: userCredential(c, deps), id: c.req.param("id") ?? "", now: deps.now() };
  const found = authorized(await storeCall(c, deps, (s, b) => s.acceptNotificationRequest(b, input)));
  return found ? c.json({}) : NOT_FOUND();
};

export const dismissRequest: ApiHandler = async (c, deps) => {
  const input = { credential: userCredential(c, deps), id: c.req.param("id") ?? "", now: deps.now() };
  const found = authorized(await storeCall(c, deps, (s, b) => s.dismissNotificationRequest(b, input)));
  return found ? c.json({}) : NOT_FOUND();
};

// id[] of the bulk forms (set_requests: Array(params[:id]).uniq), at most MAX_BULK_REQUESTS.
async function bulkIds(c: ApiContext, deps: ApiDeps): Promise<string[] | Response> {
  const p = await requestParams(c, deps);
  if (p instanceof Response) {
    return p;
  }
  const ids = [...new Set(p.getAll("id"))];
  if (ids.length > MAX_BULK_REQUESTS) {
    return refuseAfterAuth(
      c,
      deps,
      mastodonError(422, `Validation failed: at most ${MAX_BULK_REQUESTS} requests can be answered at once`),
    );
  }
  return ids;
}

export const acceptRequests: ApiHandler = async (c, deps) => {
  const ids = await bulkIds(c, deps);
  if (ids instanceof Response) {
    return ids;
  }
  const input = { credential: userCredential(c, deps), ids, now: deps.now() };
  authorized(await storeCall(c, deps, (s, b) => s.acceptNotificationRequests(b, input)));
  return c.json({});
};

export const dismissRequests: ApiHandler = async (c, deps) => {
  const ids = await bulkIds(c, deps);
  if (ids instanceof Response) {
    return ids;
  }
  const input = { credential: userCredential(c, deps), ids };
  authorized(await storeCall(c, deps, (s, b) => s.dismissNotificationRequests(b, input)));
  return c.json({});
};

export const merged: ApiHandler = async (c, deps) => {
  const credential = userCredential(c, deps);
  return c.json(authorized(await storeCall(c, deps, (s, b) => s.notificationRequestsMerged(b, { credential }))));
};
