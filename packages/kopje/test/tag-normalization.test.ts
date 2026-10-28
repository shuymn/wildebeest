import { describe, expect, it } from "vitest";

import { hashtagObjectName, normalizeTag } from "../src/domain/tag-name";
import { bearer, sql } from "./api-helpers";
import { mastodonActor, MASTODON } from "./inbox-helpers";
import { create, followed, mastodonNote, setup, statusRow } from "./inbox-status-helpers";
import { act, community, ids, post } from "./status-helpers";

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
