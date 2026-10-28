import { describe, expect, it } from "vitest";

import { CONSENT_PAGE_HEADERS, PRIVATE_PAGE_HEADERS } from "../browser/headers";
import { STYLESHEET } from "../src/web/asset-versions";
import { STRINGS } from "../src/web/strings";
import { consentPage, decide, registerApp, withAlice } from "./api-helpers";
import { attr, classes, one, parseHtml, query, text } from "./web-dom";
import { ICON_LINKS, iconLinksOf, startSignIn } from "./web-helpers";

// The pages of /oauth/authorize (app/authorize.tsx): the private pages' headers and script-free CSP (WEB-2), the
// shared layout and stylesheet, and the catalogue's text.

// The private pages' answer: their exact headers (no 'unsafe-inline', no script source; the consent page's have no
// form-action), the stylesheet, no script.
async function privatePage(
  response: Response,
  status: number,
  headers: Readonly<Record<string, string>> = PRIVATE_PAGE_HEADERS,
) {
  expect(response.status).toBe(status);
  expect(Object.fromEntries(response.headers)).toEqual(headers);
  const html = await response.text();
  expect(html.startsWith('<!DOCTYPE html><html lang="en">')).toBe(true);
  expect(html).toContain(`<link rel="stylesheet" href="${STYLESHEET}"/>`);
  expect(iconLinksOf(html)).toEqual(ICON_LINKS);
  expect(html).not.toContain("<script");
  expect(html).not.toContain("<style");
  // No instant for the bundle these pages do not load to rewrite (DateTime's data-local).
  expect(html).not.toContain("data-local");
  return parseHtml(html);
}

