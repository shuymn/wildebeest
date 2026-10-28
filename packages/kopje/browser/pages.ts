// The browser job's fixture pages: one of each page type, with the path it is served at and the headers it is sent with
// (headers.ts). fixtures/pages.tsx renders each with the real components; a new page type is one more entry here and
// there.

export const DOMAIN = "kopje.test";
export const ORIGIN = `https://${DOMAIN}`;

// 'l1': a public page that loads the L1 bundle; 'handoff': a handoff page; 'consent': a consent page (no
// form-action); 'error' and 'unavailable': the 500 and 503 pages of app.ts.
type PageKind = "public" | "l1" | "private" | "embed" | "handoff" | "consent" | "error" | "unavailable";

export type FixturePage = { name: string; path: string; status: 200 | 400 | 404 | 500 | 503; kind: PageKind };

export const PAGES = [
  { name: "profile", path: "/@alice", status: 200, kind: "l1" },
  { name: "status", path: "/@alice/102", status: 200, kind: "l1" },
  { name: "thread", path: "/@alice/108", status: 200, kind: "l1" },
  { name: "boosts", path: "/@alice/101/reblogs", status: 200, kind: "l1" },
  { name: "quotes", path: "/@alice/101/quotes", status: 200, kind: "l1" },
  { name: "tag", path: "/tags/walks", status: 200, kind: "l1" },
  { name: "about", path: "/about", status: 200, kind: "public" },
  { name: "document", path: "/privacy-policy", status: 200, kind: "public" },
  { name: "followers", path: "/@alice/followers", status: 200, kind: "public" },
  { name: "follows-hidden", path: "/@carol/following", status: 200, kind: "public" },
  { name: "featured", path: "/@alice/featured", status: 200, kind: "public" },
  { name: "not-found", path: "/@nobody", status: 404, kind: "public" },
  { name: "embed", path: "/@alice/104/embed", status: 200, kind: "embed" },
  // /authorize_interaction's form, and what a look-up found (its POST answer, served here at a path of its own).
  { name: "interaction", path: "/authorize_interaction", status: 200, kind: "private" },
  { name: "interaction-result", path: "/authorize_interaction/result", status: 200, kind: "private" },
  // What a look-up found when it is a post, its author named by a long unbroken word.
  { name: "interaction-post", path: "/authorize_interaction/post", status: 200, kind: "private" },
  // The handoff pages: the form without a server, the form refusing one (served at a status's path of its own), and
  // the link to the server given.
  { name: "handoff-form", path: "/@alice/interact", status: 200, kind: "handoff" },
  { name: "handoff-refused", path: "/@alice/101/interact", status: 400, kind: "handoff" },
  { name: "handoff", path: "/@alice/102/interact", status: 200, kind: "handoff" },
  { name: "handoff-long", path: "/@bob/interact", status: 200, kind: "handoff" },
  // The signed-in settings page, and /setup's pages: the token form refusing a token, the wizard with a few results,
  // the checklist and the page after bootstrap (each served here at a path of its own).
  { name: "settings", path: "/settings", status: 200, kind: "private" },
  { name: "setup-login", path: "/setup/login", status: 200, kind: "private" },
  { name: "setup", path: "/setup", status: 200, kind: "private" },
  { name: "setup-checklist", path: "/setup/checklist", status: 200, kind: "private" },
  { name: "setup-done", path: "/setup/done", status: 200, kind: "private" },
  // The OAuth pages: a third-party app's consent, one with the longest name and website and every scope, the web UI's
  // own, and the out-of-band code (each at a path of its own).
  { name: "consent", path: "/oauth/authorize", status: 200, kind: "consent" },
  { name: "consent-long", path: "/oauth/authorize/long", status: 200, kind: "consent" },
  { name: "consent-first-party", path: "/oauth/authorize/first-party", status: 200, kind: "consent" },
  { name: "code", path: "/oauth/authorize/code", status: 200, kind: "private" },
  // The error pages of a browser's page request (app.ts).
  { name: "error-404", path: "/nope", status: 404, kind: "public" },
  { name: "error-500", path: "/error/500", status: 500, kind: "error" },
  { name: "error-503", path: "/error/503", status: 503, kind: "unavailable" },
] as const satisfies readonly FixturePage[];

export type PageName = (typeof PAGES)[number]["name"];

export function pageNamed(name: PageName): FixturePage {
  return PAGES.find((page) => page.name === name)!;
}
