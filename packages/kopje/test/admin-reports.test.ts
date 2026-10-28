import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import type { PageQuery } from "../src/domain/accounts";
import { setAccountEmail } from "../src/domain/admin-accounts";
import { ANSWER_BYTES } from "../src/domain/answer-budget";
import { filterTextLimits, MAX_FILTER_REQUEST_TEXT, MAX_FILTER_TEXT } from "../src/domain/filters";
import { logAction, MODERATION_LOG_KEEP, MODERATION_LOG_PRUNE } from "../src/domain/moderation-log";
import { streamedNotification } from "../src/domain/notifications";
import {
  ADMIN_REPORT_STATUS_BUDGET,
  actOnReport,
  type AdminReportFilter,
  getAdminReport,
  listAdminReports,
  REPORT_COLUMNS,
  fileRemoteReports,
  REPORT_STATUS_BYTES,
  type ReportRow,
  userReport,
} from "../src/domain/reports";
import type { StoreStub } from "../src/platform/store-client";
import { sha256Hex } from "../src/security/tokens";
import { adminClaims, adminHarness, adminTeam, setTeamAccess, type AccessTeam } from "./access-helpers";
import { type ApiHarness, bearer, form, json, login, registerApp, seedAccount, setSetting, sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { type Answer, answer, hugeStatus, ORIGIN } from "./budget-helpers";
import { migratedStore } from "./helpers";
import { ACCESS, ADMIN_EMAIL } from "./ops-helpers";
import { observedSql } from "./read-helpers";
import { community, remoteAccount, remoteFollows, seedStatus, type User } from "./status-helpers";

// The Mastodon admin API's reports (R37, VIS-29; Api::V1::Admin::ReportsController, ReportFilter,
// REST::Admin::ReportSerializer and REST::Admin::AccountSerializer of Mastodon 4.5.11), the moderation log, and the
// Access admin's set-email.

const OWNER = "owner@example.com";
const ADMIN_SCOPES = "read write admin:read admin:write";

type AdminAccountBody = Record<string, unknown> & { id: string; role: unknown; email: string | null };
type AdminReportBody = Record<string, unknown> & {
  id: string;
  action_taken: boolean;
  action_taken_at: string | null;
  category: string;
  updated_at: string;
  account: AdminAccountBody;
  target_account: AdminAccountBody;
  assigned_account: AdminAccountBody | null;
  action_taken_by_account: AdminAccountBody | null;
  statuses: { id: string }[];
  rules: { id: string; text: string }[];
};

async function userToken(h: ApiHarness, email: string, scope = ADMIN_SCOPES): Promise<string> {
  const app = await registerApp(h, { scopes: scope });
  return (await login(h, { app, scope, email })).token;
}

async function appToken(h: ApiHarness): Promise<string> {
  const scope = "admin:read admin:write";
  const app = await registerApp(h, { scopes: scope });
  const response = await h.request(
    "/oauth/token",
    form({ grant_type: "client_credentials", client_id: app.client_id, client_secret: app.client_secret, scope }),
  );
  return (await response.json<{ access_token: string }>()).access_token;
}

// The owner (the OAuth admin), alice and bob (local reporters, who also hold admin scopes) and carol on
// remote.example with public statuses.
async function world() {
  const h = await community(["owner", "alice", "bob"]);
  await setSetting(h.store, "admin_email", OWNER);
  await setSetting(
    h.store,
    "rules",
    JSON.stringify([
      { id: "1", text: "No spam" },
      { id: "2", text: "Be kind", hint: "really" },
    ]),
  );
  const carol = await remoteAccount(h.store, "carol");
  const statuses = [
    await seedStatus(h.store, { accountId: carol, visibility: "public" }),
    await seedStatus(h.store, { accountId: carol, visibility: "public" }),
  ];
  const admin = await userToken(h, OWNER);
  const alice = { ...h.users.alice, admin: await userToken(h, "alice@example.com") };
  return { h, owner: h.users.owner, alice, bob: h.users.bob, carol, statuses, admin };
}

async function fileReport(h: ApiHarness, user: User, body: Record<string, unknown>): Promise<string> {
  const response = await h.request("/api/v1/reports", bearer(user.token, json(body)));
  expect(response.status).toBe(200);
  return (await response.json<{ id: string }>()).id;
}

async function call(h: ApiHarness, path: string, token: string | null, init: RequestInit = {}) {
  const response = await h.request(path, token === null ? init : bearer(token, init));
  return { status: response.status, link: response.headers.get("Link"), body: (await response.json()) as unknown };
}

const reportOf = async (h: ApiHarness, id: string, token: string) =>
  (await call(h, `/api/v1/admin/reports/${id}`, token)).body as AdminReportBody;

const logRows = (store: StoreStub) =>
  sql<{ actor: string; account_id: string | null; action: string; target_type: string; target_id: string }>(
    store,
    "SELECT actor, account_id, action, target_type, target_id FROM admin_actions ORDER BY id",
  );

// `count` reports by `reporter` of `target` written straight into the Store, each naming `statuses`, resolved or not.
async function seedReports(
  store: StoreStub,
  reporter: string,
  target: string,
  count: number,
  options: { resolved?: boolean; statuses?: string[] } = {},
): Promise<void> {
  await sql(
    store,
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
		INSERT INTO reports (account_id, target_account_id, status_ids, uri, created_at, action_taken_at)
		SELECT ?2, ?3, ?4, 'https://kopje.test/actor#reports/' || lower(hex(randomblob(16))), ?5, ?6 FROM n`,
    count,
    reporter,
    target,
    JSON.stringify(options.statuses ?? []),
    new Date(NOW).toISOString(),
    options.resolved === true ? new Date(NOW).toISOString() : null,
  );
}

const ROUTES: { method: string; path: (id: string) => string; scope: "read" | "write" }[] = [
  { method: "GET", path: () => "/api/v1/admin/reports", scope: "read" },
  { method: "GET", path: (id) => `/api/v1/admin/reports/${id}`, scope: "read" },
  { method: "PUT", path: (id) => `/api/v1/admin/reports/${id}`, scope: "write" },
  { method: "PATCH", path: (id) => `/api/v1/admin/reports/${id}`, scope: "write" },
  { method: "POST", path: (id) => `/api/v1/admin/reports/${id}/assign_to_self`, scope: "write" },
  { method: "POST", path: (id) => `/api/v1/admin/reports/${id}/unassign`, scope: "write" },
  { method: "POST", path: (id) => `/api/v1/admin/reports/${id}/resolve`, scope: "write" },
  { method: "POST", path: (id) => `/api/v1/admin/reports/${id}/reopen`, scope: "write" },
];

describe("admin report routes: who is answered", () => {
  it("serve the admin, and refuse a non-admin, an app token and an anonymous caller alike, writing nothing", async () => {
    const { h, alice, carol, statuses, admin } = await world();
    const id = await fileReport(h, alice, { account_id: carol, status_ids: [statuses[0]] });
    const before = await sql(h.store, "SELECT * FROM reports");
    const app = await appToken(h);
    for (const route of ROUTES) {
      const init = { method: route.method };
      for (const [who, token] of [
        ["non-admin", alice.admin],
        ["app", app],
        ["anonymous", null],
      ] as const) {
        const answer = await call(h, route.path(id), token, init);
        expect(answer, `${route.method} ${route.path(":id")} as ${who}`).toMatchObject({
          status: 403,
          body: { error: "This action is not allowed" },
        });
      }
      // A missing report is refused as an existing one is: its existence is not disclosed.
      expect((await call(h, route.path("999999"), alice.admin, init)).status).toBe(403);
    }
    expect(await sql(h.store, "SELECT * FROM reports")).toEqual(before);
    expect(await logRows(h.store)).toEqual([]);

    for (const route of ROUTES) {
      const answer = await call(h, route.path(id), admin, { method: route.method });
      expect(answer.status, `${route.method} ${route.path(":id")} as the admin`).toBe(200);
      if (route.path(id) !== "/api/v1/admin/reports") {
        expect(answer.body).toMatchObject({ id });
        expect(await call(h, route.path("999999"), admin, { method: route.method })).toMatchObject({
          status: 404,
          body: { error: "Record not found" },
        });
      }
    }
  });

  it("refuse a token without the route's scope, whoever holds it", async () => {
    const { h, alice, carol } = await world();
    const id = await fileReport(h, alice, { account_id: carol });
    const plain = await userToken(h, OWNER, "read write");
    const reader = await userToken(h, OWNER, "admin:read:reports");
    const writer = await userToken(h, OWNER, "admin:write:reports");
    for (const route of ROUTES) {
      const init = { method: route.method };
      for (const token of [plain, route.scope === "read" ? writer : reader]) {
        expect(await call(h, route.path(id), token, init)).toMatchObject({
          status: 403,
          body: { error: "This action is outside the authorized scopes" },
        });
      }
      expect((await call(h, route.path(id), route.scope === "read" ? reader : writer, init)).status).toBe(200);
      expect((await call(h, route.path(id), "not-a-token", init)).status).toBe(401);
    }
    expect((await logRows(h.store)).length).toBe(6);
  });
});

describe("GET /api/v1/admin/reports/:id", () => {
  it("answers REST::Admin::ReportSerializer with admin accounts, the statuses and the rules", async () => {
    const { h, owner, alice, carol, statuses, admin } = await world();
    const id = await fileReport(h, alice, {
      account_id: carol,
      status_ids: statuses,
      comment: "spam",
      rule_ids: ["2"],
    });
    const body = await reportOf(h, id, admin);
    expect(Object.keys(body)).toEqual([
      "id",
      "action_taken",
      "action_taken_at",
      "category",
      "comment",
      "forwarded",
      "created_at",
      "updated_at",
      "account",
      "target_account",
      "assigned_account",
      "action_taken_by_account",
      "statuses",
      "rules",
    ]);
    expect(body).toMatchObject({
      id,
      action_taken: false,
      action_taken_at: null,
      category: "violation",
      comment: "spam",
      forwarded: false,
      created_at: new Date(NOW).toISOString(),
      updated_at: new Date(NOW).toISOString(),
      assigned_account: null,
      action_taken_by_account: null,
      rules: [{ id: "2", text: "Be kind", hint: "really", translations: {} }],
    });
    expect(body.statuses.map((status) => status.id)).toEqual(statuses);
    expect(Object.keys(body.account)).toEqual([
      "id",
      "username",
      "domain",
      "created_at",
      "email",
      "ip",
      "confirmed",
      "suspended",
      "silenced",
      "sensitized",
      "disabled",
      "approved",
      "locale",
      "invite_request",
      "ips",
      "account",
      "role",
    ]);
    // A local reporter: its email, confirmed and approved, the default role.
    expect(body.account).toMatchObject({
      id: alice.id,
      username: "alice",
      domain: null,
      email: "alice@example.com",
      ip: null,
      confirmed: true,
      suspended: false,
      silenced: false,
      sensitized: false,
      disabled: false,
      approved: true,
      locale: null,
      invite_request: null,
      ips: [],
      account: { id: alice.id, acct: "alice" },
      role: { id: "-99", name: "", permissions: "0", color: "", highlighted: false },
    });
    // A remote account: what a missing User gives.
    expect(body.target_account).toMatchObject({
      id: carol,
      username: "carol",
      domain: "remote.example",
      email: null,
      confirmed: null,
      suspended: false,
      disabled: null,
      approved: null,
      locale: null,
      ips: [],
      account: { id: carol, acct: "carol@remote.example" },
      role: null,
    });
    // Assigned to the admin: the admin's account shows the Owner role with the permissions served.
    const assigned = (await call(h, `/api/v1/admin/reports/${id}/assign_to_self`, admin, { method: "POST" }))
      .body as AdminReportBody;
    expect(assigned.assigned_account).toMatchObject({
      id: owner.id,
      email: OWNER,
      role: { id: "3", name: "Owner", permissions: "1080", color: "", highlighted: true },
    });
  });

  it("shows a reported status only while its reporter may still see it (R37), with the admin as the viewer", async () => {
    const { h, alice, carol, statuses, admin } = await world();
    await remoteFollows(h.store, alice.id, carol);
    const secret = await seedStatus(h.store, { accountId: carol, visibility: "private" });
    const id = await fileReport(h, alice, { account_id: carol, status_ids: [statuses[0], secret] });
    expect((await reportOf(h, id, admin)).statuses.map((status) => status.id)).toEqual([statuses[0], secret]);
    // The admin never followed carol: the private status is shown because alice may see it.
    await sql(h.store, "DELETE FROM follows WHERE account_id = ? AND target_account_id = ?", alice.id, carol);
    expect((await reportOf(h, id, admin)).statuses.map((status) => status.id)).toEqual([statuses[0]]);
    // A status gone from the Store is not shown (Kopje keeps no discarded status); the report still names it.
    await sql(h.store, "DELETE FROM statuses WHERE id = ?", statuses[0]!);
    expect((await reportOf(h, id, admin)).statuses).toEqual([]);
    expect(await sql(h.store, "SELECT status_ids FROM reports")).toEqual([
      { status_ids: JSON.stringify([statuses[0], secret]) },
    ]);
  });
});

describe("a remote report (an inbound Flag) through the admin API", () => {
  // A report of alice by a remote moderator on other.example (fileRemoteReports, the Store's handler of a Flag), naming
  // a public and a private status of alice's; another account on that domain follows alice.
  async function remoteWorld() {
    const w = await world();
    const reporter = await remoteAccount(w.h.store, "moderator", "other.example");
    const follower = await remoteAccount(w.h.store, "follower", "other.example");
    await remoteFollows(w.h.store, follower, w.alice.id);
    const open = await seedStatus(w.h.store, {
      accountId: w.alice.id,
      visibility: "public",
      uri: "https://kopje.test/ap/o/open",
    });
    const secret = await seedStatus(w.h.store, {
      accountId: w.alice.id,
      visibility: "private",
      uri: "https://kopje.test/ap/o/secret",
    });
    const filed = await runInDurableObject(w.h.store, (_instance, state) =>
      state.storage.transactionSync(() =>
        fileRemoteReports(
          new Db(state.storage.sql),
          { id: reporter, domain: "other.example" },
          {
            id: "https://other.example/flags/1",
            objects: [
              "https://kopje.test/ap/users/alice",
              "https://kopje.test/ap/o/open",
              "https://kopje.test/ap/o/secret",
            ],
            content: "remote spam",
          },
          NOW,
        ),
      ),
    );
    expect(filed).toEqual({ filed: true, reason: "reported" });
    const id = String((await sql<{ id: number }>(w.h.store, "SELECT id FROM reports"))[0]!.id);
    return { ...w, reporter, follower, open, secret, id };
  }

  it("shows the reporter in the remote AdminAccount shape, and filters by its id", async () => {
    const { h, admin, reporter, alice, id, open, secret } = await remoteWorld();
    const body = await reportOf(h, id, admin);
    expect(body).toMatchObject({ id, category: "other", comment: "remote spam", forwarded: false, rules: [] });
    expect(body.account).toMatchObject({
      id: reporter,
      username: "moderator",
      domain: "other.example",
      email: null,
      confirmed: null,
      role: null,
      account: { id: reporter, acct: "moderator@other.example" },
    });
    expect(body.statuses.map((status) => status.id)).toEqual([open, secret]);
    const listed = await call(h, `/api/v1/admin/reports?account_id=${reporter}`, admin);
    expect((listed.body as { id: string }[]).map((report) => report.id)).toEqual([id]);
    const both = await call(h, `/api/v1/admin/reports?account_id=${reporter}&target_account_id=${alice.id}`, admin);
    expect((both.body as { id: string }[]).map((report) => report.id)).toEqual([id]);
  });

  it("drops a private status from the admin's statuses once no follower is left on the domain; status_ids keeps it", async () => {
    const { h, admin, owner, follower, alice, id, open, secret } = await remoteWorld();
    await sql(h.store, "DELETE FROM follows WHERE account_id = ? AND target_account_id = ?", follower, alice.id);
    expect((await reportOf(h, id, admin)).statuses.map((status) => status.id)).toEqual([open]);
    // The report's status_ids (metadata, the admin's alone, R15/R37) keep both, in v1, v2 and on the stream.
    const v1 = (await call(h, "/api/v1/notifications", owner.token)).body as {
      id: string;
      type: string;
      report?: { id: string; status_ids: string[] };
    }[];
    const notification = v1.find((n) => n.type === "admin.report")!;
    expect(notification.report).toMatchObject({ id, status_ids: [open, secret] });
    const v2 = (await call(h, "/api/v2/notifications", owner.token)).body as {
      notification_groups: { type: string; report?: { id: string; status_ids: string[] } }[];
    };
    expect(v2.notification_groups.find((g) => g.type === "admin.report")?.report).toMatchObject({
      id,
      status_ids: [open, secret],
    });
    await runInDurableObject(h.store, (_instance, state) => {
      const viewer = { accountId: owner.id, now: new Date(NOW).toISOString() };
      expect(
        streamedNotification(new Db(state.storage.sql), viewer, notification.id, { origin: "https://kopje.test" }),
      ).toMatchObject({ type: "admin.report", report: { id, status_ids: [open, secret] } });
    });
  });
});

describe("GET /api/v1/admin/reports: ReportFilter", () => {
  async function filtered() {
    const w = await world();
    const dave = await remoteAccount(w.h.store, "dave");
    const ids = {
      aliceCarol: await fileReport(w.h, w.alice, { account_id: w.carol }),
      bobCarol: await fileReport(w.h, w.bob, { account_id: w.carol }),
      aliceDave: await fileReport(w.h, w.alice, { account_id: dave }),
      bobDave: await fileReport(w.h, w.bob, { account_id: dave }),
      resolvedAliceCarol: await fileReport(w.h, w.alice, { account_id: w.carol }),
    };
    await call(w.h, `/api/v1/admin/reports/${ids.resolvedAliceCarol}/resolve`, w.admin, { method: "POST" });
    const list = async (query: string) => {
      const answer = await call(w.h, `/api/v1/admin/reports${query}`, w.admin);
      expect(answer.status).toBe(200);
      return (answer.body as { id: string }[]).map((report) => report.id);
    };
    return { ...w, dave, ids, list };
  }

  it("lists the unresolved reports by default, newest first", async () => {
    const { ids, list } = await filtered();
    expect(await list("")).toEqual([ids.bobDave, ids.aliceDave, ids.bobCarol, ids.aliceCarol]);
  });

  it('lists the resolved reports for any value of resolved, "false" included', async () => {
    const { ids, list } = await filtered();
    for (const query of ["?resolved=true", "?resolved=false", "?resolved=", "?resolved=0"]) {
      expect(await list(query), query).toEqual([ids.resolvedAliceCarol]);
    }
  });

  it("lists by reporter, by reported account, and by both, in each state", async () => {
    const { alice, bob, carol, dave, ids, list } = await filtered();
    expect(await list(`?account_id=${alice.id}`)).toEqual([ids.aliceDave, ids.aliceCarol]);
    expect(await list(`?account_id=${bob.id}&resolved=1`)).toEqual([]);
    expect(await list(`?target_account_id=${carol}`)).toEqual([ids.bobCarol, ids.aliceCarol]);
    expect(await list(`?target_account_id=${dave}`)).toEqual([ids.bobDave, ids.aliceDave]);
    expect(await list(`?target_account_id=${carol}&account_id=${alice.id}`)).toEqual([ids.aliceCarol]);
    expect(await list(`?target_account_id=${carol}&account_id=${alice.id}&resolved=true`)).toEqual([
      ids.resolvedAliceCarol,
    ]);
    expect(await list(`?account_id=${alice.id}&resolved=true`)).toEqual([ids.resolvedAliceCarol]);
    // Unknown and unpermitted filters (by_target_domain, target_origin) are ignored.
    expect(await list("?account_id=1&by_target_domain=remote.example")).toEqual([]);
    expect(await list("?by_target_domain=nowhere.example&target_origin=local")).toEqual([
      ids.bobDave,
      ids.aliceDave,
      ids.bobCarol,
      ids.aliceCarol,
    ]);
  });

  it("reads one index range per filter, in id order (no sort)", async () => {
    const { h, alice, carol, admin } = await filtered();
    const credential = { tokenHash: await sha256Hex(admin), scope: "admin:read:reports", now: NOW } as const;
    // The plan of the statement each filter reads the reports with, as the operation runs it.
    const planOf = (filter: AdminReportFilter, page: PageQuery) =>
      runInDurableObject(h.store, (_instance, state) => {
        const real = state.storage.sql;
        const plans: string[] = [];
        const capturing = {
          exec: (query: string, ...params: SqlStorageValue[]) => {
            if (/FROM reports INDEXED BY/.test(query)) {
              plans.push(
                real
                  .exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`, ...params)
                  .toArray()
                  .map((row) => row.detail)
                  .join(" | "),
              );
            }
            return real.exec(query, ...params);
          },
        } as unknown as SqlStorage;
        expect(
          listAdminReports.run(capturing, { credential, filter, page, present: { origin: "https://kopje.test" } }),
        ).toMatchObject({ status: "ok" });
        return plans;
      });
    // Each with the reporter's domain read by key (REPORT_COLUMNS).
    const none = { resolved: false, accountId: null, targetAccountId: null };
    expect(await planOf(none, { limit: 5 })).toEqual([
      expect.stringMatching(
        /^SEARCH reports USING INDEX reports_state \(<expr>=\? AND rowid>\? AND rowid<\?\) \| CORRELATED SCALAR SUBQUERY 1 \| SEARCH accounts USING INDEX sqlite_autoindex_accounts_1 \(id=\?\)$/,
      ),
    ]);
    expect(await planOf({ ...none, resolved: true, accountId: alice.id }, { limit: 5, maxId: "5" })).toEqual([
      expect.stringMatching(
        /^SEARCH reports USING INDEX reports_account_state \(account_id=\? AND <expr>=\? AND rowid>\? AND rowid<\?\) \| CORRELATED SCALAR SUBQUERY 1 \| SEARCH accounts USING INDEX sqlite_autoindex_accounts_1 \(id=\?\)$/,
      ),
    ]);
    expect(await planOf({ ...none, targetAccountId: carol, accountId: alice.id }, { limit: 5, minId: "5" })).toEqual([
      expect.stringMatching(
        /^SEARCH reports USING INDEX reports_pair_state \(target_account_id=\? AND account_id=\? AND <expr>=\? AND rowid>\? AND rowid<\?\) \| CORRELATED SCALAR SUBQUERY 1 \| SEARCH accounts USING INDEX sqlite_autoindex_accounts_1 \(id=\?\)$/,
      ),
    ]);
  });

  it("pages by max_id, min_id and since_id with Link headers whose next cursor strictly decreases", async () => {
    const { h, alice, carol, admin } = await world();
    await seedReports(h.store, alice.id, carol, 7);
    const all = ((await call(h, "/api/v1/admin/reports?limit=200", admin)).body as { id: string }[]).map(
      (report) => report.id,
    );
    expect(all).toHaveLength(7);
    const seen: string[] = [];
    let path: string | null = `/api/v1/admin/reports?limit=3&account_id=${alice.id}`;
    let cursor = BigInt("9223372036854775807");
    while (path !== null) {
      const answer = await call(h, path, admin);
      const page = (answer.body as { id: string }[]).map((report) => report.id);
      expect(page.length).toBeGreaterThan(0);
      seen.push(...page);
      const next = /<([^>]+)>; rel="next"/.exec(answer.link ?? "")?.[1] ?? null;
      const prev = /<([^>]+)>; rel="prev"/.exec(answer.link ?? "")?.[1];
      expect(prev).toBe(`https://kopje.test/api/v1/admin/reports?account_id=${alice.id}&limit=3&min_id=${page[0]}`);
      if (next !== null) {
        expect(next).toBe(
          `https://kopje.test/api/v1/admin/reports?account_id=${alice.id}&limit=3&max_id=${page.at(-1)}`,
        );
        const value = BigInt(new URL(next).searchParams.get("max_id")!);
        expect(value < cursor).toBe(true);
        cursor = value;
        path = next.replace("https://kopje.test", "");
      } else {
        path = null;
      }
    }
    expect(seen).toEqual(all);
    // The last page is short: no next. A page past the end is empty, with no Link at all.
    const end = await call(h, `/api/v1/admin/reports?max_id=${all.at(-1)}`, admin);
    expect(end).toMatchObject({ status: 200, body: [], link: null });
    // min_id: the reports just above it, newest first; since_id: the newest above it.
    const above = (await call(h, `/api/v1/admin/reports?min_id=${all[5]}&limit=2`, admin)).body as { id: string }[];
    expect(above.map((report) => report.id)).toEqual([all[3], all[4]]);
    const since = (await call(h, `/api/v1/admin/reports?since_id=${all[5]}&limit=2`, admin)).body as { id: string }[];
    expect(since.map((report) => report.id)).toEqual([all[0], all[1]]);
    // limit: 100 by default, at most 200, its absolute value.
    expect(((await call(h, "/api/v1/admin/reports?limit=-2", admin)).body as unknown[]).length).toBe(2);
  });

  it("stops a page at the status budget after at least one report, and offers the next page", async () => {
    const { h, alice, carol, admin } = await world();
    const named = Array.from({ length: 50 }, (_, i) => String(900000000000000000n + BigInt(i)));
    await seedReports(h.store, alice.id, carol, 2 + ADMIN_REPORT_STATUS_BUDGET / 50, { statuses: named });
    const first = await call(h, "/api/v1/admin/reports?limit=10", admin);
    const page = first.body as AdminReportBody[];
    expect(page).toHaveLength(ADMIN_REPORT_STATUS_BUDGET / 50);
    const next = /<([^>]+)>; rel="next"/.exec(first.link ?? "")?.[1];
    expect(next).toBe(`https://kopje.test/api/v1/admin/reports?limit=10&max_id=${page.at(-1)?.id}`);
    const rest = await call(h, next!.replace("https://kopje.test", ""), admin);
    expect((rest.body as unknown[]).length).toBe(2);
    expect(rest.link).not.toMatch(/rel="next"/);
    // A report naming the budget's statuses (the most a report holds, 0054_remote_reports' CHECK) is a page alone.
    await sql(h.store, "DELETE FROM reports");
    await seedReports(h.store, alice.id, carol, 2, {
      statuses: Array.from({ length: ADMIN_REPORT_STATUS_BUDGET }, (_, i) => String(i)),
    });
    const single = await call(h, "/api/v1/admin/reports", admin);
    expect((single.body as unknown[]).length).toBe(1);
    expect(single.link).toMatch(/rel="next"/);
  });
});

