import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import { deleteStatusBatch, PURGE_BATCH } from "../src/domain/inbox";
import { sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { cardWorld } from "./card-image-helpers";
import { BUILD, migratedStore } from "./helpers";
import { authors, HOUR, linkPosts, reviewLink, round as trendsRound, trendLinkRows } from "./trend-helpers";
import { encodeWebp } from "./webp-fixtures";

// Link trends across the real step boundaries (docs/engineering.md, "Tests"): a card round and an image round each
// held at its fetch while the trends round commits, and a remote delete's hide committed between a round and a read.

const LINK = "https://news.example/a";
const IMAGE = "https://cdn.example/a.webp";
const HTML = { "content-type": "text/html; charset=utf-8" };
const ARTICLE = `<html lang="en"><head><title>Story</title><meta name="description" content="About it">
	<meta property="og:site_name" content="News"><meta property="og:type" content="article">
	<meta property="og:image" content="${IMAGE}"></head></html>`;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("link trends across steps", () => {
  it("counts a card the round fetched while the trends round committed, at the next round", async () => {
    const w = await cardWorld({ IMAGES_CARD_MONTHLY_TRANSFORMS: "10" });
    w.clock.t = NOW + 2 * HOUR;
    await linkPosts(w.h.store, await authors(w.h.store, 4), LINK, NOW + HOUR);
    const gate = deferred();
    const reached = deferred();
    w.addRoutes({
      [LINK]: async () => {
        reached.resolve();
        await gate.promise;
        return new Response(ARTICLE, { headers: HTML });
      },
    });
    await w.postLink(LINK);
    const running = w.cardRound();
    await reached.promise;
    // The card is still pending: four accounts, no candidate.
    expect(await trendsRound(w.h.store, w.clock.t)).toMatchObject({ links: 0 });
    gate.resolve();
    expect(await running).toMatchObject({ attached: 1 });
    expect(await trendsRound(w.h.store, w.clock.t)).toMatchObject({ links: 1 });
    expect(await trendLinkRows(w.h.store)).toMatchObject([{ url: LINK, score: 16 }]);
  });

  it("admits a link only once the image of its only qualifying copy is stored, the image round held meanwhile", async () => {
    const w = await cardWorld({ IMAGES_CARD_MONTHLY_TRANSFORMS: "10" });
    w.clock.t = NOW + 2 * HOUR;
    // Four copies that never qualify (their images pending), and the local post's, which will.
    await linkPosts(w.h.store, await authors(w.h.store, 4), LINK, NOW + HOUR, { copy: { image: "pending" } });
    const body = await encodeWebp(64, 48);
    const gate = deferred();
    const reached = deferred();
    w.addRoutes({
      [LINK]: () => new Response(ARTICLE, { headers: HTML }),
      [IMAGE]: async () => {
        reached.resolve();
        await gate.promise;
        return new Response(body);
      },
    });
    await w.postLink(LINK);
    expect(await w.cardRound()).toMatchObject({ attached: 1 });
    const running = w.imageRound();
    await reached.promise;
    expect(await trendsRound(w.h.store, w.clock.t)).toMatchObject({ links: 0 });
    gate.resolve();
    expect(await running).toMatchObject({ stored: 1 });
    expect(await trendsRound(w.h.store, w.clock.t)).toMatchObject({ links: 1 });
  });

  it("leaves a status hidden between a round and a read out of the list and its history", async () => {
    const store = await migratedStore();
    const a = await authors(store, 6);
    const at = Date.parse("2026-10-20T12:00:00.000Z");
    const ids = await linkPosts(store, a, LINK, at - 2 * HOUR);
    expect(await trendsRound(store, at)).toMatchObject({ links: 1 });
    await reviewLink(store, "link", LINK, true);
    const list = async () => {
      const page = await store.trendingLinks(BUILD, {
        credential: null,
        offset: 0,
        limit: 10,
        language: "en",
        now: at,
        present: { origin: "https://kopje.test" },
      });
      if (page.status !== "ok") {
        throw new Error("refused");
      }
      return page.value.items.map((item) => ({ url: item.url, uses: item.history[0]!.uses }));
    };
    expect(await list()).toEqual([{ url: LINK, uses: "6" }]);
    // The newest post, its copy the one shown, with more boosts than a batch removes: its batch hides it and stops.
    const newest = ids.at(-1)!;
    await sql(
      store,
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 - 1)
			INSERT INTO accounts (id, uri, username, domain) SELECT CAST(700000000000000000 + i AS TEXT),
				'https://b.example/u' || i, 'b' || i, 'b.example' FROM n`,
      PURGE_BATCH + 10,
    );
    await sql(
      store,
      `INSERT INTO statuses (id, uri, account_id, reblog_of_id, visibility, content, published_at)
			SELECT CAST(800000000000000000 + CAST(substr(id, 2) AS INTEGER) AS TEXT), 'https://b.example/s' || id, id, ?1,
				'unlisted', '', '2026-10-20T11:00:00.000Z'
			FROM accounts WHERE domain = 'b.example'`,
      newest,
    );
    const more = await runInDurableObject(store, (_instance, state) =>
      state.storage.transactionSync(() => deleteStatusBatch(new Db(state.storage.sql), newest, at)),
    );
    expect(more).toBe(true);
    expect(await list()).toEqual([{ url: LINK, uses: "5" }]);
  });
});
