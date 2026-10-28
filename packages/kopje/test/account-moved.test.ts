import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { selectSql } from "../src/db/columns";
import { Db } from "../src/db/sql";
import {
  MOVED_ACCOUNT_CAPS,
  MOVED_ACCOUNT_COLUMNS,
  MOVED_CREATED_AT_LIMIT,
  MOVED_DISPLAY_NAME_LIMIT,
  MOVED_EMOJIS_BYTES,
  MOVED_LAST_STATUS_AT_LIMIT,
  MOVED_URL_LIMIT,
} from "../src/domain/account-columns";
import { type Account, presentAccountsWithin, USERNAME_LIMIT } from "../src/domain/accounts";
import { ADMIN_EMAIL_COLUMNS, LOCAL_EMAIL_COLUMNS } from "../src/domain/admin-authority";
import { jsonBytes } from "../src/domain/answer-budget";
import { purgeBatch, receiveActivity } from "../src/domain/inbox";
import { actorRevision, type RemoteActorInput } from "../src/domain/remote-actors";
import { DOMAIN_BYTES } from "../src/platform/identity-bounds";
import { setSetting, sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { customEmoji } from "./emoji-fixtures";
import { actorDefaults } from "./inbox-helpers";
import {
  observedSql,
  type PlannedStatement,
  plannedSql,
  remoteAccounts,
  scansOf,
  staleStatistics,
} from "./read-helpers";
import { community, getJson } from "./status-helpers";
import { recordingSql } from "./status-row-fixtures";

// Account#moved as REST::AccountSerializer shows it (Mastodon v4.5.11, account_serializer.rb:13, 119-121, 157-159):
// present only when the account has a stored move, null while the account is unavailable, else the moved-to account one
// level deep, which never shows a `moved` of its own. The nested account is Kopje's bounded projection
// (account-columns.ts MOVED_ACCOUNT_COLUMNS, docs/mastodon-deviations.md): its texts cut by raw bytes in SQL and by
// decoded limits in the presenter, its URLs within MOVED_URL_LIMIT, no note or fields, and only the emojis its display
// name references within MOVED_EMOJIS_BYTES.

const ORIGIN = "https://kopje.test";
const OWNER = [{ id: "3", name: "Owner", color: "" }];
const utf8 = (value: string) => new TextEncoder().encode(value).length;
const points = (value: string) => [...value].length;

type Columns = Record<string, SqlStorageValue>;

async function fixture() {
  const h = await community(["alice", "bob"]);
  await setSetting(h.store, "admin_email", "alice@example.com");
  // Ids of this fixture's accounts, in turn.
  let next = 870_000_000_000_000_000n;
  const account = async (columns: Columns = {}): Promise<string> => {
    const id = String(next++);
    const all: Columns = {
      uri: `https://remote.example/users/u${id}`,
      username: `u${id}`,
      domain: "remote.example",
      display_name: `User ${id}`,
      note: "<p>bio</p>",
      ...columns,
    };
    const names = Object.keys(all);
    await sql(
      h.store,
      `INSERT INTO accounts (id, ${names.join(", ")}) VALUES (?, ${names.map(() => "?").join(", ")})`,
      id,
      ...Object.values(all),
    );
    return id;
  };
  const move = (source: string, target: string) =>
    sql(h.store, "UPDATE accounts SET moved_to_account_id = ? WHERE id = ?", target, source);
  const shown = async (id: string) => (await getJson<Account>(h, `/api/v1/accounts/${id}`, h.users.bob.token)).body;
  return { h, account, move, shown };
}

describe("moved", () => {
  it("is absent without a move, and a nested account without its own moved, a chain and a cycle too", async () => {
    const { account, move, shown } = await fixture();
    const [a, b, c] = [await account(), await account(), await account()];
    expect("moved" in (await shown(a))).toBe(false);
    await move(a, b);
    await move(b, c);
    const first = await shown(a);
    expect(first.moved).toMatchObject({ id: b, acct: `u${b}@remote.example`, note: "", fields: [] });
    expect("moved" in first.moved!).toBe(false);
    expect((await shown(b)).moved).toMatchObject({ id: c });
    // A ↔ B: each shows the other, one level deep.
    await move(b, a);
    const [ab, ba] = [await shown(a), await shown(b)];
    expect([ab.moved!.id, ba.moved!.id]).toEqual([b, a]);
    expect("moved" in ab.moved! || "moved" in ba.moved!).toBe(false);
  });

  it("shows the identity of the target as the full account shows it, but its note and fields", async () => {
    const { account, move, shown } = await fixture();
    const target = await account({
      url: "https://remote.example/@target",
      avatar_url: "https://remote.example/a.png",
      header_url: "https://remote.example/h.png",
      locked: 1,
      actor_type: "Service",
      followers_count: 7,
      raw: JSON.stringify({ attachment: [{ type: "PropertyValue", name: "k", value: "v" }] }),
    });
    const source = await account();
    await move(source, target);
    const full = await shown(target);
    const nested = (await shown(source)).moved!;
    expect(full.fields).toHaveLength(1);
    expect(nested).toEqual({ ...full, note: "", fields: [] });
  });

  it("is null while the source is unavailable, whose target is not read; an unavailable target is redacted", async () => {
    const { h, account, move, shown } = await fixture();
    const target = await account({ avatar_url: "https://remote.example/a.png" });
    const source = await account();
    await move(source, target);
    await sql(
      h.store,
      "UPDATE accounts SET suspended_at = '2026-01-01', suspension_source = 'account' WHERE id = ?",
      source,
    );
    const { moved, reads } = await runInDurableObject(h.store, (_instance, state) => {
      const recording = recordingSql(state.storage.sql);
      const accounts = presentAccountsWithin(new Db(recording.sql), [source], { origin: ORIGIN }, Infinity, true);
      return { moved: accounts.items[0]!.moved, reads: recording.reads };
    });
    expect(moved).toBeNull();
    expect(reads.filter((query) => query.includes(selectSql(MOVED_ACCOUNT_COLUMNS.columns)))).toEqual([]);
    expect((await shown(source)).moved).toBeNull();
    await sql(h.store, "UPDATE accounts SET suspended_at = NULL, suspension_source = NULL WHERE id = ?", source);
    await sql(
      h.store,
      "UPDATE accounts SET suspended_at = '2026-01-01', suspension_source = 'account' WHERE id = ?",
      target,
    );
    expect((await shown(source)).moved).toMatchObject({
      id: target,
      suspended: true,
      display_name: "",
      emojis: [],
      avatar: `${ORIGIN}/assets/avatar.jpg`,
      uri: `https://remote.example/users/u${target}`,
    });
    // A target whose deletion has started is unavailable too.
    await sql(h.store, "UPDATE accounts SET suspended_at = NULL, suspension_source = NULL WHERE id = ?", target);
    await sql(h.store, "UPDATE accounts SET deleted_at = '2026-01-01' WHERE id = ?", target);
    expect((await shown(source)).moved).toMatchObject({ id: target, suspended: true });
  });

  it("is absent for a dangling id and for a target whose domain passes DOMAIN_BYTES", async () => {
    const { account, move, shown } = await fixture();
    const dangling = await account();
    await move(dangling, "999999999999999999");
    expect("moved" in (await shown(dangling))).toBe(false);
    const fits = await account({ domain: `${"d".repeat(DOMAIN_BYTES - 5)}.test` });
    const long = await account({ domain: `${"d".repeat(DOMAIN_BYTES - 4)}.test` });
    const [toFits, toLong] = [await account(), await account()];
    await move(toFits, fits);
    await move(toLong, long);
    expect((await shown(toFits)).moved).toMatchObject({ id: fits });
    expect("moved" in (await shown(toLong))).toBe(false);
  });

  it("shows a local target with noindex and its role, the Owner for the OAuth admin", async () => {
    const { h, account, move, shown } = await fixture();
    const [toAdmin, toBob] = [await account(), await account()];
    await move(toAdmin, h.users.alice.id);
    await move(toBob, h.users.bob.id);
    expect((await shown(toAdmin)).moved).toMatchObject({ id: h.users.alice.id, roles: OWNER, noindex: false });
    expect((await shown(toBob)).moved).toMatchObject({ id: h.users.bob.id, roles: [], noindex: false });
    const remote = await account();
    await move(toBob, remote);
    const nested = (await shown(toBob)).moved!;
    expect("roles" in nested || "noindex" in nested).toBe(false);
  });
});

describe("the nested account at its caps (RES-2)", () => {
  it("cuts the display name at MOVED_DISPLAY_NAME_LIMIT code points, astral ones and NUL included", async () => {
    const { account, move, shown } = await fixture();
    for (const name of ["n".repeat(101), "𠀀".repeat(101), `${"\u0000".repeat(50)}${"𠀀".repeat(60)}`]) {
      const [target, source] = [await account({ display_name: name }), await account()];
      await move(source, target);
      const nested = (await shown(source)).moved!;
      expect(nested.display_name).toBe([...name].slice(0, MOVED_DISPLAY_NAME_LIMIT).join(""));
      expect(points(nested.display_name)).toBe(MOVED_DISPLAY_NAME_LIMIT);
      // The full account shows it whole.
      expect((await shown(target)).display_name).toBe(name);
    }
  });

  it("reads a URL or uri past MOVED_URL_LIMIT bytes as unset, raw or once escaped", async () => {
    const { account, move, shown } = await fixture();
    const at = (prefix: string, bytes: number) => prefix.padEnd(bytes, "u");
    const fitting = {
      uri: at("https://remote.example/users/", MOVED_URL_LIMIT),
      url: at("https://remote.example/@", MOVED_URL_LIMIT),
      avatar_url: at("https://remote.example/a/", MOVED_URL_LIMIT),
      header_url: at("https://remote.example/h/", MOVED_URL_LIMIT),
    };
    const target = await account(fitting);
    const source = await account();
    await move(source, target);
    expect((await shown(source)).moved).toMatchObject({
      uri: fitting.uri,
      url: fitting.url,
      avatar: fitting.avatar_url,
      header: fitting.header_url,
    });
    await account({ uri: `${fitting.uri}u` }).then((long) => move(source, long));
    const past = await account({
      url: `${fitting.url}u`,
      avatar_url: `${fitting.avatar_url}u`,
      // A '\' a serialized URL keeps in its query, which JSON doubles: 512 bytes, 513 as JSON.
      header_url: at("https://remote.example/h?\\", MOVED_URL_LIMIT),
    });
    const nestedUri = (await shown(source)).moved!;
    expect(nestedUri.uri).toBe("");
    await move(source, past);
    const nested = (await shown(source)).moved!;
    expect(nested).toMatchObject({
      url: `https://remote.example/@u${past}`,
      avatar: `${ORIGIN}/assets/avatar.jpg`,
      header: `${ORIGIN}/assets/header.jpg`,
    });
    // The full account shows each, within PROFILE_URL_LIMIT.
    expect(await shown(past)).toMatchObject({ url: `${fitting.url}u`, avatar: `${fitting.avatar_url}u` });
    for (const value of [nested.uri, nested.url, nested.avatar, nested.header, nestedUri.uri]) {
      expect(utf8(JSON.stringify(value)) - 2).toBeLessThanOrEqual(MOVED_URL_LIMIT);
    }
  });

  it("shows only the emojis its cut display name references, in order, within MOVED_EMOJIS_BYTES", async () => {
    const { account, move, shown } = await fixture();
    // Entries of 67 + 2 + 2 × 300 bytes presented: three fit 2,048, four do not; e0 is not referenced, e5 only past
    // the cut. Each name, and each URL's scheme, is written in \u escapes (within the stored 6,144 bytes), which the
    // snapshot decodes. The first `n` characters of `text` as \u escapes.
    const escaped = (text: string, n: number) =>
      [...text].map((c, i) => (i < n ? `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}` : c)).join("");
    const url = (i: number) => `https://remote.example/${String(i).repeat(300 - "https://remote.example/".length)}`;
    const entries = Array.from({ length: 6 }, (_, i) => `["${escaped(`e${i}`, 2)}","${escaped(url(i), 8)}"]`);
    const snapshot = `[${entries.join(",")}]`;
    const name = `${":e1::e2::e3::e4:".padEnd(MOVED_DISPLAY_NAME_LIMIT, " ")}:e5:`;
    const target = await account({ display_name: name, emojis: snapshot });
    const source = await account();
    await move(source, target);
    const nested = (await shown(source)).moved!;
    expect(nested.emojis.map((emoji) => emoji.shortcode)).toEqual(["e1", "e2", "e3"]);
    expect(nested.emojis[0]).toEqual(customEmoji("e1", url(1)));
    expect(jsonBytes(nested.emojis)).toBeLessThanOrEqual(MOVED_EMOJIS_BYTES);
    expect(jsonBytes([...nested.emojis, nested.emojis[0]])).toBeGreaterThan(MOVED_EMOJIS_BYTES);
    // The full account shows its whole snapshot.
    expect((await shown(target)).emojis).toHaveLength(6);
  });

  // An accepted imported snapshot: eight unreferenced entries whose URLs hold 150 '{' each (allowed as stored, and
  // percent-encoded, three bytes each, when normalized), then the one the display name references.
  it("keeps a referenced emoji behind unreferenced ones that grow past the snapshot bound when normalized", async () => {
    const { account, move, shown } = await fixture();
    const braces = (i: number) => `https://remote.example/${i}/${"{".repeat(150)}`;
    const keep = "https://remote.example/keep.png";
    const snapshot = JSON.stringify([...Array.from({ length: 8 }, (_, i) => [`skip${i}`, braces(i)]), ["keep", keep]]);
    const target = await account({ display_name: "moved :keep:", emojis: snapshot });
    const source = await account();
    await move(source, target);
    expect((await shown(source)).moved!.emojis).toEqual([customEmoji("keep", keep)]);
    // The full account's own admission stops before it, past ACCOUNT_EMOJIS_BYTES.
    expect((await shown(target)).emojis.map((emoji) => emoji.shortcode)).not.toContain("keep");
  });

  // Every entry referenced, each url normalized to 512 bytes ('{' percent-encoded): one entry fits MOVED_EMOJIS_BYTES,
  // and the rest are never presented (the heap model counts one entry past the admitted ones,
  // test/status-bounds.test.ts).
  it("presents a snapshot of fourteen referenced 512-byte entries as the one that fits", async () => {
    const { account, move, shown } = await fixture();
    const names = Array.from({ length: 14 }, (_, i) => String.fromCharCode(97 + i));
    const url = `http://a/${"{".repeat(167)}aa`;
    const pairs = names.map((name) => [name, url]);
    const snapshot = JSON.stringify(pairs);
    expect(utf8(snapshot)).toBe(2_619);
    const target = await account({
      display_name: names.map((name) => `:${name}:`).join(""),
      emojis: snapshot.padEnd(6_144, " "),
    });
    const source = await account();
    await move(source, target);
    const href = `http://a/${"%7B".repeat(167)}aa`;
    expect(utf8(href)).toBe(512);
    const nested = (await shown(source)).moved!;
    expect(nested.emojis).toEqual([customEmoji("a", href)]);
    expect(jsonBytes(nested.emojis)).toBeLessThanOrEqual(MOVED_EMOJIS_BYTES);
    // Presented whole, the snapshot would be 15,289 bytes.
    expect(jsonBytes(names.map((name) => customEmoji(name, href)))).toBe(15_289);
  });

  // Imported TEXT may be malformed UTF-8: F0 followed by continuation bytes is one character to SQLite's substr.
  it("reads malformed imported text within its byte caps and presents it within its decoded limits", async () => {
    const { h, account, move, shown } = await fixture();
    const target = await account();
    const source = await account();
    await move(source, target);
    const malformed = `x'F0${"80".repeat(4096)}'`;
    await sql(
      h.store,
      `UPDATE accounts SET display_name = CAST(${malformed} AS TEXT), username = CAST(${malformed} AS TEXT),
				created_at = CAST(${malformed} AS TEXT) WHERE id = ?`,
      target,
    );
    await sql(
      h.store,
      `INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
			VALUES ('870000000000009999', 'https://remote.example/s/1', ?, 'public', '', CAST(${malformed} AS TEXT))`,
      target,
    );
    // Each row's text values in UTF-16 code units, as RowMeter counts them (a malformed byte decodes to one U+FFFD).
    const read = await runInDurableObject(h.store, (_instance, state) => {
      const rows: Record<string, number>[] = [];
      const observing = observedSql(state.storage.sql, (seen, query) => {
        if (query.includes(selectSql(MOVED_ACCOUNT_COLUMNS.columns))) {
          for (const row of seen) {
            rows.push(
              Object.fromEntries(
                Object.entries(row).map(([column, value]) => [column, typeof value === "string" ? value.length : 0]),
              ),
            );
          }
        }
      });
      presentAccountsWithin(new Db(observing), [source], { origin: ORIGIN }, Infinity, true);
      return rows;
    });
    expect(read).toHaveLength(1);
    for (const [column, units] of Object.entries(read[0]!)) {
      expect(units, column).toBeLessThanOrEqual(MOVED_ACCOUNT_CAPS[column as keyof typeof MOVED_ACCOUNT_CAPS]);
    }
    // Cut at the byte caps, past the decoded limits, which the presenter applies.
    expect(read[0]).toMatchObject({
      display_name: MOVED_ACCOUNT_CAPS.display_name,
      created_at: MOVED_ACCOUNT_CAPS.created_at,
      last_status_at: MOVED_ACCOUNT_CAPS.last_status_at,
    });
    const nested = (await shown(source)).moved!;
    expect(points(nested.display_name)).toBe(MOVED_DISPLAY_NAME_LIMIT);
    expect(points(nested.username)).toBe(USERNAME_LIMIT);
    expect(points(nested.created_at)).toBe(MOVED_CREATED_AT_LIMIT);
    expect(points(nested.last_status_at!)).toBe(MOVED_LAST_STATUS_AT_LIMIT);
  });
});

describe("the nested account where accounts are presented", () => {
  it("shows in a status author, a notification, the accounts by id and by address, across a chunk boundary", async () => {
    const { h, account, move } = await fixture();
    const [target, source, other] = [await account(), await account(), await account()];
    await move(source, target);
    await move(other, target);
    const status = "870000000000009998";
    await sql(
      h.store,
      `INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
			VALUES (?, 'https://remote.example/s/2', ?, 'public', '<p>x</p>', '2026-01-01T00:00:00.000Z')`,
      status,
      source,
    );
    await sql(
      h.store,
      "INSERT INTO notifications (account_id, type, from_account_id, created_at) VALUES (?, 'follow', ?, ?)",
      h.users.bob.id,
      source,
      "2026-01-01T00:00:00.000Z",
    );
    const token = h.users.bob.token;
    const author = (await getJson<{ account: Account }>(h, `/api/v1/statuses/${status}`, token)).body.account;
    const [notified] = (await getJson<{ account: Account }[]>(h, "/api/v1/notifications", token)).body;
    const byId = (await getJson<Account[]>(h, `/api/v1/accounts?id[]=${source}&id[]=${other}`, token)).body;
    const byAddress = (await getJson<Account>(h, `/api/v1/accounts/lookup?acct=u${source}@remote.example`, token)).body;
    for (const shown of [author, notified!.account, ...byId, byAddress]) {
      expect(shown.moved, shown.id).toMatchObject({ id: target });
    }
    expect(byId.map((shown) => shown.id)).toEqual([source, other]);
    // 51 sources, each moved to its own target: two chunks of ANSWER_CHUNK, one read of targets each.
    const sources: string[] = [];
    const targets: string[] = [];
    for (let i = 0; i < 51; i++) {
      const [s, t] = [await account(), await account()];
      await move(s, t);
      sources.push(s);
      targets.push(t);
    }
    const { moved, reads } = await runInDurableObject(h.store, (_instance, state) => {
      const recording = recordingSql(state.storage.sql);
      const shown = presentAccountsWithin(new Db(recording.sql), sources, { origin: ORIGIN }, Infinity, true);
      return {
        moved: shown.items.map((item) => item.moved?.id),
        reads: recording.reads.filter((query) => query.includes(selectSql(MOVED_ACCOUNT_COLUMNS.columns))).length,
      };
    });
    expect(moved).toEqual(targets);
    expect(reads).toBe(2);
  });
});

// An account list presents its accounts lazily, one at a time, so nothing past the first account the budget
// refuses is presented: its moved-to account is read with the chunk, but not presented, so its Owner role is never
// looked up (the OAuth admin's two reads, oauthAdmin).
describe("a list cut by its budget", () => {
  it("presents nothing past the account it refuses, the nested local account included", async () => {
    const { h, account, move } = await fixture();
    const shown: string[] = [];
    for (let i = 0; i < 5; i++) {
      const [s, t] = [await account(), await account()];
      await move(s, t);
      shown.push(s);
    }
    const refused = await account({ display_name: "\u0001".repeat(2048) });
    const last = await account();
    await move(last, h.users.alice.id);
    const ids = [...shown, refused, last];
    const lookup = (query: string) =>
      query.includes(selectSql(ADMIN_EMAIL_COLUMNS)) || query.includes(selectSql(LOCAL_EMAIL_COLUMNS));
    // Each run is its own operation (a fresh root Db), so the admin memo starts empty.
    const run = (budget: number) =>
      runInDurableObject(h.store, (_instance, state) => {
        const recording = recordingSql(state.storage.sql);
        const answer = presentAccountsWithin(new Db(recording.sql), ids, { origin: ORIGIN }, budget, true);
        return {
          items: answer.items,
          cut: answer.cut,
          moved: recording.reads.filter((query) => query.includes(selectSql(MOVED_ACCOUNT_COLUMNS.columns))).length,
          lookups: recording.reads.filter(lookup).length,
        };
      });
    const whole = await run(Infinity);
    expect(whole.items.at(-1)!.moved).toMatchObject({ id: h.users.alice.id, roles: OWNER });
    expect(whole.lookups).toBe(2);
    const budget = whole.items.slice(0, shown.length).reduce((sum, item) => sum + jsonBytes(item) + 1, 0);
    const cut = await run(budget);
    expect(cut.items.map((item) => item.id)).toEqual(shown);
    expect(cut.cut).toBe(true);
    expect(cut.moved).toBe(1);
    expect(cut.lookups).toBe(0);
  });
});

// RES-7: each read and write of a move seeks by key once accounts and moves outgrow the statistics: the chunk's
// moved-to accounts (movedOf), the document's movedTo resolved by actor id, the Move's own write, and the purge's
// clearing step and completion check through accounts_moved_to.
describe("query plans of moves (RES-7)", () => {
  it("seek by key after the Store grows past its statistics", async () => {
    const { h, account, move } = await fixture();
    const [target, source] = [await account(), await account()];
    await move(source, target);
    const actor = (uri: string, movedTo: string | null): RemoteActorInput => ({
      ...actorDefaults(),
      uri,
      username: "mover",
      domain: "remote.example",
      displayName: "mover",
      inboxUrl: `${uri}/inbox`,
      movedTo,
    });
    const targetUri = `https://remote.example/users/u${target}`;
    // One purging account referenced by others per phase.
    const purged = { before: await account(), after: await account() };
    for (const id of Object.values(purged)) {
      for (let i = 0; i < 3; i++) {
        await move(await account(), id);
      }
      await sql(h.store, "UPDATE accounts SET deleted_at = '2026-01-01T00:00:00.000Z' WHERE id = ?", id);
    }
    const capture = (phase: "before" | "after") =>
      runInDurableObject(h.store, (_instance, state) => {
        const plans: PlannedStatement[] = [];
        const real = state.storage.sql;
        const planned = new Db(plannedSql(real, /moved_to_account_id|accounts_moved_to|m INDEXED BY/, plans));
        presentAccountsWithin(planned, [source], { origin: ORIGIN }, Infinity, true);
        const mover = `https://remote.example/users/mover-${phase}`;
        receiveActivity.run(
          plannedSql(real, /moved_to_account_id/, plans),
          {
            now: NOW,
            storeNow: NOW,
            origin: ORIGIN,
            actorUri: mover,
            actor: actor(mover, targetUri),
            actorRevision: actorRevision(new Db(real), mover),
            activity: {
              type: "Move",
              id: `${mover}#moves/1`,
              target: { document: actor(targetUri, null), revision: actorRevision(new Db(real), targetUri) },
            },
          },
          (fn) => state.storage.transactionSync(fn),
        );
        state.storage.transactionSync(() => purgeBatch(planned, `https://remote.example/users/u${purged[phase]}`, NOW));
        return plans.map(({ query, plan }) => ({ query, plan }));
      });
    const { after } = await staleStatistics(h, {
      capture,
      grow: async () => {
        await remoteAccounts(h, 100, 200);
        // Moves among them, so accounts_moved_to holds many rows.
        await sql(
          h.store,
          `UPDATE accounts SET moved_to_account_id = CAST(CAST(id AS INTEGER) + 1 AS TEXT)
					WHERE domain LIKE 'd%.example' AND CAST(id AS INTEGER) % 2 = 0`,
        );
      },
    });
    const of = (pattern: RegExp | string) =>
      after.filter(({ query }) => (typeof pattern === "string" ? query.includes(pattern) : pattern.test(query)));
    const expectSeeks = (pattern: RegExp | string, searches: readonly RegExp[]) => {
      const found = of(pattern);
      expect(found.length, String(pattern).slice(0, 80)).toBeGreaterThan(0);
      for (const { query, plan } of found) {
        expect(scansOf(plan, ["a", "m", "ml", "accounts"]), `${query}\n${plan.join("\n")}`).toEqual([]);
        for (const search of searches) {
          expect(
            plan.some((detail) => search.test(detail)),
            `${String(search)}\n${query}\n${plan.join("\n")}`,
          ).toBe(true);
        }
      }
    };
    expectSeeks(selectSql(MOVED_ACCOUNT_COLUMNS.columns), [
      /^SEARCH m USING INDEX sqlite_autoindex_accounts_1 \(id=\?\)$/,
      /^SEARCH ml USING INDEX sqlite_autoindex_local_accounts_1 \(account_id=\?\)( LEFT-JOIN)?$/,
    ]);
    // An actor document resolves the movedTo by actor id and writes the source by its key; a Move writes it by its key.
    expectSeeks(/moved_to_account_id = \(SELECT/, [
      /^SEARCH m USING (COVERING )?INDEX sqlite_autoindex_accounts_2 \(uri=\?\)$/,
      /^SEARCH accounts USING INDEX sqlite_autoindex_accounts_1 \(id=\?\)$/,
    ]);
    expectSeeks(/SET moved_to_account_id = \?2/, [
      /^SEARCH accounts USING INDEX sqlite_autoindex_accounts_1 \(id=\?\)$/,
    ]);
    // The purge's clearing step and its completion check.
    expectSeeks(/SELECT id FROM accounts INDEXED BY accounts_moved_to/, [
      /^SEARCH accounts USING (COVERING )?INDEX accounts_moved_to \(moved_to_account_id=\?\)$/,
    ]);
    expectSeeks(/WHERE EXISTS/, [
      /^SEARCH accounts USING (COVERING )?INDEX accounts_moved_to \(moved_to_account_id=\?\)$/,
    ]);
    expect(
      await sql(h.store, "SELECT count(*) AS n FROM accounts WHERE moved_to_account_id = ?", purged.after),
    ).toEqual([{ n: 0 }]);
  }, 60_000);
});