describe("admin report actions", () => {
  it("resolve, reopen, assign and unassign, each logged in its transaction", async () => {
    const { h, owner, alice, carol, admin } = await world();
    const id = await fileReport(h, alice, { account_id: carol });
    const later = NOW + 60_000;
    h.now.mockReturnValue(later);
    const act = async (action: string) =>
      (await call(h, `/api/v1/admin/reports/${id}/${action}`, admin, { method: "POST" })).body as AdminReportBody;

    const resolved = await act("resolve");
    expect(resolved).toMatchObject({
      action_taken: true,
      action_taken_at: new Date(later).toISOString(),
      updated_at: new Date(later).toISOString(),
      action_taken_by_account: { id: owner.id },
    });
    // The reporter's own Report entity shows it resolved.
    expect(await reporterReport(h.store, id)).toMatchObject({
      action_taken: true,
      action_taken_at: new Date(later).toISOString(),
    });
    expect(await act("assign_to_self")).toMatchObject({ assigned_account: { id: owner.id }, action_taken: true });
    expect(await act("unassign")).toMatchObject({ assigned_account: null });
    expect(await act("reopen")).toMatchObject({
      action_taken: false,
      action_taken_at: null,
      action_taken_by_account: null,
    });
    expect(await reporterReport(h.store, id)).toMatchObject({ action_taken: false, action_taken_at: null });
    // Unchanged by an action that changes nothing (Rails saves only a changed record), logged all the same.
    h.now.mockReturnValue(later + 60_000);
    expect(await act("reopen")).toMatchObject({ updated_at: new Date(later).toISOString() });
    expect(await logRows(h.store)).toEqual(
      ["resolve", "assigned_to_self", "unassigned", "reopen", "reopen"].map((action) => ({
        actor: "oauth",
        account_id: owner.id,
        action,
        target_type: "Report",
        target_id: id,
      })),
    );
  });

  it("updates category and rule_ids with Report's validations and Rails' messages", async () => {
    const { h, alice, carol, admin } = await world();
    const id = await fileReport(h, alice, { account_id: carol, category: "spam" });
    const update = (body: Record<string, unknown>, method = "PUT") =>
      call(h, `/api/v1/admin/reports/${id}`, admin, json(body, { method }));
    const invalid = (error: string) => ({ status: 422, body: { error: `Validation failed: ${error}` } });

    expect(await update({ category: "legal" })).toMatchObject({ status: 200, body: { category: "legal" } });
    expect(await update({ category: "violation", rule_ids: ["1", "2"] }, "PATCH")).toMatchObject({
      status: 200,
      body: { category: "violation", rules: [{ id: "1" }, { id: "2" }] },
    });
    expect(await sql(h.store, "SELECT category, rule_ids FROM reports")).toEqual([
      { category: "violation", rule_ids: '["1","2"]' },
    ]);
    // A violation names rules that all exist, each once.
    expect(await update({ rule_ids: ["3"] })).toMatchObject(invalid("Rule ids does not reference valid rules"));
    expect(await update({ rule_ids: ["1", "1"] })).toMatchObject(invalid("Rule ids does not reference valid rules"));
    // Another category names none: leaving the rules is refused, clearing them passes.
    expect(await update({ category: "other" })).toMatchObject(invalid("Rule ids must be blank"));
    expect(await update({ category: "other", rule_ids: [] })).toMatchObject({
      status: 200,
      body: { category: "other", rules: [] },
    });
    // A category outside the enum, or blank.
    expect(await update({ category: "nonsense" })).toMatchObject(invalid("Category is not included in the list"));
    expect(await update({ category: "" })).toMatchObject(invalid("Category is not included in the list"));
    // Form parameters, as Fedilab and Rails clients send them.
    const formed = await h.request(
      `/api/v1/admin/reports/${id}`,
      bearer(admin, {
        method: "PUT",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "category=violation&rule_ids[]=2",
      }),
    );
    expect(await formed.json()).toMatchObject({ category: "violation", rules: [{ id: "2" }] });
    // Refused updates write nothing and log nothing; the four accepted ones are logged.
    expect(await sql(h.store, "SELECT category, rule_ids FROM reports")).toEqual([
      { category: "violation", rule_ids: '["2"]' },
    ]);
    expect((await logRows(h.store)).map((row) => row.action)).toEqual(["update", "update", "update", "update"]);
  });
});