describe("the OAuth pages", () => {
  it("show a third-party app its name, website as text, the account and each scope, approve before deny", async () => {
    const h = await withAlice();
    const app = await registerApp(h);
    const doc = await privatePage(
      await consentPage(h, app, { scope: "read write:statuses follow" }),
      200,
      CONSENT_PAGE_HEADERS,
    );
    expect(text(one(doc, "h1"))).toBe("Authorize Test Client");
    const terms = query(doc, "dt").map(text);
    const values = query(doc, "dd").map(text);
    expect(terms).toEqual(["Website", "Account", "Permissions"]);
    // The website by its host (the whole URL in hidden text), the account by its full address.
    expect(values.slice(0, 2)).toEqual(["client.test (https://client.test)", "@alice@kopje.test"]);
    // The client's claimed website is never a link (the header's link is to the site's root).
    expect(query(doc, "a").map((a) => attr(a, "href"))).toEqual(["#content", "/"]);
    // The permissions by group in plain language, the scopes' own names behind a disclosure.
    const scopes = one(doc, "ul", "scopes");
    expect(attr(scopes, "role")).toBe("list");
    expect(query(scopes, "li").map(text)).toEqual([
      "Read your account and its posts",
      "Post and change things for you",
      "Follow, block and mute for you",
    ]);
    const technical = one(doc, "details", "tech");
    expect(text(one(technical, "summary"))).toBe("Technical scopesShowHide");
    expect(text(one(technical, "p"))).toBe("read write:statuses follow");
    // No admin scope, no alert.
    expect(query(doc, "div", "alert")).toEqual([]);
    const buttons = query(doc, "button").map((b) => [classes(b).join(" "), attr(b, "value"), text(b)]);
    expect(buttons).toEqual([
      ["btn primary", "approve", "Authorize"],
      ["btn", "deny", "Deny"],
    ]);
    const form = one(doc, "form");
    expect([attr(form, "method"), attr(form, "action")]).toEqual(["post", "/oauth/authorize"]);
  });

  it("warn of admin scopes in a danger alert, in plain language", async () => {
    const h = await withAlice();
    const app = await registerApp(h, { scopes: "read admin:read" });
    const doc = await privatePage(await consentPage(h, app, { scope: "read admin:read" }), 200, CONSENT_PAGE_HEADERS);
    const alert = one(doc, "div", "alert");
    expect(classes(alert)).toEqual(["alert", "fail"]);
    expect(query(alert, "p").map(text)).toEqual([
      "This app asks to administer this server",
      "Moderate and administer this server",
    ]);
    expect(text(one(doc, "details", "tech"))).toContain("admin:read");
  });

  it("word the instance’s own web UI as signing in", async () => {
    const h = await withAlice();
    const { consent } = await startSignIn(h);
    const doc = await privatePage(consent, 200, CONSENT_PAGE_HEADERS);
    expect(text(one(doc, "h1"))).toBe("Sign in");
    expect(text(one(one(doc, "main"), "p"))).toBe("Sign in to this server's settings as @alice@kopje.test?");
    expect(query(doc, "dl")).toEqual([]);
    expect(query(doc, "button").map((b) => [classes(b).join(" "), text(b)])).toEqual([
      ["btn primary", "Sign in"],
      ["btn", "Cancel"],
    ]);
  });

  it("show the out-of-band code whole in a field, with no copy control", async () => {
    const h = await withAlice();
    const app = await registerApp(h, { redirectUri: "urn:ietf:wg:oauth:2.0:oob" });
    const doc = await privatePage(await decide(h, app, "approve"), 200);
    expect(text(one(doc, "h1"))).toBe("Authorization code");
    // Named "Code", the instruction below it, the value alone (the page runs no script).
    expect(text(one(doc, "p", "flabel"))).toBe("Code");
    const field = one(doc, "div", "copy");
    expect(query(field, "span").map((c) => [classes(c).join(" "), text(c)])).toEqual([
      ["mono", expect.stringMatching(/^token-\d+-/)],
    ]);
    expect(query(one(doc, "div", "copyfield"), "p", "hint").map(text)).toEqual([
      "Paste this code into the application.",
    ]);
    expect(query(doc, "button")).toEqual([]);
  });

  it("show their refusals from the catalogue, the out-of-band errors with their code", async () => {
    const h = await withAlice();
    const unknown = await privatePage(
      await consentPage(h, { client_id: "nope", client_secret: "", redirect_uri: "https://client.test/callback" }),
      400,
    );
    expect(query(unknown, "h1").map(text)).toEqual(["Unknown application"]);
    expect(text(one(one(unknown, "main"), "p"))).toBe("The application is not registered on this server.");
    const app = await registerApp(h, { redirectUri: "urn:ietf:wg:oauth:2.0:oob", scopes: "read" });
    const failed = await privatePage(await consentPage(h, app, { scope: "write" }), 400);
    expect(query(failed, "h1").map(text)).toEqual(["Authorization failed"]);
    expect(text(one(one(failed, "main"), "p"))).toBe(`invalid_scope: ${STRINGS.oauth.problems.invalidScope}`);
    // The redirect's error_description stays the protocol value.
    const redirected = await consentPage(h, await registerApp(h, { scopes: "read" }), { scope: "write" });
    expect(new URL(redirected.headers.get("location")!).searchParams.get("error_description")).toBe(
      "The requested scope is invalid, unknown, or not allowed for this application.",
    );
    const denied = await privatePage(await decide(h, app, "deny", { scope: "read" }), 403);
    expect(query(denied, "h1").map(text)).toEqual(["Authorization denied"]);
  });

  // WEB-2: the decision's answer redirects to the app's redirect URI, which may redirect on anywhere, and browsers
  // check form-action on every hop, so the consent page alone has none; the flow's other pages keep 'self'.
  it("send the consent page without form-action, its form carrying the verified redirect URI", async () => {
    const h = await withAlice();
    const consentOf = async (redirectUri: string, chosen = redirectUri) => {
      const app = await registerApp(h, { redirectUri });
      const doc = await privatePage(await consentPage(h, { ...app, redirect_uri: chosen }), 200, CONSENT_PAGE_HEADERS);
      const field = query(doc, "input").find((input) => attr(input, "name") === "redirect_uri");
      expect(field === undefined ? null : attr(field, "value"), chosen).toBe(chosen);
      return app;
    };
    await consentOf("https://client.test/callback");
    await consentOf("com.example.app://oauth/callback");
    await consentOf("urn:ietf:wg:oauth:2.0:oob");
    // Of several registered URIs, the one the request chose; the decision is validated again, so a URI the client
    // did not register is refused on the page.
    const app = await consentOf("https://one.test/cb https://two.test/cb", "https://two.test/cb");
    const refused = await privatePage(
      await decide(h, { ...app, redirect_uri: "https://three.test/cb" }, "approve"),
      400,
    );
    expect(text(one(refused, "h1"))).toBe("Invalid request");
  });
});
