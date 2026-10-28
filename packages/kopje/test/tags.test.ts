import { describe, expect, it } from "vitest";

import { getTag, tagId } from "../src/domain/tags";
import { type ApiHarness, apiHarness, bearer, seedAccount, sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { appToken, DAY_MS, plannedRun, rowsRead, scansOf, scopedToken, staleStatistics } from "./read-helpers";
import { community, getJson, seedStatus, type User } from "./status-helpers";

// GET /api/v1/tags/:id: the Tag entity, its history (VIS-12), the optional token (AUTH-2) and the work bound (RES-7).

type Tag = {
  id: string;
  name: string;
  url: string;
  history: { day: string; uses: string; accounts: string }[];
  following?: boolean;
  featuring?: boolean;
};

describe("tag ids", () => {
  it("derives the id from the normalized name: FNV-1a 64 cut to 63 bits, in decimal", () => {
    // FNV-1a 64 of "foobar" is 0x85944171f73967e8 (the published test vector); its low 63 bits are this.
    expect(tagId("foobar")).toBe("402018224477661160");
    expect(tagId("")).toBe("5472609002491880229");
    expect(tagId("cats")).toBe("3848435355615332284");
    expect(tagId("日本語")).toMatch(/^[1-9]\d{0,18}$/);
    expect(tagId("cat")).not.toBe(tagId("cats"));
  });

  it("gives every endpoint that answers a full Tag the same id for the same hashtag", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const auth = (method = "GET") => bearer(alice.token, { method });
    const ids: string[] = [];
    const tag = async (path: string, method = "GET") => {
      const response = await h.request(path, auth(method));
      expect(response.status, path).toBe(200);
      return await response.json<Tag | Tag[] | { hashtags: Tag[] }>();
    };
    await h.request(
      "/api/v1/statuses",
      bearer(alice.token, { method: "POST", body: new URLSearchParams({ status: "#Cats" }) }),
    );
    ids.push(((await tag("/api/v1/tags/Cats")) as Tag).id);
    ids.push(((await tag("/api/v1/tags/cats/follow", "POST")) as Tag).id);
    ids.push(((await tag("/api/v1/followed_tags")) as Tag[])[0]?.id ?? "");
    ids.push(((await tag("/api/v2/search?q=%23cats&type=hashtags")) as { hashtags: Tag[] }).hashtags[0]?.id ?? "");
    ids.push(((await tag("/api/v1/featured_tags/suggestions")) as Tag[])[0]?.id ?? "");
    ids.push(((await tag("/api/v1/tags/cats/feature", "POST")) as Tag).id);
    ids.push(((await tag("/api/v1/tags/cats/unfeature", "POST")) as Tag).id);
    ids.push(((await tag("/api/v1/tags/cats/unfollow", "POST")) as Tag).id);
    ids.push((await (await h.request("/api/v1/tags/cats")).json<Tag>()).id);
    expect(ids).toEqual(Array.from({ length: 9 }, () => "3848435355615332284"));
  });
});

