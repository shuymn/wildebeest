import { describe, expect, it } from "vitest";

import { DOMAIN_BLOCKS_LIMIT } from "../src/domain/admin-domain-blocks";
import { MARK_ACCOUNTS, SEVER_ROUND } from "../src/domain/remote-suspension";
import { bearer, json, sql } from "./api-helpers";
import { jobs, round, world, type World } from "./remote-suspension-helpers";

// Fediblockhole (eigenmagic/fediblockhole c9d7552, src/fediblockhole/__init__.py) replayed against the admin API with
// its default configuration (max_followed_severity silence, import_fields domain and severity) and its real request
// shapes, then a block through the admin API end to end: the domain job runs to its end while the lists answer 503,
// and an unblock clears what it did.

const BLOCKS = "/api/v1/admin/domain_blocks";

// BlockSeverity's order (fediblockhole/const.py): noop < silence < suspend.
const LEVEL = { noop: 0, silence: 1, suspend: 2 } as const;
type Level = keyof typeof LEVEL;

type Block = { domain: string; severity: Level; id?: string };

// What a run did: each request's method, path and status, and what it logged at warning or error level.
type Run = { requests: string[]; warnings: string[] };

// DomainBlock._asdict (const.py:218-232), the body of add_block and update_known_block.
const asDict = (block: Block) => ({
  domain: block.domain,
  severity: block.severity,
  public_comment: "",
  private_comment: "",
  reject_media: false,
  reject_reports: false,
  obfuscate: false,
});

// push_blocklist (__init__.py:652-764) with dryrun false.
async function pushBlocklist(w: World, blocklist: Block[], maxFollowed: Level = "silence"): Promise<Run> {
  const run: Run = { requests: [], warnings: [] };
  const request = async (method: string, path: string, body?: unknown) => {
    const init = body === undefined ? { method } : json(body, { method });
    // The Link URLs are absolute, on the instance's origin.
    const url = new URL(path, "https://kopje.test");
    const response = await w.h.request(`${url.pathname}${url.search}`, bearer(w.admin, init));
    run.requests.push(`${method} ${url.pathname} ${response.status}`);
    return response;
  };

  // fetch_instance_blocklist (__init__.py:446-506): follows the first of exactly two Link entries.
  const server = new Map<string, Block>();
  let url: string | null = BLOCKS;
  while (url !== null) {
    const response = await request("GET", url);
    if (response.status !== 200) {
      throw new Error(`Unable to fetch domain block list: ${response.status}`);
    }
    for (const block of await response.json<Block[]>()) {
      server.set(block.domain, block);
    }
    const pagination = response.headers.get("Link")?.split(", ");
    url = pagination?.length === 2 ? pagination[0]!.split("; ")[0]!.replace(/^</, "").replace(/>$/, "") : null;
  }

  // check_followed_severity and fetch_instance_follows (__init__.py:529-598).
  const followedSeverity = async (domain: string, severity: Level): Promise<Level> => {
    if (LEVEL[severity] <= LEVEL[maxFollowed]) {
      return severity;
    }
    const response = await request("POST", "/api/v1/admin/measures", {
      keys: ["instance_follows"],
      instance_follows: { domain },
    });
    if (response.status !== 200) {
      throw new Error(`Something went wrong: ${response.status}: ${await response.text()}`);
    }
    const follows = Number((await response.json<{ total: string }[]>())[0]!.total);
    return follows > 0 ? maxFollowed : severity;
  };

  for (const block of blocklist) {
    const old = server.get(block.domain);
    if (old !== undefined) {
      if (old.severity === block.severity) {
        continue;
      }
      let severity = block.severity;
      if (LEVEL[severity] > LEVEL[old.severity]) {
        severity = await followedSeverity(old.domain, severity);
        if (severity === old.severity) {
          continue;
        }
      }
      // update_known_block (__init__.py:606-624): any status but 200 raises.
      const response = await request("PUT", `${BLOCKS}/${old.id}`, asDict({ ...old, severity }));
      if (response.status !== 200) {
        throw new Error(`Something went wrong: ${response.status}: ${await response.text()}`);
      }
      continue;
    }
    const severity = await followedSeverity(block.domain, block.severity);
    // add_block (__init__.py:627-649): a 422 is logged, and the run goes on.
    const response = await request("POST", BLOCKS, asDict({ ...block, severity }));
    if (response.status === 422) {
      run.warnings.push((await response.json<{ error: string }>()).error);
    } else if (response.status !== 200) {
      throw new Error(`Something went wrong: ${response.status}`);
    }
  }
  return run;
}

