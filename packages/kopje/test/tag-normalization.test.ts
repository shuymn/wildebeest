import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { isHashtagName } from "../src/domain/status-text";
import { hashtagObjectName, normalizeOnce, normalizeTag } from "../src/domain/tag-name";
import { bearer, sql } from "./api-helpers";
import { mastodonActor, MASTODON } from "./inbox-helpers";
import { create, followed, mastodonNote, setup, statusRow } from "./inbox-status-helpers";
import { act, community, ids, post } from "./status-helpers";
import { parseHtml, query } from "./web-dom";

// Hashtag names as Mastodon 4.5 normalizes them (HashtagNormalizer#normalize): spellings Mastodon takes for one tag
// are one hashtag in Kopje, on every path that names one.

describe("normalizeTag", () => {
  it("is HashtagNormalizer#normalize: NFKC, downcase, ASCIIFolding, invalid characters dropped", () => {
    expect(["Café", "cafe", "CAFÉ", "café", "cafe\u0301"].map(normalizeTag)).toEqual(Array(5).fill("cafe"));
    expect(normalizeTag("BLÅHAJ")).toBe("blahaj");
    // İ downcases to i and a combining dot above, which no hashtag holds.
    expect(normalizeTag("İstanbul")).toBe("istanbul");
    // String#downcase maps each code point alone: no final sigma.
    expect(normalizeTag("ΟΔΟΣ")).toBe("οδοσ");
    expect(normalizeTag("οδος")).toBe("οδος");
    // Only the table's letters fold: a Japanese voiced kana stays, a letter outside the table keeps its mark.
    expect(normalizeTag("ガ")).toBe("ガ");
    expect(normalizeTag("ｶﾞ")).toBe("ガ");
    expect(normalizeTag("ǎ")).toBe("ǎ");
    expect(normalizeTag("ŀa")).toBe("l·a");
    // Number signs (fullwidth and small ones after NFKC), spaces and punctuation go; separators, Thai marks, letters
    // and digits of other scripts stay.
    expect(normalizeTag("＃Ｆｕｌｌ")).toBe("full");
    expect(normalizeTag("a b-c.d")).toBe("abcd");
    expect(normalizeTag("a_b\u00B7c\u30FBd\u200Ce")).toBe("a_b\u00B7c\u30FBd\u200Ce");
    expect(normalizeTag("ไทย\u0E47\u0E48")).toBe("ไทย\u0E47\u0E48");
    expect(normalizeTag("٣x०")).toBe("٣x०");
    expect(normalizeTag("a\u0300")).toBe("a");
    expect(normalizeTag("q\u0301")).toBe("q");
    expect(normalizeTag("\u0301")).toBe("");
    expect(hashtagObjectName("#Café")).toBe("cafe");
    expect(hashtagObjectName("##Double")).toBe("double");
  });
});

// Names whose single pass is no fixed point (#1257): a character dropped, or marks sorted, leave two that compose. Each
// with the key normalizeTag gives it.
const FIXED_POINTS: [string, string][] = [
  ["\u1100\u0301\u1161", "\uAC00"],
  ["\u1100-\u1161-\u11A8", "\uAC01"],
  ["\u0391\u0301\u0345", "\u1FB4"],
  ["\u03B1-\u0345", "\u1FB3"],
  ["\u03B1\u05B0\u0345", "\u1FB3\u05B0"],
  ["\u0627\u0301\u0653", "\u0622"],
  ["\u09C7\u0F39\u09BE", "\u09CB"],
  ["\u00C0\u0345-\u05B0", "a\u05B0\u0345"],
  // Every character eligible, and still not NFC: the second pass composes L V and leaves U+0345 T U+0345.
  ["\u1100\u1161\u0345\u11A8\u0345", "\uAC00\u0345\u11A8\u0345"],
  [`${"a".repeat(255)}\u1100\u0301\u1161`, `${"a".repeat(255)}\uAC00`],
];

