import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { trendableStatusSql } from "../src/domain/audience";
import { readOperation } from "../src/domain/operation";
import { TREND_LANGUAGES, TREND_LANGUAGES_JSON } from "../src/domain/trends";
import type { StoreStub } from "../src/platform/store-client";
import { sql } from "./api-helpers";
import { migratedStore } from "./helpers";
import { AT, author, HOUR, trendStatus, trendStatuses } from "./trend-helpers";

// R41 (Trends::Statuses#eligible?): which statuses may trend, judged by trendableStatusSql alone (allowance and scores
// are the round's, test/trends-round.test.ts).

const trendable = readOperation<{ now: number }, string[]>((db, { now }) =>
  db
    .all<{ id: string }>(
      `SELECT s.id FROM statuses s WHERE ${trendableStatusSql("s", "?1", "?2")} ORDER BY s.id`,
      new Date(now).toISOString(),
      TREND_LANGUAGES_JSON,
    )
    .map((r) => r.id),
);

async function eligible(store: StoreStub, now = AT): Promise<string[]> {
  return runInDurableObject(store, (_instance, state) => trendable.run(state.storage.sql, { now }));
}

describe("trend eligibility (R41)", () => {
  it("holds the 210 languages of Mastodon 4.5.11 SUPPORTED_LOCALES", () => {
    expect(TREND_LANGUAGES.size).toBe(210);
    for (const code of ["en", "ja", "ast", "zh-TW", "zh-YUE", "mn-Mong", "ms-Arab", "zgh"]) {
      expect(TREND_LANGUAGES.has(code), code).toBe(true);
    }
    // gn is in GET /api/v1/instance/languages but not in Mastodon's ISO_639_1.
    for (const code of ["", "zz", "xx", "EN", "en-US", "gn"]) {
      expect(TREND_LANGUAGES.has(code), code).toBe(false);
    }
  });

  it("admits supported languages only", async () => {
    const store = await migratedStore();
    const a = await author(store, "a", { domain: "remote.example" });
    const languages = ["en", "ast", "zh-TW", null, "", "zz", "xx", "EN", "x".repeat(1 << 20)];
    const ids = await trendStatuses(
      store,
      languages.map((language, seq) => ({ author: a, published: AT - HOUR, seq, language })),
    );
    expect(await eligible(store)).toEqual(ids.slice(0, 3));
  });

  it("excludes replies, warnings, sensitive, future, undiscoverable, unavailable authors and boosts", async () => {
    const store = await migratedStore();
    const a = await author(store, "a", { domain: "remote.example" });
    const hidden = await author(store, "h", { domain: "remote.example", discoverable: 0 });
    const unset = await author(store, "n", { domain: "remote.example", discoverable: null });
    const suspended = await author(store, "s", { domain: "remote.example" });
    await sql(
      store,
      "UPDATE accounts SET suspended_at = '2026-10-01T00:00:00.000Z', suspension_source = 'account' WHERE id = ?",
      suspended,
    );
    const blocked = await author(store, "b", { domain: "sub.blocked.example" });
    await sql(
      store,
      `INSERT INTO instance_domain_blocks (domain, severity, created_at, updated_at)
			VALUES ('blocked.example', 'suspend', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
    );
    const t = AT - HOUR;
    const ok = await trendStatus(store, { author: a, published: t, seq: 0 });
    const local = await author(store, "l");
    const localOk = await trendStatus(store, { author: local, published: t, seq: 99 });
    await trendStatuses(store, [
      { author: a, published: t, seq: 1, reply: true },
      { author: a, published: t, seq: 2, spoiler: "cw" },
      { author: a, published: t, seq: 3, spoiler: " \t\n" },
      { author: a, published: t, seq: 4, sensitive: 1 },
      { author: a, published: AT + 1, seq: 5 },
      { author: hidden, published: t, seq: 6 },
      { author: unset, published: t, seq: 7 },
      { author: suspended, published: t, seq: 8 },
      { author: blocked, published: t, seq: 9 },
      { author: a, published: t, seq: 10, reblogOf: ok, language: null },
      { author: a, published: t, seq: 11, visibility: "unlisted" },
      { author: a, published: t, seq: 12, publishedAt: "2026-10-20T11:00:00.000+00:00" },
      { author: a, published: t, seq: 13, publishedAt: "2026-10-20T24:00:00.000Z" },
    ]);
    // A whitespace-only warning is no warning once ASCII-trimmed: seq 3 trends.
    expect(await eligible(store)).toEqual([ok, idOf(t, 3), localOk].sort());
    // Exactly now is published; a millisecond later is not.
    await trendStatus(store, { author: a, published: t, seq: 20, publishedAt: new Date(AT).toISOString() });
    expect(await eligible(store)).toContain(idOf(t, 20));
    expect(await eligible(store, AT - 1)).not.toContain(idOf(t, 20));
  });

  it("admits a quote only when its quote and the quoted status may trend", async () => {
    const store = await migratedStore();
    const a = await author(store, "a", { domain: "remote.example" });
    const hidden = await author(store, "h", { domain: "remote.example", discoverable: 0 });
    const gone = await author(store, "g", { domain: "remote.example" });
    await sql(store, "UPDATE accounts SET deleted_at = '2026-10-01T00:00:00.000Z' WHERE id = ?", gone);
    const t = AT - 2 * HOUR;
    const [target, unlisted, sensitive, warned, byHidden, byGone] = await trendStatuses(store, [
      { author: a, published: t, seq: 0 },
      { author: a, published: t, seq: 1, visibility: "unlisted" },
      { author: a, published: t, seq: 2, sensitive: 1 },
      { author: a, published: t, seq: 3, spoiler: "cw" },
      { author: hidden, published: t, seq: 4 },
      { author: gone, published: t, seq: 5 },
    ]);
    const quote = async (seq: number, quoted: string | null, state: string, legacy: number) => {
      const id = await trendStatus(store, { author: a, published: AT - HOUR, seq });
      await sql(
        store,
        `INSERT INTO quotes (status_id, quoted_uri, quoted_status_id, quoted_account_id, state, legacy, updated_at)
				VALUES (?1, ?2, ?3, (SELECT account_id FROM statuses WHERE id = ?3), ?4, ?5, '2026-10-20T00:00:00.000Z')`,
        id,
        state === "deleted" ? null : "https://remote.example/objects/q",
        quoted,
        state,
        legacy,
      );
      return id;
    };
    const passes = [
      await quote(10, target!, "accepted", 1),
      await quote(11, target!, "pending", 0),
      await quote(12, target!, "rejected", 0),
    ];
    const fails = [
      await quote(20, target!, "pending", 1),
      await quote(27, null, "pending", 0),
      await quote(21, null, "deleted", 0),
      await quote(22, unlisted!, "accepted", 0),
      await quote(23, sensitive!, "accepted", 0),
      await quote(24, warned!, "accepted", 0),
      await quote(25, byHidden!, "accepted", 0),
      await quote(26, byGone!, "accepted", 0),
    ];
    const shown = await eligible(store);
    for (const id of passes) {
      expect(shown).toContain(id);
    }
    // Pending with no quoted status yet fails Mastodon's quoted_status.present? too.
    for (const id of fails) {
      expect(shown).not.toContain(id);
    }
  });
});

function idOf(ms: number, seq: number): string {
  return ((BigInt(ms) << 16n) | BigInt(seq)).toString();
}