const stored = (w: World) =>
  sql<{ domain: string; severity: string }>(
    w.h.store,
    "SELECT domain, severity FROM instance_domain_blocks ORDER BY id",
  );

let sequence = 9_000_000_000;

// `n` remote accounts on `domain` that `follower` follows in `state`.
async function follows(w: World, follower: string, domain: string, state: "accepted" | "pending", n = 1) {
  for (let i = 0; i < n; i++) {
    const id = String(sequence++).padStart(18, "0");
    await sql(
      w.h.store,
      "INSERT INTO accounts (id, uri, username, domain, inbox_url) VALUES (?1, 'https://' || ?2 || '/users/' || ?1, 'u' || ?1, ?2, 'https://' || ?2 || '/users/' || ?1 || '/inbox')",
      id,
      domain,
    );
    await sql(
      w.h.store,
      "INSERT INTO follows (account_id, target_account_id, state) VALUES (?, ?, ?)",
      follower,
      id,
      state,
    );
  }
}

describe("Fediblockhole, default configuration", () => {
  it("suspends a domain that has only pending follows, after measuring it", async () => {
    const w = await world();
    await follows(w, w.alice.id, "pending.example", "pending");
    const run = await pushBlocklist(w, [{ domain: "pending.example", severity: "suspend" }]);
    expect(run).toEqual({
      requests: [`GET ${BLOCKS} 200`, "POST /api/v1/admin/measures 200", `POST ${BLOCKS} 200`],
      warnings: [],
    });
    expect(await stored(w)).toEqual([{ domain: "pending.example", severity: "suspend" }]);
  });

  it("lowers a block of a followed domain to silence, which Kopje refuses with 422, logged by Fediblockhole", async () => {
    const w = await world();
    await follows(w, w.alice.id, "followed.example", "accepted");
    // A domain blocked as noop and raised: lowered too, and the update's 422 raises (update_known_block).
    const run = await pushBlocklist(w, [
      { domain: "followed.example", severity: "suspend" },
      { domain: "quiet.example", severity: "noop" },
    ]);
    expect(run).toEqual({
      requests: [`GET ${BLOCKS} 200`, "POST /api/v1/admin/measures 200", `POST ${BLOCKS} 422`, `POST ${BLOCKS} 200`],
      warnings: ["Validation failed: Severity is not included in the list"],
    });
    expect(await stored(w)).toEqual([{ domain: "quiet.example", severity: "noop" }]);
    await follows(w, w.bob.id, "quiet.example", "accepted");
    await expect(pushBlocklist(w, [{ domain: "quiet.example", severity: "suspend" }])).rejects.toThrow(
      "Something went wrong: 422",
    );
    expect(await stored(w)).toEqual([{ domain: "quiet.example", severity: "noop" }]);
    // Once nobody follows it, the raise goes through as a PUT of the whole block.
    await sql(w.h.store, "DELETE FROM follows");
    const raised = await pushBlocklist(w, [{ domain: "quiet.example", severity: "suspend" }]);
    expect(raised.requests.slice(-2)).toEqual([
      "POST /api/v1/admin/measures 200",
      expect.stringMatching(/^PUT .* 200$/),
    ]);
    expect(await stored(w)).toEqual([{ domain: "quiet.example", severity: "suspend" }]);
  });

  it("measures the domain itself, so a follow only on a subdomain does not hold back its parent (include_subdomains)", async () => {
    const w = await world();
    await follows(w, w.alice.id, "a.sub.example", "accepted");
    const measure = async (extra: Record<string, unknown>) =>
      (
        await (
          await w.h.request(
            "/api/v1/admin/measures",
            bearer(
              w.admin,
              json({ keys: ["instance_follows"], instance_follows: { domain: "sub.example", ...extra } }),
            ),
          )
        ).json<{ total: string }[]>()
      )[0]!.total;
    expect(await measure({})).toBe("0");
    expect(await measure({ include_subdomains: true })).toBe("1");
    // Fediblockhole sends no include_subdomains, so its check passes, as on Mastodon, and the suspend covers
    // a.sub.example too (the longest matching block).
    const run = await pushBlocklist(w, [{ domain: "sub.example", severity: "suspend" }]);
    expect(run.requests.at(-1)).toBe(`POST ${BLOCKS} 200`);
    expect(await stored(w)).toEqual([{ domain: "sub.example", severity: "suspend" }]);
  });

  it("reads every page of the blocks through its Link handling, and leaves known blocks alone", async () => {
    const w = await world();
    const n = DOMAIN_BLOCKS_LIMIT * 2 + 1;
    await sql(
      w.h.store,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO instance_domain_blocks (domain, severity, created_at, updated_at)
			SELECT 'b' || i || '.example', 'suspend', 'x', 'x' FROM n`,
      n,
    );
    const run = await pushBlocklist(w, [
      { domain: "b1.example", severity: "suspend" },
      { domain: `b${n}.example`, severity: "suspend" },
    ]);
    expect(run.requests).toEqual([`GET ${BLOCKS} 200`, `GET ${BLOCKS} 200`, `GET ${BLOCKS} 200`]);
  });
});

describe("a domain block through the admin API, end to end", () => {
  const D = "d.example";

  const list = async (w: World, query: string) => {
    // One page holds them all (at most 200).
    const response = await w.h.request(`/api/v2/admin/accounts?limit=200&${query}`, bearer(w.admin));
    return {
      status: response.status,
      retryAfter: response.headers.get("retry-after"),
      ids: response.status === 200 ? (await response.json<{ id: string }[]>()).map((a) => a.id).toSorted() : [],
    };
  };

  // Rounds until the remote jobs are done; at each step, the lists that read the marks answer 503.
  async function drain(w: World): Promise<number> {
    let rounds = 0;
    while ((await jobs(w.h.store)).length > 0) {
      for (const status of ["active", "suspended"]) {
        const answer = await list(w, `status=${status}`);
        expect(answer.status, `${status} at round ${rounds}`).toBe(503);
        expect(answer.retryAfter).not.toBeNull();
      }
      expect(await round(w.h.store)).not.toBeNull();
      expect(++rounds).toBeLessThan(500);
    }
    return rounds;
  }

  it("creates a suspend block, runs the domain job to its end, then deletes it and clears what it did", async () => {
    const w = await world();
    const n = Math.max(MARK_ACCOUNTS, SEVER_ROUND) + 50;
    await follows(w, w.alice.id, D, "accepted", n);
    await follows(w, w.bob.id, `x.${D}`, "pending", 3);
    const onD = (
      await sql<{ id: string }>(w.h.store, "SELECT id FROM accounts WHERE domain = ?1 OR domain = 'x.' || ?1", D)
    ).map((row) => row.id);
    // The other way: accounts on the domain following local accounts, accepted and pending.
    await sql(
      w.h.store,
      `INSERT INTO follows (account_id, target_account_id, state)
			SELECT value, ?2, CASE WHEN key % 2 = 0 THEN 'accepted' ELSE 'pending' END FROM json_each(?1)`,
      JSON.stringify(onD.slice(0, 40)),
      w.bob.id,
    );
    const inward = await sql(w.h.store, "SELECT 1 FROM follows WHERE target_account_id = ?", w.bob.id);
    expect(inward).toHaveLength(40);
    expect((await list(w, "status=active")).ids).toEqual(expect.arrayContaining(onD));

    const created = await w.h.request(BLOCKS, bearer(w.admin, json({ domain: D, severity: "suspend" })));
    expect(created.status).toBe(200);
    const { id } = await created.json<{ id: string }>();
    expect(await drain(w)).toBeGreaterThan(2);
    // Marked and severed both ways: the accounts are listed as suspended, and no follow involves them.
    expect((await list(w, "status=suspended")).ids).toEqual(expect.arrayContaining(onD));
    expect((await list(w, "status=active")).ids).not.toEqual(expect.arrayContaining([onD[0]]));
    expect(
      await sql(
        w.h.store,
        `SELECT 1 FROM follows f JOIN accounts a ON a.id IN (f.account_id, f.target_account_id)
				WHERE a.domain IN (?1, 'x.' || ?1)`,
        D,
      ),
    ).toEqual([]);

    const deleted = await w.h.request(`${BLOCKS}/${id}`, bearer(w.admin, { method: "DELETE" }));
    expect(await deleted.json()).toEqual({});
    await drain(w);
    expect(
      await sql(w.h.store, "SELECT id FROM accounts WHERE suspension_source = 'domain' OR suspended_at IS NOT NULL"),
    ).toEqual([]);
    expect((await list(w, "status=active")).ids).toEqual(expect.arrayContaining(onD));
    expect((await list(w, "status=suspended")).ids).toEqual([]);
    expect(
      (
        await sql<{ action: string }>(
          w.h.store,
          "SELECT action FROM admin_actions WHERE target_type = 'DomainBlock' ORDER BY id",
        )
      ).map((row) => row.action),
    ).toEqual(["create", "destroy"]);
  });
});
