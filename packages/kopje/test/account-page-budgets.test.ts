import { describe, expect, it } from "vitest";

import { ANSWER_BYTES } from "../src/domain/answer-budget";
import { login, registerApp, setSetting, sql } from "./api-helpers";
import { answer, expectByteCutFirstPage, expectByteCutWalk, maximalAccounts, walk } from "./budget-helpers";
import { community, seedStatus, type User } from "./status-helpers";

// RES-3: the remaining pages of accounts are answers within ANSWER_BYTES. Edge-cursor pages (blocks, mutes) and the
// admin's account list continue from their last admitted account; the directory, an offset endpoint, answers fewer
// accounts, and a client that advances its offset by the number received continues after them.

// 80 accounts at their bounds (about 121 KB each): about 70 fit one answer.
const COUNT = 80;

describe("pages of accounts within ANSWER_BYTES (RES-3)", () => {
  it("walk every edge-cursor family once in each direction, cut by bytes", async () => {
    const h = await community(["alice", "bob", "carol"]);
    const { alice, bob, carol } = h.users;
    const ids = await maximalAccounts(h, "edge", COUNT);
    const status = await seedStatus(h.store, { accountId: alice.id, visibility: "public" });
    const list = "900000000000000001";
    await sql(h.store, "INSERT INTO lists (id, account_id, title) VALUES (?, ?, 'edge')", list, alice.id);
    for (const id of ids) {
      const each = [
        ["INSERT INTO follows (account_id, target_account_id, state) VALUES (?1, ?2, 'accepted')", id, alice.id],
        ["INSERT INTO follows (account_id, target_account_id, state) VALUES (?1, ?2, 'accepted')", alice.id, id],
        ["INSERT INTO follows (account_id, target_account_id, state) VALUES (?1, ?2, 'pending')", id, bob.id],
        ["INSERT INTO favourites (account_id, status_id) VALUES (?1, ?2)", id, status],
        ["INSERT INTO list_accounts (list_id, account_id) VALUES (?1, ?2)", list, id],
        ["INSERT INTO account_pins (account_id, target_account_id) VALUES (?1, ?2)", alice.id, id],
        ["INSERT INTO blocks (account_id, target_account_id) VALUES (?1, ?2)", carol.id, id],
        ["INSERT INTO mutes (account_id, target_account_id) VALUES (?1, ?2)", carol.id, id],
        [
          `INSERT INTO notifications (account_id, type, from_account_id, status_id, created_at, group_key)
					VALUES (?1, 'favourite', ?2, ?3, '2026-01-01T00:00:00.000Z', 'favourite-edge-1')`,
          alice.id,
          id,
          status,
        ],
      ] as const;
      for (const [query, ...params] of each) {
        await sql(h.store, query, ...params);
      }
      await seedStatus(h.store, { accountId: id, visibility: "public", reblogOfId: status });
    }
    // Each family's cursor of each account.
    const cursors = async (query: string, ...params: string[]) =>
      new Map(
        (await sql<{ id: string; cursor: string }>(h.store, query, ...params)).map((row) => [row.id, row.cursor]),
      );
    const follows = (column: string, other: string, owner: string) =>
      cursors(`SELECT ${column} AS id, CAST(id AS TEXT) AS cursor FROM follows WHERE ${other} = ?`, owner);
    const byId = new Map(ids.map((id) => [id, id]));
    const families: [string, string, User, Map<string, string>, boolean][] = [
      [
        "followers",
        `/api/v1/accounts/${alice.id}/followers`,
        alice,
        await follows("account_id", "target_account_id", alice.id),
        true,
      ],
      [
        "following",
        `/api/v1/accounts/${alice.id}/following`,
        alice,
        await follows("target_account_id", "account_id", alice.id),
        true,
      ],
      [
        "follow requests",
        "/api/v1/follow_requests",
        bob,
        await follows("account_id", "target_account_id", bob.id),
        true,
      ],
      [
        "favourited_by",
        `/api/v1/statuses/${status}/favourited_by`,
        alice,
        await cursors(
          "SELECT account_id AS id, CAST(id AS TEXT) AS cursor FROM favourites WHERE status_id = ?",
          status,
        ),
        true,
      ],
      [
        "reblogged_by",
        `/api/v1/statuses/${status}/reblogged_by`,
        alice,
        await cursors("SELECT account_id AS id, id AS cursor FROM statuses WHERE reblog_of_id = ?", status),
        true,
      ],
      ["list members", `/api/v1/lists/${list}/accounts`, alice, byId, true],
      ["endorsements", "/api/v1/endorsements", alice, byId, true],
      [
        "blocks",
        "/api/v1/blocks",
        carol,
        await cursors(
          "SELECT target_account_id AS id, CAST(id AS TEXT) AS cursor FROM blocks WHERE account_id = ?",
          carol.id,
        ),
        true,
      ],
      [
        "mutes",
        "/api/v1/mutes",
        carol,
        await cursors(
          "SELECT target_account_id AS id, CAST(id AS TEXT) AS cursor FROM mutes WHERE account_id = ?",
          carol.id,
        ),
        true,
      ],
      [
        "group accounts",
        "/api/v2/notifications/favourite-edge-1/accounts",
        alice,
        await cursors(
          "SELECT from_account_id AS id, CAST(id AS TEXT) AS cursor FROM notifications WHERE account_id = ?",
          alice.id,
        ),
        // Notifications::AccountsController reads no min_id.
        false,
      ],
    ];
    const size = (await answer<unknown>(h, `/api/v1/accounts/${ids[0]!}`, alice.token)).bytes;
    for (const [name, path, owner, cursor, ascending] of families) {
      const order = ids.toSorted((a, b) => (BigInt(cursor.get(a)!) < BigInt(cursor.get(b)!) ? 1 : -1));
      const cursorOf = (id: string) => cursor.get(id)!;
      const page = `${path}?limit=80`;
      expectByteCutWalk(name, await walk(h, page, "next", owner.token), order, "next", size, cursorOf);
      if (ascending) {
        const up = await walk(h, `${page}&min_id=0`, "prev", owner.token);
        expectByteCutWalk(name, up, order.toReversed(), "prev", size, cursorOf);
      }
      // since_id, and both bounds: a cut first page is a prefix of the uncut answer, its link in Mastodon's form.
      const [newest, oldest] = [cursorOf(order[0]!), cursorOf(order.at(-1)!)];
      const inner = order.slice(1, -1);
      const token = owner.token;
      await expectByteCutFirstPage(
        h,
        name,
        `${page}&since_id=${oldest}`,
        "next",
        token,
        order.slice(0, -1),
        size,
        cursorOf,
      );
      const down = `${page}&max_id=${newest}&since_id=${oldest}`;
      await expectByteCutFirstPage(h, `${name} between`, down, "next", token, inner, size, cursorOf);
      if (ascending) {
        const up = `${page}&min_id=${oldest}&max_id=${newest}`;
        await expectByteCutFirstPage(h, `${name} between`, up, "prev", token, inner.toReversed(), size, cursorOf);
      }
    }
    const [muted] = (await answer<{ mute_expires_at: unknown }[]>(h, "/api/v1/mutes?limit=1", carol.token)).body;
    expect(muted).toHaveProperty("mute_expires_at", null);
  }, 600_000);

  it("answers the directory with fewer accounts, its offset continuing after them", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const ids = await maximalAccounts(h, "listed", COUNT);
    await sql(
      h.store,
      "UPDATE accounts SET discoverable = 1 WHERE id IN (SELECT value FROM json_each(?))",
      JSON.stringify(ids),
    );
    const first = await answer<{ id: string }[]>(h, "/api/v1/directory?order=new&limit=80&local=false", alice.token);
    expect(first.bytes).toBeLessThanOrEqual(ANSWER_BYTES);
    // More accounts match than the answer holds. A client that advances by the number received (Tusky, Ivory)
    // continues after them; Mastodon's web client takes the short answer for the last (docs/response-inventory.md).
    expect(first.body.length).toBeLessThan(COUNT);
    const rest = await answer<{ id: string }[]>(
      h,
      `/api/v1/directory?order=new&limit=80&local=false&offset=${first.body.length}`,
      alice.token,
    );
    expect([...first.body, ...rest.body].map((account) => account.id)).toEqual(ids.toReversed());
  }, 300_000);

  it("walks the admin account list once each, cut by bytes, `more` linking the next page", async () => {
    const h = await community(["owner"]);
    await setSetting(h.store, "admin_email", "owner@example.com");
    const scope = "read write admin:read admin:write";
    const token = (await login(h, { app: await registerApp(h, { scopes: scope }), scope, email: "owner@example.com" }))
      .token;
    const ids = await maximalAccounts(h, "admin", COUNT);
    const size = (await answer<unknown>(h, `/api/v1/admin/accounts/${ids[0]!}`, token)).bytes;
    const path = "/api/v2/admin/accounts?origin=remote&limit=200";
    expectByteCutWalk("admin", await walk(h, path, "next", token), ids.toReversed(), "next", size);
    const up = await walk(h, `${path}&min_id=0`, "prev", token);
    expectByteCutWalk("admin", up, ids, "prev", size);
  }, 300_000);
});
