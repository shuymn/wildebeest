import { SCHEDULED_PAGE } from "../domain/scheduled-statuses";
import { type ApiHandler, authorized, requestParams, storeCall, userCredential } from "./context";
import { mastodonError } from "./errors";
import { pageQuery, pageResponse } from "./pagination";
import { parseScheduledAt } from "./statuses";

// Scheduled statuses (Mastodon 4.5's Api::V1::ScheduledStatusesController); the Store does the work
// (domain/scheduled-statuses.ts). Scheduling is POST /api/v1/statuses with scheduled_at (statuses.ts). A scheduled
// status that is not the viewer's is not found.

const NOT_FOUND = () => mastodonError(404, "Record not found");

function scheduledId(c: Parameters<ApiHandler>[0]): string {
  return c.req.param("id") ?? "";
}

// GET /api/v1/scheduled_statuses: 20 by default, at most 40, with Link headers.
export const list: ApiHandler = async (c, deps) => {
  const p = await requestParams(c, deps);
  if (p instanceof Response) {
    return p;
  }
  const page = pageQuery(p, SCHEDULED_PAGE.limit, SCHEDULED_PAGE.max);
  const input = { credential: userCredential(c, deps), page };
  return pageResponse(c, authorized(await storeCall(c, deps, (s, b) => s.listScheduled(b, input))), page.limit);
};

export const show: ApiHandler = async (c, deps) => {
  const input = { credential: userCredential(c, deps), id: scheduledId(c) };
  const scheduled = authorized(await storeCall(c, deps, (s, b) => s.getScheduled(b, input)));
  return scheduled === null ? NOT_FOUND() : c.json(scheduled);
};

// PUT and PATCH: scheduled_at only (params.permit(:scheduled_at)); anything else sent is ignored.
export const update: ApiHandler = async (c, deps) => {
  const p = await requestParams(c, deps);
  if (p instanceof Response) {
    return p;
  }
  const raw = p.get("scheduled_at");
  const scheduledAt = raw === undefined ? undefined : parseScheduledAt(raw);
  const input = { credential: userCredential(c, deps), id: scheduledId(c), scheduledAt, now: deps.now() };
  const result = authorized(await storeCall(c, deps, (s, b) => s.updateScheduled(b, input)));
  switch (result.status) {
    case "ok":
      return c.json(result.value);
    case "not_found":
      return NOT_FOUND();
    case "invalid":
      return mastodonError(422, result.error);
  }
};

export const destroy: ApiHandler = async (c, deps) => {
  const input = { credential: userCredential(c, deps), id: scheduledId(c), now: deps.now() };
  const deleted = authorized(await storeCall(c, deps, (s, b) => s.deleteScheduled(b, input)));
  return deleted ? c.json({}) : NOT_FOUND();
};