describe("tags", () => {
  const day = (daysAgo: number) => String((NOW - daysAgo * DAY_MS) / 1000);

  it("shows a tag with seven days of history, today first", async () => {
    const h = await community(["alice", "bob"]);
    const { alice, bob } = h.users;
    const remote = await seedAccount(h.store, { username: "carol", domain: "remote.example" });
    const at = (daysAgo: number) => NOW - daysAgo * DAY_MS + 3_600_000;
    for (const [accountId, daysAgo, visibility] of [
      [alice.id, 0, "public"],
      [alice.id, 0, "public"],
      [bob.id, 0, "public"],
      [remote, 2, "public"],
      [remote, 6, "public"],
      // Outside the window, unlisted, or hidden from someone: never counted.
      [remote, 7, "public"],
      [bob.id, 0, "unlisted"],
      [alice.id, 1, "private"],
      [alice.id, 1, "direct"],
      [remote, 1, "limited"],
    ] as const) {
      await seedStatus(h.store, { accountId, visibility, tags: ["cats"], published: at(daysAgo) });
    }
    const original = await seedStatus(h.store, { accountId: bob.id, visibility: "public", published: at(3) });
    await seedStatus(h.store, { accountId: alice.id, visibility: "public", reblogOfId: original, tags: ["cats"] });

    const { status, body } = await getJson<Tag>(h, "/api/v1/tags/Cats");
    expect(status).toBe(200);
    expect(body).toEqual({
      id: "3848435355615332284",
      name: "cats",
      url: "https://kopje.test/tags/cats",
      history: [
        { day: day(0), uses: "3", accounts: "2" },
        { day: day(1), uses: "0", accounts: "0" },
        { day: day(2), uses: "1", accounts: "1" },
        { day: day(3), uses: "0", accounts: "0" },
        { day: day(4), uses: "0", accounts: "0" },
        { day: day(5), uses: "0", accounts: "0" },
        { day: day(6), uses: "1", accounts: "1" },
      ],
    });
    // The same for a signed-in viewer, who neither follows nor features it.
    expect((await getJson<Tag>(h, "/api/v1/tags/cats", alice.token)).body).toEqual({
      ...body,
      following: false,
      featuring: false,
    });
  });

  it("counts public statuses only: a tag used only unlisted has no history", async () => {
    const h = await community(["alice"]);
    await seedStatus(h.store, { accountId: h.users.alice.id, visibility: "unlisted", tags: ["cats"] });
    const { body } = await getJson<Tag>(h, "/api/v1/tags/cats");
    expect(body.history.every((entry) => entry.uses === "0" && entry.accounts === "0")).toBe(true);
  });

  it("leaves out the statuses of a suspended account (VIS-12)", async () => {
    const h = await community(["alice"]);
    await seedStatus(h.store, { accountId: h.users.alice.id, visibility: "public", tags: ["cats"] });
    await sql(
      h.store,
      "UPDATE local_accounts SET suspended_at = ? WHERE account_id = ?",
      "2026-01-01",
      h.users.alice.id,
    );
    const { body } = await getJson<Tag>(h, "/api/v1/tags/cats");
    expect(body.history[0]).toEqual({ day: day(0), uses: "0", accounts: "0" });
  });

  it("shows an unused tag and answers 404 for a name that is not a hashtag", async () => {
    const h = await apiHarness();
    const unused = await getJson<Tag>(h, `/api/v1/tags/${encodeURIComponent("猫")}`);
    expect(unused.status).toBe(200);
    expect(unused.body.name).toBe("猫");
    expect(unused.body.history.every((entry) => entry.uses === "0")).toBe(true);
    for (const name of ["123", "a-b", encodeURIComponent("#cats"), "x".repeat(1001)]) {
      expect(await getJson(h, `/api/v1/tags/${name}`)).toEqual({ status: 404, body: { error: "Record not found" } });
    }
  });

  it("needs no scope: any valid token reads it, following and featuring only for a user (AUTH-2)", async () => {
    const h = await community(["alice"]);
    const app = (await getJson<Tag>(h, "/api/v1/tags/cats", await appToken(h))).body;
    expect(app).not.toHaveProperty("following");
    expect(app).not.toHaveProperty("featuring");
    for (const scope of ["read:statuses", "write:statuses"]) {
      const { status, body } = await getJson<Tag>(h, "/api/v1/tags/cats", await scopedToken(h, scope));
      expect(status).toBe(200);
      expect([body.following, body.featuring]).toEqual([false, false]);
    }
    expect((await h.request("/api/v1/tags/cats", bearer("nope"))).status).toBe(401);
  });

  // `count` statuses of alice's tagged #cats with the given visibility, published at `at`, ids from (at << 16) up.
  async function tagged(h: ApiHarness & { users: { alice: User } }, count: number, at: number, visibility = "public") {
    const base = BigInt(at) << 16n;
    await sql(
      h.store,
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ? - 1)
			INSERT INTO statuses (id, uri, account_id, visibility, published_at)
			SELECT CAST(? + i AS TEXT), 'https://kopje.test/ap/o/t' || ? || '-' || i, ?, ?, ? FROM n`,
      count,
      String(base),
      String(base),
      h.users.alice.id,
      visibility,
      new Date(at).toISOString(),
    );
    await sql(
      h.store,
      `INSERT INTO status_tags (status_id, name, public)
			SELECT id, 'cats', visibility = 'public' FROM statuses WHERE id >= ? AND id < ?`,
      String(base),
      String(base + BigInt(count)),
    );
  }

  it("keeps the public history whatever hidden statuses the window holds (VIS-12)", async () => {
    const h = await community(["alice"]);
    await tagged(h, 1, NOW + 60_000);
    const before = (await getJson<Tag>(h, "/api/v1/tags/cats")).body;
    expect(before.history[0]).toEqual({ day: day(0), uses: "1", accounts: "1" });
    // Newer hidden statuses, more of them than any budget would allow.
    let at = NOW + 3_600_000;
    for (const visibility of ["private", "direct", "limited"]) {
      await tagged(h, 4000, at, visibility);
      at += 3_600_000;
    }
    expect((await getJson<Tag>(h, "/api/v1/tags/cats")).body).toEqual(before);
  }, 60_000);

  it("never reads the hidden statuses in the window (RES-7)", async () => {
    const measure = async (hidden: number) => {
      const h = await community(["alice"]);
      await tagged(h, 100, NOW + 3_600_000);
      await tagged(h, hidden, NOW + 7_200_000, "private");
      return rowsRead(h, getTag, {
        credential: null,
        name: "cats",
        now: NOW + DAY_MS / 2,
        present: { origin: "https://kopje.test" },
      });
    };
    const few = await measure(1);
    const many = await measure(4000);
    expect(many).toBeLessThanOrEqual(few + 10);
  }, 60_000);

  it("reads only the window: older uses of the tag are never read (RES-7)", async () => {
    const measure = async (old: number) => {
      const h = await community(["alice"]);
      // Old statuses a month back, recent ones an hour into today.
      await tagged(h, old, NOW - 30 * DAY_MS);
      await tagged(h, 100, NOW + 3_600_000);
      return rowsRead(h, getTag, {
        credential: null,
        name: "cats",
        now: NOW + DAY_MS / 2,
        present: { origin: "https://kopje.test" },
      });
    };
    const small = await measure(2000);
    const large = await measure(8000);
    expect(large).toBeLessThan(small * 1.5);
  }, 120_000);

  it("seeks each of the window's statuses by id, the Store grown after ANALYZE (RES-7)", async () => {
    const h = await community(["alice"]);
    await tagged(h, 3, NOW + 3_600_000);
    const run = () =>
      plannedRun(h, /FROM status_tags t/, getTag, {
        credential: null,
        name: "cats",
        now: NOW + DAY_MS / 2,
        present: { origin: "https://kopje.test" },
      });
    const { before, after } = await staleStatistics(h, {
      capture: () => run(),
      grow: async () => {
        // Older uses of the hashtag, and newer statuses without it.
        await tagged(h, 5000, NOW - 30 * DAY_MS);
        await sql(
          h.store,
          `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 20000 - 1)
					INSERT INTO statuses (id, uri, account_id, visibility, published_at)
					SELECT CAST(?2 + i AS TEXT), 'https://kopje.test/ap/o/u' || i, ?1, 'public', ?3 FROM n`,
          h.users.alice.id,
          String(BigInt(NOW + 7_200_000) << 16n),
          new Date(NOW + 7_200_000).toISOString(),
        );
      },
    });
    expect(after.result).toEqual(before.result);
    expect((after.result as { value: Tag }).value.history[0]).toMatchObject({ uses: "3", accounts: "1" });
    expect(after.plans).toHaveLength(1);
    const { plan, rows } = after.plans[0]!;
    expect(plan.slice(0, 2)).toEqual([
      "SEARCH t USING COVERING INDEX status_tags_public (name=? AND status_id>?)",
      "SEARCH s USING INDEX sqlite_autoindex_statuses_1 (id=?)",
    ]);
    expect(scansOf(plan, ["t", "s"])).toEqual([]);
    expect(rows).toBe(before.plans[0]!.rows);
  }, 60_000);
});