// The reporter's Report entity (REST::ReportSerializer) of a stored report.
async function reporterReport(store: StoreStub, id: string) {
  return runInDurableObject(store, (_instance, state) => {
    const row = new Db(state.storage.sql).first<ReportRow>(`SELECT ${REPORT_COLUMNS} FROM reports WHERE id = ?`, id)!;
    return userReport(row, {} as Parameters<typeof userReport>[1]);
  });
}

describe("the moderation log", () => {
  let team: AccessTeam;

  beforeEach(async () => {
    team = await adminTeam();
  });

  it(`keeps the newest ${MODERATION_LOG_KEEP} rows, deleting at most ${MODERATION_LOG_PRUNE} per insert`, async () => {
    const store = await migratedStore();
    const actor = { ...ACCESS };
    await runInDurableObject(store, (_instance, state) => {
      state.storage.sql.exec(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
				INSERT INTO admin_actions (id, actor, action, target_type, target_id, created_at)
				SELECT i, 'access', 'probe', 'Report', CAST(i AS TEXT), '2026-10-01T00:00:00.000Z' FROM n`,
        MODERATION_LOG_KEEP + 25,
      );
    });
    const insert = () =>
      runInDurableObject(store, (_instance, state) => {
        const db = new Db(state.storage.sql);
        const before = db.first<{ n: number }>("SELECT total_changes() AS n")!.n;
        logAction(db, actor, "change_email", { type: "Account", id: "1" }, {}, NOW);
        return db.first<{ n: number }>("SELECT total_changes() AS n")!.n - before;
      });
    const count = async () => (await sql<{ n: number }>(store, "SELECT count(*) AS n FROM admin_actions"))[0]!.n;
    expect(await insert()).toBe(1 + MODERATION_LOG_PRUNE);
    expect(await count()).toBe(MODERATION_LOG_KEEP + 25 + 1 - MODERATION_LOG_PRUNE);
    expect(await insert()).toBe(1 + MODERATION_LOG_PRUNE);
    expect(await insert()).toBe(1 + 8);
    expect(await count()).toBe(MODERATION_LOG_KEEP);
    expect(await insert()).toBe(2);
    expect(await count()).toBe(MODERATION_LOG_KEEP);
    const [oldest] = await sql<{ id: number }>(store, "SELECT min(id) AS id FROM admin_actions");
    expect(oldest!.id).toBe(MODERATION_LOG_KEEP + 25 + 4 - MODERATION_LOG_KEEP + 1);
  });

  it("is read through Access only, newest first, in pages", async () => {
    const { h, alice, carol, admin } = await world();
    const id = await fileReport(h, alice, { account_id: carol });
    await call(h, `/api/v1/admin/reports/${id}/resolve`, admin, { method: "POST" });
    await call(h, `/api/v1/admin/reports/${id}/reopen`, admin, { method: "POST" });
    await setTeamAccess(h.store, team);
    const { as, request } = adminHarness(h.store, team, {
      IMPORT_TOKEN: "import-token-0123456789abcdef0123456789",
    });
    const first = await (
      await as(adminClaims(), "/admin/moderation-log?limit=1")
    ).json<{
      entries: { id: string; action: string; actor: string; target_id: string; client_id: string | null }[];
      next: string | null;
    }>();
    expect(first.entries).toMatchObject([{ actor: "oauth", action: "reopen", target_id: id }]);
    expect(first.entries[0]!.client_id).not.toBeNull();
    const second = await (
      await as(adminClaims(), `/admin/moderation-log?before=${first.next}`)
    ).json<{
      entries: { action: string }[];
      next: string | null;
    }>();
    expect(second).toMatchObject({ entries: [{ action: "resolve" }], next: null });
    // The import token reads only health, version, catalog and config; nothing else reaches the log.
    const refused = await request("/admin/moderation-log", {
      headers: { "Kopje-Import-Token": "import-token-0123456789abcdef0123456789" },
    });
    expect(refused.status).toBe(403);
    expect((await request("/admin/moderation-log")).status).toBe(401);
  });
});

describe("POST /admin/accounts/email (set-email)", () => {
  let team: AccessTeam;

  beforeEach(async () => {
    team = await adminTeam();
  });

  async function setup() {
    const store = await migratedStore();
    await setTeamAccess(store, team);
    const admin = await seedAccount(store, { username: "admin", email: "old@example.com" });
    await seedAccount(store, { username: "alice", email: "Alice@Example.com" });
    const { as, request } = adminHarness(store, team, { IMPORT_TOKEN: "import-token-0123456789abcdef0123456789" });
    const setEmail = async (body: Record<string, unknown>) => {
      const response = await as(adminClaims(), "/admin/accounts/email", json(body));
      return { status: response.status, body: await response.json<Record<string, unknown>>() };
    };
    return { store, admin, as, request, setEmail };
  }

  it("repairs the OAuth admin by setting its email, logged with the Access identity", async () => {
    const { store, admin, as, setEmail } = await setup();
    const health = async () =>
      (await (await as(adminClaims(), "/admin/health")).json<{ oauthAdmin: unknown }>()).oauthAdmin;
    expect(await health()).toEqual({ status: "none", username: null });
    expect(await setEmail({ username: "@admin", email: ` ${ADMIN_EMAIL} ` })).toEqual({
      status: 200,
      body: { username: "admin", email: ADMIN_EMAIL },
    });
    expect(await health()).toEqual({ status: "ok", username: "admin" });
    expect(
      await sql(
        store,
        "SELECT actor, account_id, client_id, action, target_type, target_id, detail FROM admin_actions",
      ),
    ).toEqual([
      {
        actor: "access",
        account_id: null,
        client_id: null,
        action: "change_email",
        target_type: "Account",
        target_id: admin,
        detail: JSON.stringify({ username: "admin", identity: ADMIN_EMAIL }),
      },
    ]);
  });

  it("refuses an email another local account has in ASCII case, a bad email and an unknown account", async () => {
    const { store, setEmail } = await setup();
    expect(await setEmail({ username: "admin", email: " alice@EXAMPLE.com" })).toMatchObject({
      status: 409,
      body: { code: "email-taken" },
    });
    expect(await setEmail({ username: "admin", email: "not an email" })).toMatchObject({
      status: 400,
      body: { code: "invalid-email" },
    });
    expect(await setEmail({ username: "nobody", email: "n@example.com" })).toMatchObject({
      status: 404,
      body: { code: "account-not-found" },
    });
    expect(await setEmail({ username: "admin" })).toMatchObject({ status: 400 });
    // Its own email again, in another case, is not a collision.
    expect(await setEmail({ username: "alice", email: "alice@example.com" })).toMatchObject({ status: 200 });
    expect(await sql(store, "SELECT action FROM admin_actions")).toEqual([{ action: "change_email" }]);
    expect(await sql(store, "SELECT email FROM local_accounts ORDER BY email")).toEqual([
      { email: "alice@example.com" },
      { email: "old@example.com" },
    ]);
  });

  // AUTH-9's rule (login-email.ts loginEmailMatchSql), as the OAuth admin's match and the sign-in read the emails.
  it("refuses an email another local account has by the sign-in’s rule: ASCII case only, with no trim", async () => {
    const { store, setEmail } = await setup();
    await seedAccount(store, { username: "kim", email: "kim@example.com" });
    await seedAccount(store, { username: "strasse", email: "straße@example.com" });
    await seedAccount(store, { username: "iris", email: "i\u0307ris@example.com" });
    // An imported email with surrounding whitespace, which no sign-in of pad@example.com reaches.
    await seedAccount(store, { username: "pad", email: " pad@example.com" });
    expect(await setEmail({ username: "admin", email: "KIM@example.com" })).toMatchObject({
      status: 409,
      body: { code: "email-taken" },
    });
    // The Kelvin sign U+212A, the capital sharp s U+1E9E and the dotted capital I U+0130 are other emails, and so is
    // one without the stored whitespace; the input itself is trimmed.
    for (const email of [
      "\u212Aim@example.com",
      "STRA\u1E9EE@example.com",
      "\u0130RIS@example.com",
      " pad@example.com",
    ]) {
      expect(await setEmail({ username: "admin", email }), email).toEqual({
        status: 200,
        body: { username: "admin", email: email.trim() },
      });
    }
    expect(
      await sql(
        store,
        "SELECT email FROM local_accounts l JOIN accounts a ON a.id = l.account_id WHERE a.username = 'admin'",
      ),
    ).toEqual([{ email: "pad@example.com" }]);
    expect(await sql(store, "SELECT count(*) AS n FROM admin_actions")).toEqual([{ n: 4 }]);
  });

  it("reaches the Store through Access only: the import token is refused, and so is any other authority", async () => {
    const { store, request } = await setup();
    const refused = await request(
      "/admin/accounts/email",
      json(
        { username: "admin", email: ADMIN_EMAIL },
        { headers: { "Kopje-Import-Token": "import-token-0123456789abcdef0123456789" } },
      ),
    );
    expect(refused.status).toBe(403);
    for (const authority of [{ kind: "import-token" } as const, { ...ACCESS, email: "intruder@example.com" }]) {
      expect(
        await runInDurableObject(store, (_instance, state) =>
          setAccountEmail.run(state.storage.sql, { authority, username: "admin", email: ADMIN_EMAIL, now: NOW }),
        ),
      ).toMatchObject({ ok: false, code: "wrong-authority" });
    }
    expect(await sql(store, "SELECT * FROM admin_actions")).toEqual([]);
    expect(await sql(store, "SELECT email FROM local_accounts WHERE email = ?", ADMIN_EMAIL)).toEqual([]);
  });
});

describe("report answers within ANSWER_BYTES (RES-3)", () => {
  it("embed a first status past the allowance alone, on the list, the report and an action, and cut a page at a report", async () => {
    const w = await world();
    const huge = await hugeStatus(w.h, w.carol, NOW - 3_600_000);
    const small = await seedStatus(w.h.store, { accountId: w.carol, visibility: "public" });
    await seedReports(w.h.store, w.alice.id, w.carol, 5, { statuses: [small, huge] });
    const reports = (
      await sql<{ id: string }>(w.h.store, "SELECT CAST(id AS TEXT) AS id FROM reports ORDER BY id DESC")
    ).map((row) => row.id);
    // Newest first: each page is cut at a report, `more` linking the next; every report once.
    const walked: string[] = [];
    for (let at: string | null = "/api/v1/admin/reports?limit=10"; at !== null;) {
      const page: Answer<AdminReportBody[]> = await answer<AdminReportBody[]>(w.h, at, w.admin);
      expect(page.bytes).toBeLessThanOrEqual(ANSWER_BYTES);
      expect(page.body.length).toBeLessThan(5);
      for (const report of page.body) {
        // The first status, past REPORT_STATUS_BYTES alone, is the one shown.
        expect(report.statuses.map((status) => status.id)).toEqual([huge]);
      }
      walked.push(...page.body.map((report) => report.id));
      at = page.next;
    }
    expect(walked).toEqual(reports);
    const ascending: string[] = [];
    for (let at: string | null = "/api/v1/admin/reports?limit=10&min_id=0"; at !== null;) {
      const page: Answer<AdminReportBody[]> = await answer<AdminReportBody[]>(w.h, at, w.admin);
      expect(page.bytes).toBeLessThanOrEqual(ANSWER_BYTES);
      ascending.push(...page.body.map((report) => report.id).toReversed());
      at = page.body.length === 0 ? null : page.prev;
    }
    expect(ascending).toEqual(reports.toReversed());
    const one = await answer<AdminReportBody>(w.h, `/api/v1/admin/reports/${reports[0]!}`, w.admin);
    expect(one.body.statuses.map((status) => status.id)).toEqual([huge]);
    expect(one.bytes).toBeGreaterThan(REPORT_STATUS_BYTES);
    const acted = await call(w.h, `/api/v1/admin/reports/${reports[0]!}/assign_to_self`, w.admin, { method: "POST" });
    expect((acted.body as AdminReportBody).statuses.map((status) => status.id)).toEqual([huge]);
    // A small first status leaves room: the statuses within the allowance follow it.
    await seedReports(w.h.store, w.alice.id, w.carol, 1, { statuses: [small, ...w.statuses] });
    const [last] = await sql<{ id: string }>(w.h.store, "SELECT CAST(max(id) AS TEXT) AS id FROM reports");
    const smallOnes = await reportOf(w.h, last!.id, w.admin);
    expect(smallOnes.statuses.map((status) => status.id).toSorted()).toEqual([small, ...w.statuses].toSorted());
    // A first status that uses up the allowance stops the report's statuses: the next one is not read.
    const credential = { tokenHash: await sha256Hex(w.admin), scope: "admin:read:reports", now: NOW };
    const read = await runInDurableObject(w.h.store, (_instance, state) => {
      const ids: unknown[] = [];
      const counting = observedSql(state.storage.sql, (rows) => {
        for (const row of rows) {
          if ("content" in row) {
            ids.push(row.id);
          }
        }
      });
      getAdminReport.run(counting, { credential, id: reports[0]!, present: { origin: ORIGIN } } as never);
      return ids;
    });
    expect(read).toContain(huge);
    expect(read).not.toContain(small);
  }, 300_000);

  it("find the first status a report presents one at a time, and stop when it uses up the allowance", async () => {
    const w = await world();
    // Carol's boost of her own private status, which alice (who follows her) may see and the admin may not, then a
    // status past the allowance, then a small one: the boost presents nothing to the admin, so the large status is
    // the report's first, and the small one is never read.
    await sql(
      w.h.store,
      "INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, 'accepted')",
      w.alice.id,
      w.carol,
    );
    const own = await seedStatus(w.h.store, { accountId: w.carol, visibility: "private", published: NOW - 9_000_000 });
    const boost = await seedStatus(w.h.store, {
      accountId: w.carol,
      visibility: "private",
      reblogOfId: own,
      published: NOW - 8_000_000,
    });
    const huge = await hugeStatus(w.h, w.carol, NOW - 3_600_000);
    const small = await seedStatus(w.h.store, { accountId: w.carol, visibility: "public" });
    await seedReports(w.h.store, w.alice.id, w.carol, 1, { statuses: [boost, huge, small] });
    const [report] = await sql<{ id: string }>(w.h.store, "SELECT CAST(max(id) AS TEXT) AS id FROM reports");
    const id = report!.id;
    const tokenHash = await sha256Hex(w.admin);
    const present = { origin: ORIGIN };
    const filter = { resolved: false, accountId: null, targetAccountId: null };
    const reads = [
      [
        listAdminReports,
        { credential: { tokenHash, scope: "admin:read:reports", now: NOW }, filter, page: { limit: 10 }, present },
      ],
      [getAdminReport, { credential: { tokenHash, scope: "admin:read:reports", now: NOW }, id, present }],
      [
        actOnReport,
        { credential: { tokenHash, scope: "admin:write:reports", now: NOW }, id, action: "assign_to_self", present },
      ],
    ] as const;
    for (const [operation, input] of reads) {
      const read = await runInDurableObject(w.h.store, (_instance, state) => {
        const ids: unknown[] = [];
        const counting = observedSql(state.storage.sql, (rows) => {
          for (const row of rows) {
            if ("content" in row) {
              ids.push(row.id);
            }
          }
        });
        let output = operation.run(counting, input as never) as unknown as Record<string, unknown>;
        while (output.status === "ok" && "value" in output) {
          output = output.value as Record<string, unknown>;
        }
        return { ids, output: JSON.stringify(output) };
      });
      expect(read.ids).toContain(huge);
      expect(read.ids).not.toContain(small);
      const shown = JSON.parse(read.output) as { items?: AdminReportBody[]; report?: AdminReportBody };
      const body = shown.report ?? shown.items!.find((item) => item.id === id)!;
      expect(body.statuses.map((status) => status.id)).toEqual([huge]);
    }
  }, 300_000);

  it("keep a list page's filter text within MAX_FILTER_REQUEST_TEXT, shared by its reports", async () => {
    const w = await world();
    // The admin filters "needle", which each status holds at its 9,000th character. Fifty statuses of 10,000
    // characters share the page's allowance, so each is matched up to the level it gives, before the needle; one
    // report read alone is matched whole.
    const filter = await w.h.request("/api/v2/filters", {
      method: "POST",
      headers: { authorization: `Bearer ${w.admin}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "n", context: ["home"], keywords_attributes: [{ keyword: "needle" }] }),
    });
    expect(filter.status).toBe(200);
    const status = await seedStatus(w.h.store, {
      accountId: w.carol,
      visibility: "public",
      content: `<p>${"a ".repeat(4_500)}needle ${"a ".repeat(490)}</p>`,
    });
    await seedReports(w.h.store, w.alice.id, w.carol, 50, { statuses: [status] });
    const [level] = filterTextLimits(Array.from({ length: 50 }, () => MAX_FILTER_TEXT));
    expect(50 * level!).toBeLessThanOrEqual(MAX_FILTER_REQUEST_TEXT);
    expect(level).toBeLessThan(9_000);
    const list = await answer<AdminReportBody[]>(w.h, "/api/v1/admin/reports?limit=100", w.admin);
    expect(list.body).toHaveLength(50);
    const matched = (report: AdminReportBody) =>
      (report.statuses[0] as unknown as { filtered?: unknown[] }).filtered?.length ?? 0;
    expect(list.body.map(matched)).toEqual(list.body.map(() => 0));
    expect(matched(await reportOf(w.h, list.body[0]!.id, w.admin))).toBe(1);
  }, 300_000);
});
