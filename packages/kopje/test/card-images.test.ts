import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { Db } from "../src/db/sql";
import {
  admitCardImage,
  CARD_IMAGE_CLAIM_WALK,
  CARD_IMAGE_EXPIRE_BATCH,
  CARD_IMAGE_EXPIRE_MS,
  CARD_IMAGE_GC_BACKLOG,
  CARD_IMAGE_GC_WALK,
  CARD_IMAGE_HOLD_MS,
  CARD_IMAGE_ROUND_CLAIMS,
  claimCardImages,
  recordCardImage,
  startCardImage,
} from "../src/domain/card-images";
import { CARD_DONOR_CANDIDATES, CARD_FRESH_MS, claimCards, enqueueCard, recordCard } from "../src/domain/link-cards";
import { ORPHAN_GRACE_MS, RECONCILE_BATCH } from "../src/domain/media";
import { sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { cardWorld, type CardWorld, pageWith } from "./card-image-helpers";
import { plannedRun, scansOf, staleStatistics } from "./read-helpers";

// The Store's part of card images (domain/card-images.ts) and the card writers' link to it (domain/link-cards.ts).

const IMAGE = "https://cdn.example/a.png";
const SITE = "https://site.example/a";
const iso = (ms: number) => new Date(ms).toISOString();
const token = (n: number) => `t${String(n).padStart(42, "0")}`;

// A status whose attached card names IMAGE (through a card round), and the card_images row it links.
async function carded(w: CardWorld, url = SITE, image = IMAGE) {
  w.addRoutes({ [url]: pageWith(image, "An image") });
  const id = await w.postLink(url);
  await w.cardRound();
  return { id, card: (await w.card(id))! };
}

// Stored card_images rows `from`..`from + n - 1` (ids 7…, tokens t…), none referenced.
function seedStored(w: CardWorld, from: number, n: number, storedAt = NOW) {
  return sql(
    w.h.store,
    `WITH RECURSIVE n(i) AS (SELECT ?1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1 + ?2 - 1)
		INSERT INTO card_images (id, source_url, enqueued_at, token, width, height, stored_at)
		SELECT printf('7%017d', i), 'https://cdn.example/s/' || i, 1, printf('t%042d', i), 1, 1, ?3 FROM n`,
    from,
    n,
    storedAt,
  );
}

// A link card's fields, without an image.
const FIELDS = {
  title: "Title",
  description: "",
  authorName: "",
  authorUrl: "",
  providerName: "",
  providerUrl: "",
  language: null,
  publishedAt: null,
  type: "link",
  width: 0,
  height: 0,
  embedSrc: "",
  iframeWidth: null,
  iframeHeight: null,
  imageUrl: "",
  imageDescription: "",
  linkType: "unknown",
  finalUrl: "",
} as const;

const claim = (w: CardWorld, tokens: string[], share = 1000) =>
  w.op(claimCardImages, { now: w.clock.t, tokens, share });

describe("the link from a card to its image (recordCard)", () => {
  it("links an attached card to a new pending row, then reuses it for the same URL", async () => {
    const w = await cardWorld();
    const first = await carded(w);
    expect(first.card).toMatchObject({ image_url: IMAGE, image_description: "An image", fetched_at: NOW });
    const [row] = await w.images();
    expect(row).toMatchObject({
      id: first.card.image_id,
      source_url: IMAGE,
      due_at: NOW,
      enqueued_at: NOW,
      attempts: 0,
    });
    // Another page of the same image: the pending row is reused (two seeks, nothing written).
    const second = await carded(w, "https://site.example/b");
    expect(second.card.image_id).toBe(first.card.image_id);
    expect(await w.images()).toHaveLength(1);
  });

  it("reuses a stored image within CARD_FRESH_MS of stored_at, and fetches a new one after (kept while referenced)", async () => {
    const w = await cardWorld();
    const first = await carded(w);
    await sql(
      w.h.store,
      "UPDATE card_images SET due_at = NULL, token = ?2, width = 1, height = 1, stored_at = ?3 WHERE id = ?1",
      first.card.image_id,
      token(1),
      NOW,
    );
    w.clock.t = NOW + CARD_FRESH_MS - 1;
    const fresh = await carded(w, "https://site.example/b");
    expect(fresh.card.image_id).toBe(first.card.image_id);
    w.clock.t = NOW + CARD_FRESH_MS;
    const stale = await carded(w, "https://site.example/c");
    expect(stale.card.image_id).not.toBe(first.card.image_id);
    expect((await w.images()).map((row) => [row.id, row.stored_at === null])).toEqual([
      [first.card.image_id, false],
      [stale.card.image_id, true],
    ]);
  });

  it("keeps no image of a source the strict https rule refuses, and the alt text all the same", async () => {
    const w = await cardWorld();
    for (const [i, refused] of ["http://cdn.example/a.png", "https://cdn.example/a|b.png"].entries()) {
      const { card } = await carded(w, `https://site.example/${i}`, refused);
      expect(card).toMatchObject({ image_url: "", image_id: null, image_description: "An image" });
    }
    expect(await w.images()).toEqual([]);
  });

  it("resets the image at an edit: the old row is then unreferenced and goes to the GC", async () => {
    const w = await cardWorld();
    const { id, card } = await carded(w);
    await runInDurableObject(w.h.store, (_instance, state) =>
      enqueueCard(new Db(state.storage.sql), id, "https://site.example/other", w.clock.t),
    );
    expect(await w.card(id)).toMatchObject({ image_url: "", image_id: null, image_description: "" });
    // The pending row is unreferenced now: the next claim's walk deletes it (C0).
    expect(await claim(w, [token(1)])).toMatchObject({ claims: [], dropped: 1 });
    expect(await w.images()).toEqual([]);
    expect(card.image_id).not.toBeNull();
  });

  it("copies a donor's image link, and fetches again when the donor's image is gone", async () => {
    const w = await cardWorld();
    const first = await carded(w);
    w.clock.t += 1000;
    const copy = await w.postLink(SITE);
    expect(await w.op(claimCards, { now: w.clock.t })).toMatchObject({ claims: [], attached: 1 });
    expect(await w.card(copy)).toMatchObject({ image_url: IMAGE, image_id: first.card.image_id, fetched_at: NOW });
    // The image failed (none deletes the row): a copy that would show none is not a donor; the card is fetched.
    await sql(w.h.store, "DELETE FROM card_images");
    const third = await w.postLink(SITE);
    const claimed = await w.op(claimCards, { now: w.clock.t });
    expect(claimed).toMatchObject({ attached: 0 });
    expect(claimed.claims.map((c) => c.statusId)).toEqual([third]);
  });

  it("copies a donor's stored image only while it is within CARD_FRESH_MS of stored_at (through a copy)", async () => {
    for (const [age, copied] of [
      [13, true],
      [20, false],
    ] as const) {
      const w = await cardWorld();
      const first = await carded(w);
      const day = 24 * 60 * 60 * 1000;
      w.clock.t = NOW + 20 * day;
      // The donor's card is fresh (fetched a week ago); its image was stored `age` days ago.
      await sql(
        w.h.store,
        "UPDATE status_cards SET fetched_at = ?2 WHERE status_id = ?1",
        first.id,
        w.clock.t - 7 * day,
      );
      await sql(
        w.h.store,
        "UPDATE card_images SET due_at = NULL, token = ?2, width = 1, height = 1, stored_at = ?3 WHERE id = ?1",
        first.card.image_id,
        token(1),
        w.clock.t - age * day,
      );
      const copy = await w.postLink(SITE);
      const claimed = await w.op(claimCards, { now: w.clock.t });
      expect(claimed.attached, `${age} days`).toBe(copied ? 1 : 0);
      expect(
        claimed.claims.map((c) => c.statusId),
        `${age} days`,
      ).toEqual(copied ? [] : [copy]);
      expect((await w.card(copy))?.image_id ?? null).toBe(copied ? first.card.image_id : null);
    }
  });

  it(
    "takes at most CARD_DONOR_CANDIDATES donor candidates by the fresh index, past 10,001 dangling copies, after ANALYZE and growth",
    { timeout: 120_000 },
    async () => {
      const w = await cardWorld();
      const first = await carded(w);
      const target = await w.postLink(SITE);
      const donor = /CROSS JOIN status_cards f INDEXED BY/;
      const { before, after } = await staleStatistics(w.h, {
        capture: async () => {
          await sql(
            w.h.store,
            "UPDATE status_cards SET due_at = 0, fetched_at = NULL, attempts = 0, public = 0 WHERE status_id = ?",
            target,
          );
          return (await plannedRun(w.h, donor, claimCards, { now: w.clock.t })).plans;
        },
        grow: async () => {
          await sql(w.h.store, "DELETE FROM card_images");
          await sql(
            w.h.store,
            `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10001)
						INSERT INTO statuses (id, uri, account_id, visibility, content, published_at)
						SELECT printf('9%017d', i), 'https://kopje.test/s/9' || i, ?1, 'public', 'x', '2026-10-12T00:00:00.000Z' FROM n`,
            w.alice.id,
          );
          // 10,001 copies of the URL, fresher than the first, each naming a deleted image.
          await sql(
            w.h.store,
            `INSERT INTO status_cards (status_id, url, enqueued_at, generation, title, fetched_at, image_url, image_id)
						SELECT id, ?1, 0, 1, 't', ?2, ?3, '100000000000000999' FROM statuses WHERE id GLOB '9*'`,
            SITE,
            NOW + 1,
            IMAGE,
          );
        },
      });
      for (const plans of [before, after]) {
        const [lookup] = plans;
        expect(lookup?.query).toContain("status_cards_fresh");
        expect(scansOf(lookup?.plan ?? [], ["status_cards", "t", "f", "i"]), lookup?.plan.join("\n")).toEqual([]);
      }
      // The target row, at most CARD_DONOR_CANDIDATES candidates and their key seeks of card_images.
      expect(after[0]!.rows).toBeLessThanOrEqual(2 + 2 * CARD_DONOR_CANDIDATES);
      expect(CARD_DONOR_CANDIDATES).toBe(8);
      expect(first.card.image_id).not.toBeNull();
    },
  );
});

describe("the seeks of a record and of the walk, after ANALYZE and growth", () => {
  it(
    "reuses a stored and a pending row by its index, and walks the due rows in order, reading a bounded number of rows",
    { timeout: 180_000 },
    async () => {
      const w = await cardWorld();
      const first = await carded(w);
      const { before, after } = await staleStatistics(w.h, {
        capture: async () => {
          // A record whose image URL has a stored row, and one whose URL has only a pending one.
          const id = await w.postLink(`https://site.example/${w.clock.t}`);
          const [c] = (await w.op(claimCards, { now: w.clock.t })).claims;
          const record = (
            await plannedRun(w.h, /card_images i INDEXED BY/, recordCard, {
              statusId: id,
              token: c!.token,
              generation: c!.generation,
              now: w.clock.t,
              outcome: { kind: "card", fields: { ...FIELDS, imageUrl: IMAGE } },
            })
          ).plans;
          const walk = (
            await plannedRun(w.h, /INDEXED BY card_images_due/, claimCardImages, {
              now: w.clock.t,
              tokens: [token(w.clock.t)],
              share: 10,
            })
          ).plans;
          w.clock.t += 1;
          return { record, walk };
        },
        grow: async () => {
          // 100,000 stored rows and 100,000 pending ones of other URLs, and stale stored rows of the same URL.
          await seedStored(w, 1, 100_000);
          await sql(
            w.h.store,
            `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100000)
					INSERT INTO card_images (id, source_url, due_at, enqueued_at) SELECT printf('6%017d', i), 'https://cdn.example/p/' || i, ?1, ?1 FROM n`,
            NOW + 10_000_000,
          );
          await sql(
            w.h.store,
            `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000)
					INSERT INTO card_images (id, source_url, enqueued_at, token, width, height, stored_at)
					SELECT printf('5%017d', i), ?1, 1, printf('s%042d', i), 1, 1, 1 FROM n`,
            IMAGE,
          );
        },
      });
      for (const { record, walk } of [before, after]) {
        for (const { query, plan } of [...record, ...walk]) {
          expect(scansOf(plan, ["card_images", "i", "c", "status_cards"]), `${query}\n${plan.join("\n")}`).toEqual([]);
        }
        // The stored lookup first, then the pending one when it misses, each reading the card row and at most one image
        // row past the stale stored rows of the URL; the walk at most its 64 rows.
        expect(record.length).toBeGreaterThan(0);
        expect(record[0]!.query).toContain("card_images_stored");
        for (const { rows } of record) {
          expect(rows).toBeLessThanOrEqual(2);
        }
        expect(walk[0]!.rows).toBeLessThanOrEqual(CARD_IMAGE_CLAIM_WALK);
      }
      expect(first.card.image_id).not.toBeNull();
    },
  );
});

describe("the claim (claimCardImages)", () => {
  it("claims with one tombstone each, due after the hold and the grace", async () => {
    const w = await cardWorld();
    const { card } = await carded(w);
    const claimed = await claim(w, [token(1), token(2), token(3)]);
    expect(claimed).toMatchObject({
      domain: "kopje.test",
      claims: [{ id: card.image_id, claim: 1, token: token(1), sourceUrl: IMAGE }],
    });
    expect((await w.images())[0]).toMatchObject({ claim: 1, attempts: 1, due_at: NOW + CARD_IMAGE_HOLD_MS });
    expect(await w.orphans()).toEqual([
      { file_token: token(1), media_id: card.image_id, delete_after: iso(NOW + CARD_IMAGE_HOLD_MS + ORPHAN_GRACE_MS) },
    ]);
    // Open: not walked again.
    expect((await claim(w, [token(4)])).claims).toEqual([]);
  });

  it("at a share of 0 expires and collects but claims nothing, and stops claiming at the share", async () => {
    const w = await cardWorld();
    await carded(w);
    await seedStored(w, 1, 3);
    const zero = await claim(w, [token(9)], 0);
    expect(zero).toMatchObject({ claims: [], collected: 3, paused: false });
    expect(await w.images()).toHaveLength(1);
    await sql(
      w.h.store,
      "INSERT INTO kopje_state (name, value) VALUES (?, '5')",
      `images_card_transforms:${iso(w.clock.t).slice(0, 7)}`,
    );
    expect((await claim(w, [token(9)], 5)).claims).toEqual([]);
    expect((await claim(w, [token(9)], 6)).claims).toHaveLength(1);
  });

  it("deletes an unreferenced row, one given up, and one enqueued more than a day ago", async () => {
    const w = await cardWorld();
    const a = await carded(w, "https://site.example/a", "https://cdn.example/a.png");
    const b = await carded(w, "https://site.example/b", "https://cdn.example/b.png");
    const c = await carded(w, "https://site.example/c", "https://cdn.example/c.png");
    await sql(w.h.store, "UPDATE status_cards SET image_url = '', image_id = NULL WHERE status_id = ?", a.id);
    await sql(w.h.store, "UPDATE card_images SET attempts = 2 WHERE id = ?", b.card.image_id);
    await sql(
      w.h.store,
      "UPDATE card_images SET enqueued_at = ?2 WHERE id = ?1",
      c.card.image_id,
      NOW - CARD_IMAGE_EXPIRE_MS - 1,
    );
    // The expiry takes c first; the walk deletes a (unreferenced) and b (given up).
    expect(await claim(w, [token(1)])).toMatchObject({ claims: [], expired: 1, dropped: 2 });
    expect(await w.images()).toEqual([]);
  });

  it.each(["card_images", "media_orphans", "media_attachments"] as const)(
    "C3: claims nothing with a token %s holds, and leaves the row due",
    async (owner) => {
      const w = await cardWorld();
      const { card } = await carded(w);
      const taken = token(5);
      if (owner === "card_images") {
        // Unreferenced, so the claim's GC may move its token to a tombstone first: held either way.
        await seedStored(w, 5, 1);
      } else if (owner === "media_orphans") {
        await sql(
          w.h.store,
          "INSERT INTO media_orphans (file_token, media_id, delete_after) VALUES (?, '100000000000000001', '2099-01-01T00:00:00.000Z')",
          taken,
        );
      } else {
        await sql(
          w.h.store,
          `INSERT INTO media_attachments (id, account_id, type, url, file_token, processed, gc_at, created_at)
					VALUES ('100000000000000001', ?, 'image', '', ?, 1, NULL, '2026-10-12T00:00:00.000Z')`,
          w.alice.id,
          taken,
        );
      }
      expect((await claim(w, [taken])).claims).toEqual([]);
      expect((await w.images()).find((row) => row.id === card.image_id)).toMatchObject({ attempts: 0, due_at: NOW });
      expect((await claim(w, [token(6)])).claims).toHaveLength(1);
    },
  );

  it(
    "walks at most CARD_IMAGE_CLAIM_WALK due rows and expires at most CARD_IMAGE_EXPIRE_BATCH",
    { timeout: 60_000 },
    async () => {
      const w = await cardWorld();
      // Unreferenced pending rows: each walked one is deleted (progress), the 65th left for the next claim.
      await sql(
        w.h.store,
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO card_images (id, source_url, due_at, enqueued_at) SELECT printf('6%017d', i), 'https://cdn.example/p/' || i, 1, ?2 FROM n`,
        CARD_IMAGE_CLAIM_WALK + 1,
        NOW,
      );
      expect(await claim(w, [token(1)])).toMatchObject({ dropped: CARD_IMAGE_CLAIM_WALK });
      expect(await w.images()).toHaveLength(1);
      await sql(w.h.store, "DELETE FROM card_images");
      await sql(
        w.h.store,
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO card_images (id, source_url, due_at, enqueued_at) SELECT printf('6%017d', i), 'https://cdn.example/p/' || i, ?2, 0 FROM n`,
        CARD_IMAGE_EXPIRE_BATCH + 1,
        NOW + 1,
      );
      expect(await claim(w, [token(1)], 0)).toMatchObject({ expired: CARD_IMAGE_EXPIRE_BATCH });
      expect(await w.images()).toHaveLength(1);
      expect(CARD_IMAGE_ROUND_CLAIMS).toBe(3);
    },
  );
});

describe("the image GC with backpressure", () => {
  it("collects at most CARD_IMAGE_GC_WALK unreferenced stored rows a claim, from a cursor that wraps", async () => {
    const w = await cardWorld();
    const { card } = await carded(w);
    await sql(
      w.h.store,
      "UPDATE card_images SET due_at = NULL, token = ?2, width = 1, height = 1, stored_at = ?3 WHERE id = ?1",
      card.image_id,
      token(999),
      NOW,
    );
    await seedStored(w, 1, CARD_IMAGE_GC_WALK + 10);
    // The referenced row's id sorts first: the walk's 64 rows are it and 63 unreferenced ones.
    expect(await claim(w, [], 0)).toMatchObject({ collected: CARD_IMAGE_GC_WALK - 1, paused: false });
    const tombstones = await w.orphans();
    expect(tombstones).toHaveLength(CARD_IMAGE_GC_WALK - 1);
    // Due at once: a stored row has no writer.
    expect(new Set(tombstones.map((t) => t.delete_after))).toEqual(new Set([iso(NOW)]));
    expect(tombstones[0]).toMatchObject({ file_token: token(1), media_id: "700000000000000001" });
    // The rest from the cursor, the referenced row kept; then the cursor wraps.
    await sql(w.h.store, "DELETE FROM media_orphans");
    expect(await claim(w, [], 0)).toMatchObject({ collected: 11 });
    await sql(w.h.store, "DELETE FROM media_orphans");
    expect(await claim(w, [], 0)).toMatchObject({ collected: 0 });
    expect((await w.images()).map((row) => row.id)).toEqual([card.image_id]);
  });

  it("pauses while CARD_IMAGE_GC_BACKLOG tombstones are due, and resumes below it", async () => {
    const w = await cardWorld();
    expect(CARD_IMAGE_GC_BACKLOG).toBe(RECONCILE_BATCH);
    await seedStored(w, 1, 5);
    await sql(
      w.h.store,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO media_orphans (file_token, media_id, delete_after) SELECT printf('u%042d', i), '100000000000000001', ?2 FROM n`,
      CARD_IMAGE_GC_BACKLOG,
      iso(NOW),
    );
    expect(await claim(w, [], 0)).toMatchObject({ collected: 0, paused: true });
    await sql(w.h.store, "DELETE FROM media_orphans WHERE file_token = (SELECT min(file_token) FROM media_orphans)");
    expect(await claim(w, [], 0)).toMatchObject({ collected: 5, paused: false });
  });

  it(
    "reads at most CARD_IMAGE_GC_WALK stored rows past 100,000 pending ones, and at most the backlog of tombstones, after ANALYZE and growth",
    { timeout: 180_000 },
    async () => {
      const w = await cardWorld();
      await seedStored(w, 1, 2);
      const gc = /card_images_stored_id|media_orphans_due/;
      const { before, after } = await staleStatistics(w.h, {
        capture: async () => (await plannedRun(w.h, gc, claimCardImages, { now: NOW, tokens: [], share: 0 })).plans,
        grow: async () => {
          await sql(
            w.h.store,
            `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100000)
						INSERT INTO card_images (id, source_url, due_at, enqueued_at) SELECT printf('6%017d', i), 'https://cdn.example/p/' || i, ?1, ?1 FROM n`,
            NOW + 1,
          );
          await seedStored(w, 10, 1000);
          // More due tombstones than the backlog: the count stops at it. Then fewer, so the GC walks.
          await sql(
            w.h.store,
            `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000)
						INSERT INTO media_orphans (file_token, media_id, delete_after) SELECT printf('u%042d', i), '100000000000000001', ?1 FROM n`,
            iso(NOW + 1),
          );
        },
      });
      for (const plans of [before, after]) {
        for (const { query, plan } of plans) {
          expect(
            scansOf(plan, ["card_images", "i", "media_orphans", "status_cards"]),
            `${query}\n${plan.join("\n")}`,
          ).toEqual([]);
        }
      }
      const walk = after.find(({ query }) => query.includes("card_images_stored_id"))!;
      // The walk's rows and one seek of the link index each.
      expect(walk.rows).toBeLessThanOrEqual(2 * CARD_IMAGE_GC_WALK);
      const backlog = after.find(({ query }) => query.includes("media_orphans_due"))!;
      expect(backlog.rows).toBeLessThanOrEqual(CARD_IMAGE_GC_BACKLOG + 1);
      // Past the backlog the GC reads no stored row.
      await sql(w.h.store, "UPDATE media_orphans SET delete_after = ?", iso(NOW));
      const paused = await plannedRun(w.h, gc, claimCardImages, { now: NOW, tokens: [], share: 0 });
      expect(paused.result.paused).toBe(true);
      expect(paused.plans.filter(({ query }) => query.includes("card_images_stored_id"))).toEqual([]);
      expect(paused.plans[0]!.rows).toBeLessThanOrEqual(CARD_IMAGE_GC_BACKLOG + 1);
    },
  );
});

describe("the fence of a claim (admitCardImage, startCardImage, recordCardImage)", () => {
  async function claimed(w: CardWorld) {
    await carded(w);
    const [c] = (await claim(w, [token(1)])).claims;
    return { id: c!.id, claim: c!.claim, token: c!.token };
  }

  it("admits and starts under the fence, charging the month’s card counter within the share", async () => {
    const w = await cardWorld();
    const fence = await claimed(w);
    expect(await w.op(admitCardImage, fence)).toEqual({ held: true });
    expect(await w.op(startCardImage, { ...fence, share: 1, now: NOW })).toEqual({ status: "ok" });
    expect(await w.op(startCardImage, { ...fence, share: 1, now: NOW })).toEqual({ status: "budget" });
    const [counter] = await sql<{ value: string }>(
      w.h.store,
      "SELECT value FROM kopje_state WHERE name GLOB 'images_card_transforms:*'",
    );
    expect(counter?.value).toBe("1");
    // The upload counter is never charged.
    expect(await sql(w.h.store, "SELECT name FROM kopje_state WHERE name GLOB 'images_transforms:*'")).toEqual([]);
  });

  it("is lost without its tombstone, with another media_id, another claim or a stored row", async () => {
    const w = await cardWorld();
    const fence = await claimed(w);
    for (const lost of [
      { ...fence, claim: fence.claim + 1 },
      { ...fence, token: token(2) },
      { ...fence, id: "100000000000000001" },
    ]) {
      expect(await w.op(admitCardImage, lost)).toEqual({ held: false });
      expect(await w.op(startCardImage, { ...lost, share: 9, now: NOW })).toEqual({ status: "lost" });
      expect(await w.op(recordCardImage, { ...lost, outcome: { kind: "none" }, now: NOW })).toEqual({ held: false });
    }
    await sql(
      w.h.store,
      "UPDATE media_orphans SET media_id = ? WHERE file_token = ?",
      "100000000000000001",
      fence.token,
    );
    expect(await w.op(admitCardImage, fence)).toEqual({ held: false });
  });

  it("records stored (the token moved, the tombstone deleted), none (the row deleted) and unattempted", async () => {
    const w = await cardWorld();
    const fence = await claimed(w);
    expect(await w.op(recordCardImage, { ...fence, outcome: { kind: "unattempted" }, now: NOW + 5 })).toEqual({
      held: true,
    });
    expect((await w.images())[0]).toMatchObject({ due_at: NOW + 5, attempts: 0, claim: 1 });
    w.clock.t = NOW + 10;
    const [again] = (await claim(w, [token(2)])).claims;
    const second = { id: again!.id, claim: again!.claim, token: again!.token };
    const blurhash = "LEHV6nWB2yk8pyo0adR*.7kCMdnj";
    expect(
      await w.op(recordCardImage, {
        ...second,
        outcome: { kind: "stored", width: 743, height: 309, blurhash },
        now: NOW + 20,
      }),
    ).toEqual({ held: true });
    expect((await w.images())[0]).toMatchObject({
      token: token(2),
      width: 743,
      height: 309,
      blurhash,
      stored_at: NOW + 20,
      due_at: null,
      attempts: 0,
    });
    // The first claim's tombstone stays (its put may still land); the second's went with the store.
    expect((await w.orphans()).map((o) => o.file_token)).toEqual([token(1)]);
    // A late record of the stored claim is refused.
    expect(await w.op(recordCardImage, { ...second, outcome: { kind: "none" }, now: NOW + 30 })).toEqual({
      held: false,
    });
  });

  it("drops a blurhash the stored rule refuses, and records none for a size it refuses, keeping the tombstone", async () => {
    const w = await cardWorld();
    const fence = await claimed(w);
    await w.op(recordCardImage, {
      ...fence,
      outcome: { kind: "stored", width: 4, height: 3, blurhash: "not a hash" },
      now: NOW,
    });
    expect((await w.images())[0]).toMatchObject({ blurhash: null, width: 4, stored_at: NOW });
    const other = await cardWorld();
    const f2 = await claimed(other);
    await other.op(recordCardImage, {
      ...f2,
      outcome: { kind: "stored", width: 0, height: 3, blurhash: null },
      now: NOW,
    });
    expect(await other.images()).toEqual([]);
    expect((await other.orphans()).map((o) => o.file_token)).toEqual([f2.token]);
  });
});
