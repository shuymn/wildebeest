import type { MaintenanceMode } from "../platform/maintenance";

// How a request is treated in maintenance.
//   always  : actor documents and keys, WebFinger, NodeInfo, and /health GETs
//   read    : any other GET (API, HTML, /ap/o)
//   session : /oauth/*, signing out of the web UI, app registration (a client registers before it logs in), and Web Push registration
//   write   : any other write
//   inbox   : POST to an inbox
export type RequestClass = "always" | "read" | "session" | "write" | "inbox";

export type GateDecision = "serve" | "unavailable" | "spool";

const DECISIONS: Record<RequestClass, Record<MaintenanceMode, GateDecision>> = {
  always: { off: "serve", readonly: "serve", full: "serve" },
  read: { off: "serve", readonly: "serve", full: "unavailable" },
  session: { off: "serve", readonly: "serve", full: "unavailable" },
  write: { off: "serve", readonly: "unavailable", full: "unavailable" },
  inbox: { off: "serve", readonly: "spool", full: "spool" },
};

const ALWAYS_PATHS = [
  /^\/health$/,
  /^\/\.well-known\/(webfinger|host-meta|nodeinfo)$/,
  /^\/nodeinfo\/[^/]+$/,
  /^\/ap\/users\/[^/]+$/,
  /^\/actor$/,
];
const INBOX_PATHS = [/^\/inbox$/, /^\/ap\/users\/[^/]+\/inbox$/, /^\/actor\/inbox$/];

export function classifyRequest(method: string, path: string): RequestClass {
  const read = method === "GET" || method === "HEAD" || method === "OPTIONS";
  if (read) {
    return method !== "OPTIONS" && ALWAYS_PATHS.some((p) => p.test(path)) ? "always" : "read";
  }
  if (method === "POST" && INBOX_PATHS.some((p) => p.test(path))) {
    return "inbox";
  }
  if (
    path.startsWith("/oauth/") ||
    // Signing out ends a session, a session write like signing in.
    (path === "/logout" && method === "POST") ||
    (path === "/api/v1/apps" && method === "POST") ||
    (path === "/api/v1/push/subscription" && (method === "POST" || method === "PUT"))
  ) {
    return "session";
  }
  return "write";
}

export function decide(requestClass: RequestClass, mode: MaintenanceMode): GateDecision {
  return DECISIONS[requestClass][mode];
}
