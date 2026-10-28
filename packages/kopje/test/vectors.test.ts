import { base64url } from "jose";
import { describe, expect, it } from "vitest";

import scopeDoc from "../docs/mastodon-api-spec/client-api/auth-oauth.md?raw";
import { grants, type Scope, SCOPES, withinScopes } from "../src/security/scopes";
import { PKCE_CHALLENGE, PKCE_VERIFIER, pkceChallenge } from "../src/security/tokens";
import { apiHarness, decide, form, seedAccount, sql } from "./api-helpers";
import { NOW } from "./app-helpers";

// Hand-written protocol code checked against the examples of the standards and of Mastodon's API docs.

describe("RFC 7636 Appendix B", () => {
  // The verifier is given in the RFC as these 32 octets and their base64url encoding.
  const VERIFIER_OCTETS = [
    116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212, 37, 77, 105, 214, 191, 240, 91,
    88, 5, 88, 83, 132, 141, 121,
  ];
  const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";

  it("derives the S256 challenge of the example verifier", async () => {
    expect(base64url.encode(new Uint8Array(VERIFIER_OCTETS))).toBe(VERIFIER);
    expect(PKCE_VERIFIER.test(VERIFIER)).toBe(true);
    const challenge = await pkceChallenge(VERIFIER);
    expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    expect(PKCE_CHALLENGE.test(challenge)).toBe(true);
  });
});

// The parent and child scopes of the "Scope Hierarchy" table in docs/mastodon-api-spec/client-api/auth-oauth.md.
function documentedHierarchy(): [Scope, Scope[]][] {
  const section = scopeDoc.slice(scopeDoc.indexOf("### Scope Hierarchy"), scopeDoc.indexOf("### Special Scopes"));
  return [...section.matchAll(/^\| `([^`]+)` \| (.+) \|$/gm)].map((match) => [
    match[1] as Scope,
    [...match[2]!.matchAll(/`([^`]+)`/g)].map((child) => child[1] as Scope),
  ]);
}

describe("Mastodon's scope hierarchy", () => {
  const hierarchy = documentedHierarchy();

  it("reads the documented table", () => {
    expect(hierarchy.map(([parent]) => parent)).toEqual(["read", "write", "admin:read", "admin:write"]);
  });

  it.each(hierarchy)("%s covers each documented child, and no child covers it", (parent, children) => {
    expect(children.length).toBeGreaterThan(0);
    for (const child of children) {
      expect(grants([parent], child), child).toBe(true);
      expect(grants([child], parent), child).toBe(false);
      expect(withinScopes([child], [parent]), child).toBe(true);
    }
  });

  it("no parent covers another parent's children", () => {
    for (const [parent] of hierarchy) {
      for (const [other, children] of hierarchy) {
        if (other !== parent && !(other.startsWith(`${parent}:`) || parent.startsWith(`${other}:`))) {
          for (const child of children) {
            expect(grants([parent], child), `${parent} ${child}`).toBe(false);
          }
        }
      }
    }
  });

  it("issues every documented scope, the special ones included", () => {
    const special = scopeDoc.slice(scopeDoc.indexOf("### Special Scopes"), scopeDoc.indexOf("### Default Scope"));
    const documented = [
      ...hierarchy.flatMap(([parent, children]) => [parent, ...children]),
      ...[...special.matchAll(/^\| `([^`]+)` \|/gm)].map((match) => match[1]!),
    ];
    expect(documented).toContain("profile");
    expect(documented.filter((scope) => !SCOPES.includes(scope as Scope))).toEqual([]);
  });
});

// The client of RFC 6749's examples: client_id s6BhdRkqt3, secret 7Fjfp0ZBr1KtDRbnfVdmIw, callback
// https://client.example.com/cb.
const RFC_CLIENT = { client_id: "s6BhdRkqt3", client_secret: "7Fjfp0ZBr1KtDRbnfVdmIw" };
const RFC_BASIC = "Basic czZCaGRSa3F0Mzo3RmpmcDBaQnIxS3REUmJuZlZkbUl3";

async function rfcHarness() {
  const h = await apiHarness();
  await seedAccount(h.store, { username: "alice", email: "alice@example.com" });
  await sql(
    h.store,
    `INSERT INTO oauth_clients (id, secret, name, redirect_uris, website, scopes, created_at)
		VALUES (?, ?, 'Example', 'https://client.example.com/cb', NULL, 'read', ?)`,
    RFC_CLIENT.client_id,
    RFC_CLIENT.client_secret,
    new Date(NOW).toISOString(),
  );
  return h;
}

describe("RFC 6749 examples", () => {
  it("§4.1.2.1: redirects a denial exactly as the example does", async () => {
    const h = await rfcHarness();
    const response = await decide(h, { ...RFC_CLIENT, redirect_uri: "https://client.example.com/cb" }, "deny", {
      scope: "read",
      state: "xyz",
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://client.example.com/cb?error=access_denied&state=xyz");
  });

  it("§2.3.1 and §4.4.2: authenticates the example Basic header", async () => {
    const h = await rfcHarness();
    const response = await h.request(
      "/oauth/token",
      form({ grant_type: "client_credentials" }, { headers: { authorization: RFC_BASIC } }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(await response.json()).toMatchObject({ token_type: "Bearer", scope: "read" });
  });

  it("§5.2: answers an error as a JSON object that is never cached", async () => {
    const h = await rfcHarness();
    const response = await h.request(
      "/oauth/token",
      form({ grant_type: "password" }, { headers: { authorization: RFC_BASIC } }),
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toMatch(/^application\/json/);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(await response.json()).toMatchObject({ error: "unsupported_grant_type" });
  });
});

describe("RFC 7009 examples", () => {
  it("§2.1 and §2.2: accepts the example revocation of an unknown token with 200", async () => {
    const h = await rfcHarness();
    const response = await h.request(
      "/oauth/revoke",
      form(
        { token: "45ghiukldjahdnhzdauz", token_type_hint: "refresh_token" },
        { headers: { authorization: RFC_BASIC } },
      ),
    );
    expect(response.status).toBe(200);
  });

  it("§2.2.1: answers a failed client authentication as RFC 6749 §5.2 invalid_client", async () => {
    const h = await rfcHarness();
    const response = await h.request(
      "/oauth/revoke",
      form({ token: "45ghiukldjahdnhzdauz" }, { headers: { authorization: `Basic ${btoa("s6BhdRkqt3:wrong")}` } }),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toMatch(/^Basic /);
    expect(await response.json()).toMatchObject({ error: "invalid_client" });
  });
});
