import { describe, expect, it } from "vitest";

import { type ApiHarness, apiHarness, bearer, seedAccount, sql } from "./api-helpers";
import { appToken, appTokenWith, scopedToken } from "./read-helpers";
import { community } from "./status-helpers";

// Features Kopje has no data for yet answer empty, under the access Mastodon gives each route (AUTH-2).

describe("features without data yet", () => {
  const userLists: [string, string][] = [
    ["/api/v1/filters", "read:filters"],
    ["/api/v2/filters", "read:filters"],
  ];

  it.each(userLists)("%s is an empty list of the user, under %s (AUTH-2)", async (route, scope) => {
    const h = await apiHarness();
    await seedAccount(h.store, { username: "alice", email: "alice@example.com" });
    const response = await h.request(route, bearer(await scopedToken(h, scope)));
    expect(response.status).toBe(200);
    expect(response.headers.get("link")).toBeNull();
    expect(await response.json()).toEqual([]);
    expect((await h.request(route)).status).toBe(401);
    expect((await h.request(route, bearer("nope"))).status).toBe(401);
    expect((await h.request(route, bearer(await scopedToken(h, "write")))).status).toBe(403);
    expect((await h.request(route, bearer(await appToken(h)))).status).toBe(422);
  });

  it("a revoked token gets no empty list", async () => {
    const h = await community(["alice"]);
    await sql(h.store, "DELETE FROM oauth_tokens WHERE kind = 'access'");
    expect((await h.request("/api/v2/filters", bearer(h.users.alice.token))).status).toBe(401);
  });

  // Mastodon's answers when the feature has nothing to show or is not configured, each under its route's scope.
  const recordNotFound = { error: "Record not found" };
  const notFound = { error: "Not Found" };
  const userAnswers: [string, string, string, number, unknown][] = [
    ["GET", "/api/v1/annual_reports", "read:accounts", 200, { annual_reports: [], accounts: [], statuses: [] }],
    ["GET", "/api/v1/annual_reports/2025", "write:accounts", 404, recordNotFound],
    ["POST", "/api/v1/annual_reports/2025/read", "write:accounts", 404, recordNotFound],
    ["GET", "/api/v1/emails/check_confirmation", "read:accounts", 200, true],
    ["POST", "/api/v1/statuses/123/translate", "read:statuses", 404, notFound],
    ["GET", "/api/v1_alpha/async_refreshes/abc", "read", 404, notFound],
  ];

  const send = async (h: ApiHarness, method: string, route: string, token?: string) => {
    const response = await h.request(route, token === undefined ? { method } : bearer(token, { method }));
    return { status: response.status, body: await response.json<unknown>() };
  };

  it.each(userAnswers)("%s %s answers the user under %s (AUTH-2)", async (method, route, scope, status, body) => {
    const h = await apiHarness();
    const alice = await seedAccount(h.store, { username: "alice", email: "alice@example.com" });
    expect(await send(h, method, route, await scopedToken(h, scope))).toEqual({ status, body });
    expect((await send(h, method, route)).status).toBe(401);
    expect((await send(h, method, route, "nope")).status).toBe(401);
    // A scope the route does not take (read and write are disjoint; push covers neither).
    const other = scope.startsWith("read") ? "write" : scope.startsWith("write") ? "read" : "push";
    expect(await send(h, method, route, await scopedToken(h, other))).toEqual({
      status: 403,
      body: { error: "This action is outside the authorized scopes" },
    });
    expect(await send(h, method, route, await appTokenWith(h, scope))).toEqual({
      status: 422,
      body: { error: "This method requires an authenticated user" },
    });
    const token = await scopedToken(h, scope);
    await sql(h.store, "UPDATE local_accounts SET suspended_at = ? WHERE account_id = ?", "2026-01-01", alice);
    expect((await send(h, method, route, token)).status).toBe(403);
  });

  it("/api/v1/emails/confirmations refuses every token with write:accounts, as no user signed up through an app", async () => {
    const h = await apiHarness();
    await seedAccount(h.store, { username: "alice", email: "alice@example.com" });
    const refused = {
      status: 403,
      body: { error: "This method is only available to the application the user originally signed-up with" },
    };
    const route = "/api/v1/emails/confirmations";
    expect(await send(h, "POST", route, await scopedToken(h, "write:accounts"))).toEqual(refused);
    // Mastodon takes app tokens here, and refuses them for the same reason.
    expect(await send(h, "POST", route, await appTokenWith(h, "write:accounts"))).toEqual(refused);
    expect(await send(h, "POST", route, await scopedToken(h, "read"))).toEqual({
      status: 403,
      body: { error: "This action is outside the authorized scopes" },
    });
    expect((await send(h, "POST", route)).status).toBe(401);
    expect((await send(h, "POST", route, "nope")).status).toBe(401);
  });
});