// Characters NFC composes or reorders after a pass drops what stood between them, separators a pass drops, and
// capitals: Hangul jamo; Greek vowels and the marks they take with U+0345; alef, waw, yeh and heh with U+0653 to
// U+0655; Indic and Myanmar vowels of two parts; Alphabetic marks with a class (Hebrew points, Arabic harakat, Thai,
// Tibetan and Telugu vowel signs); -, space, U+0301, U+0F39 and U+200D; capitals.
const TARGETED = [
  ...range(0x1100, 0x1112),
  ...range(0x1161, 0x1175),
  ...range(0x11a8, 0x11c2),
  ...range(0x5b0, 0x5bd),
  ...range(0x64b, 0x657),
  ...codes("\uAC00\u0391\u03B1\u0395\u03B5\u0397\u03B7\u0399\u03B9\u039F\u03BF\u03A5\u03C5\u03A9\u03C9"),
  ...codes("\u0301\u0308\u0313\u0314\u0342\u0345\u0627\u0648\u064A\u06C1\u06D2\u06D5\u0653\u0654\u0655"),
  ...codes("\u09C7\u09BE\u09D7\u0B47\u0B3E\u0B56\u0B57\u0BC6\u0BC7\u0BBE\u0BD7\u1025\u102E"),
  ...codes("\u0E38\u0E39\u0F71\u0F72\u0F74\u0F7A\u0F80\u0C55\u0C56- \u0F39\u200DAa\u00C0\u00E0\u0130"),
];

function range(first: number, last: number): number[] {
  return Array.from({ length: last - first + 1 }, (_, i) => first + i);
}

function codes(text: string): number[] {
  return [...text].map((c) => c.codePointAt(0)!);
}

describe("normalizeTag is a fixed point (#1257)", () => {
  it.each(FIXED_POINTS)("names %j by its fixed point", (input, key) => {
    expect([normalizeTag(input), normalizeTag(key), normalizeTag(normalizeOnce(input))]).toEqual([key, key, key]);
  });

  it("names the single pass's key by the same key, unlike the single pass", () => {
    const once = normalizeOnce("\u1100\u0301\u1161");
    expect(once).toBe("\u1100\u1161");
    expect(normalizeOnce(once)).not.toBe(once);
    expect([...normalizeTag(`${"a".repeat(255)}\u1100\u0301\u1161`)]).toHaveLength(256);
  });

  it("gives its own key back for any text", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 64 }), (text) => {
        const key = normalizeTag(text);
        return normalizeTag(key) === key;
      }),
      { numRuns: 20_000 },
    );
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...TARGETED), { maxLength: 12 }), (cps) => {
        const key = normalizeTag(String.fromCodePoint(...cps));
        return normalizeTag(key) === key;
      }),
      { numRuns: 50_000 },
    );
  }, 60_000);

  it("keeps Mastodon's key wherever Mastodon's single pass is already a fixed point", () => {
    let stable = 0;
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ unit: "binary", maxLength: 32 }),
          fc.array(fc.constantFrom(...TARGETED)).map((cps) => String.fromCodePoint(...cps)),
        ),
        (text) => {
          const once = normalizeOnce(text);
          if (normalizeOnce(once) !== once) {
            return true;
          }
          stable++;
          return normalizeTag(text) === once;
        },
      ),
      { numRuns: 20_000 },
    );
    expect(stable).toBeGreaterThan(10_000);
  }, 60_000);

  it("reaches a hashtag posted under each spelling by its follow, timeline, page and search", async () => {
    const h = await community(["alice", "bob"]);
    const { alice, bob } = h.users;
    for (const [input, key] of FIXED_POINTS) {
      const once = normalizeOnce(input);
      // A follow named by the single pass's key, as a link another server made names it.
      expect((await act(h, alice, `/api/v1/tags/${encodeURIComponent(once)}/follow`)).status, input).toBe(200);
      const spellings = [once, ...(isHashtagName(input) ? [input] : [])];
      const posted: string[] = [];
      for (const spelling of spellings) {
        posted.unshift((await post(h, bob, { status: `#${spelling}` })).id);
      }
      const names = await sql(
        h.store,
        "SELECT DISTINCT name FROM status_tags WHERE status_id IN (SELECT value FROM json_each(?))",
        JSON.stringify(posted),
      );
      expect(names, input).toEqual([{ name: key }]);
      for (const name of [key, once]) {
        expect(await ids(h, `/api/v1/timelines/tag/${encodeURIComponent(name)}`), input).toEqual(posted);
        const page = await h.request(`/tags/${encodeURIComponent(name)}`);
        expect([input, page.status, query(parseHtml(await page.text()), "article").length]).toEqual([
          input,
          200,
          posted.length,
        ]);
        const response = await h.request(
          `/api/v2/search?q=${encodeURIComponent(name)}&type=hashtags`,
          bearer(alice.token),
        );
        const { hashtags } = await response.json<{ hashtags: { name: string }[] }>();
        expect(
          hashtags.map((tag) => tag.name),
          input,
        ).toContain(key);
      }
      expect((await ids(h, "/api/v1/timelines/home", alice.token)).slice(0, posted.length), input).toEqual(posted);
      await act(h, alice, `/api/v1/tags/${encodeURIComponent(key)}/unfollow`);
    }
    expect(await sql(h.store, "SELECT count(*) AS n FROM tag_follows")).toEqual([{ n: 0 }]);
  }, 60_000);
});

