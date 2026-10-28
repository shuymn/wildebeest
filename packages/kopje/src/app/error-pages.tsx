import type { Context } from "hono";

import { MAINTENANCE_RETRY_AFTER_SECONDS } from "../mastodon/errors";
import { type ErrorStatus, ErrorView } from "../web/pages/message";
import { PRIVATE_HEADERS, PUBLIC_HEADERS } from "./web-headers";

// The error pages app.ts answers a browser's page request with, in place of the API's answers. Each reads nothing of
// the Store, which may be what failed, so none shows the site's chrome.

export type { ErrorStatus };

// The page of each status, ErrorView without the chrome; nothing of the error that caused it is shown (a 500 is
// logged by route, DATA-5).
export function ErrorPage({ status }: { status: ErrorStatus }) {
  return <ErrorView chrome={null} status={status} />;
}

// 404 is the public pages' ordinary one with their headers; 500 and 503 are never kept, and 503 keeps
// maintenanceError's Retry-After. Each varies with Accept, as the document answered in its place does.
const FAILED = { ...PRIVATE_HEADERS, vary: "Accept" };
const HEADERS = {
  404: PUBLIC_HEADERS,
  500: FAILED,
  503: { ...FAILED, "retry-after": String(MAINTENANCE_RETRY_AFTER_SECONDS) },
};

export function errorPage(c: Context, status: ErrorStatus): Response | Promise<Response> {
  return c.html(<ErrorPage status={status} />, status, HEADERS[status]);
}