describe("one hashtag for the spellings Mastodon takes as one", () => {
  it("lists a local #Café on the #cafe timeline and a #cafe one on the #Café timeline, linked to /tags/cafe", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const accented = await post(h, alice, { status: "coffee at #Café" });
    const plain = await post(h, alice, { status: "coffee at #cafe" });
    expect(accented.content).toContain('<a href="https://kopje.test/tags/cafe" class="mention hashtag" rel="tag">');
    expect(accented.content).toContain("#<span>Café</span></a>");
    expect(await ids(h, "/api/v1/timelines/tag/cafe")).toEqual([plain.id, accented.id]);
    expect(await ids(h, `/api/v1/timelines/tag/${encodeURIComponent("Café")}`)).toEqual([plain.id, accented.id]);
    expect(await sql(h.store, "SELECT DISTINCT name FROM status_tags")).toEqual([{ name: "cafe" }]);
  });

  it("shows a #cafe status in the home of an account that follows #café", async () => {
    const h = await community(["alice", "bob"]);
    const { alice, bob } = h.users;
    const followed = await act(h, alice, `/api/v1/tags/${encodeURIComponent("café")}/follow`);
    expect(followed.status).toBe(200);
    expect(await followed.json()).toMatchObject({ name: "cafe", following: true });
    const status = await post(h, bob, { status: "open late #cafe" });
    expect(await ids(h, "/api/v1/timelines/home", alice.token)).toEqual([status.id]);
    // Following another spelling changes nothing.
    expect((await act(h, alice, "/api/v1/tags/CAFE/follow")).status).toBe(200);
    expect(await sql(h.store, "SELECT name FROM tag_follows")).toEqual([{ name: "cafe" }]);
  });

  it("refuses to feature blahaj once BLÅHAJ is featured, as the same tag (CreateFeaturedTagService)", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    expect((await act(h, alice, "/api/v1/featured_tags", { name: "BLÅHAJ" })).status).toBe(200);
    const taken = await act(h, alice, "/api/v1/featured_tags", { name: "blahaj" });
    expect([taken.status, await taken.json()]).toEqual([
      422,
      { error: "Validation failed: Tag has already been taken" },
    ]);
    expect(await sql(h.store, "SELECT name, display_name FROM featured_tags")).toEqual([
      { name: "blahaj", display_name: "BLÅHAJ" },
    ]);
  });

  it("finds the hashtag of a #Café status when searching for cafe", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    await post(h, alice, { status: "coffee at #Café" });
    for (const q of ["cafe", "Café", "#CAFÉ", "caf"]) {
      const response = await h.request(`/api/v2/search?q=${encodeURIComponent(q)}&type=hashtags`, bearer(alice.token));
      const { hashtags } = await response.json<{ hashtags: { name: string }[] }>();
      expect(
        hashtags.map((tag) => tag.name),
        q,
      ).toEqual(["cafe"]);
    }
  });

  it('stores a received Hashtag "#Café" as cafe, and drops one that leaves no name', async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    await followed(t, bob);
    const note = mastodonNote(bob, {
      tag: [
        { type: "Hashtag", href: `${MASTODON}/tags/cafe`, name: "#Café" },
        { type: "Hashtag", href: `${MASTODON}/tags/cafe`, name: "#cafe" },
        { type: "Hashtag", name: "#\u0301" },
      ],
    });
    expect(await t.post(bob, create(bob, note))).toBe(202);
    const row = (await statusRow(t.store, note.id))!;
    expect(await sql(t.store, "SELECT name FROM status_tags WHERE status_id = ?", row.id)).toEqual([{ name: "cafe" }]);
  });

  it("takes a hashtag in status text that normalizes to nothing as text, and a name of one as not found", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const status = await post(h, alice, { status: "mark #\u0301 here" });
    expect(status.content).toBe("<p>mark #\u0301 here</p>");
    expect(await sql(h.store, "SELECT name FROM status_tags")).toEqual([]);
    const name = encodeURIComponent("\u0301");
    expect((await act(h, alice, `/api/v1/tags/${name}/follow`)).status).toBe(404);
    const featured = await act(h, alice, "/api/v1/featured_tags", { name: "\u0301" });
    expect([featured.status, await featured.json()]).toEqual([422, { error: "Validation failed: Name is invalid" }]);
  });
});
