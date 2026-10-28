import { describe, expect, it } from "vitest";

import { emojiSnapshot, presentEmojis, shortcodesIn } from "../src/domain/custom-emojis";
import { emojiCandidates } from "../src/federation/remote-emoji";
import {
  ACCOUNT_EMOJIS_BYTES,
  emojisValid,
  MAX_EMOJI_TAGS,
  MAX_EMOJIS,
  STATUS_EMOJIS_BYTES,
} from "../src/platform/stored-bounds";
import { sql } from "./api-helpers";
import { accountAtCap, customEmoji, emojiUrl, maximalEntry, shortcode, statusAtCap } from "./emoji-fixtures";
import { MASTODON, mastodonActor, MISSKEY, MISSKEY_CONTEXT, misskeyActor, type TestActor } from "./inbox-helpers";
import {
  announce,
  AS,
  create,
  followed,
  mastodonNote,
  misskeyNote,
  type Note,
  setup,
  type Setup,
  update,
} from "./inbox-status-helpers";

// Remote custom emoji (RES-2, HTML-3): Emoji tags of remote Notes, Questions and actors, end to end through the inbox,
// the Store's snapshot columns and their triggers, and the Status, Poll, StatusEdit and Account entities.

type Emoji = { shortcode: string; url: string; static_url: string; visible_in_picker: boolean };
type Shown = {
  id: string;
  emojis: Emoji[];
  account: { emojis: Emoji[] };
  reblog: Shown | null;
  poll: { id: string; emojis: Emoji[] } | null;
  edited_at: string | null;
};

const entity = (shortcode: string, url: string): Emoji => customEmoji(shortcode, url);

// A Mastodon Emoji tag (ActivityPub::NoteSerializer, CustomEmojiSerializer).
const mastodonEmoji = (
  name: string,
  url = `${MASTODON}/system/custom_emojis/images/000/000/001/original/${name}.png`,
) => ({
  id: `${MASTODON}/emojis/${name}`,
  type: "Emoji",
  name: `:${name}:`,
  updated: "2026-10-01T00:00:00Z",
  icon: { type: "Image", mediaType: "image/png", url },
});

// A Misskey Emoji tag (ApRendererService#renderEmoji).
const misskeyEmoji = (name: string, url = `${MISSKEY}/files/${name}.webp`) => ({
  id: `${MISSKEY}/emojis/${name}`,
  type: "Emoji",
  name: `:${name}:`,
  updated: "2026-10-01T00:00:00.000Z",
  icon: { type: "Image", mediaType: "image/webp", url },
  _misskey_license: { freeText: null },
});

async function stored(t: Setup, actor: TestActor, note: Note): Promise<Shown> {
  expect(await t.post(actor, create(actor, note))).toBe(202);
  const [row] = await sql<{ id: string }>(t.store, "SELECT id FROM statuses WHERE uri = ?", note.id);
  const { status, body } = await t.api<Shown>(`/api/v1/statuses/${row!.id}`);
  expect(status).toBe(200);
  return body;
}

describe("remote custom emoji on statuses", () => {
  it("shows the emoji a Mastodon-shaped Note tags and references, and drops an unused one", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    await followed(t, bob);
    const shown = await stored(
      t,
      bob,
      mastodonNote(bob, {
        content: "<p>hi :blobcat: and :blob_fox:</p>",
        tag: [mastodonEmoji("blobcat"), mastodonEmoji("unused"), mastodonEmoji("blob_fox")],
      }),
    );
    expect(shown.emojis).toEqual([
      entity("blobcat", `${MASTODON}/system/custom_emojis/images/000/000/001/original/blobcat.png`),
      entity("blob_fox", `${MASTODON}/system/custom_emojis/images/000/000/001/original/blob_fox.png`),
    ]);
  });

  it("shows a Misskey-shaped Note’s emoji, an icon given as an array tolerated, in tag order", async () => {
    const t = await setup();
    const neko = await misskeyActor(t.web, "9abcdefghi", "neko");
    await followed(t, neko);
    const listed = { ...misskeyEmoji("nyan"), icon: [misskeyEmoji("nyan").icon] };
    const shown = await stored(
      t,
      neko,
      misskeyNote(neko, {
        content: "<p><span>:nyan::petthex: にゃ</span></p>",
        _misskey_content: ":nyan::petthex: にゃ",
        tag: [misskeyEmoji("petthex"), listed],
      }),
    );
    expect(shown.emojis).toEqual([
      entity("petthex", `${MISSKEY}/files/petthex.webp`),
      entity("nyan", `${MISSKEY}/files/nyan.webp`),
    ]);
  });

  it("keeps the first valid tag of a name, examines 64 tags only, and stops at the first that does not fit", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    await followed(t, bob);
    // An invalid first tag of a name does not block a valid later one.
    const second = await stored(
      t,
      bob,
      mastodonNote(bob, {
        content: "<p>:a:</p>",
        tag: [mastodonEmoji("a", "ftp://m.example/a.png"), mastodonEmoji("a", "https://m.example/a2.png")],
      }),
    );
    expect(second.emojis).toEqual([entity("a", "https://m.example/a2.png")]);
    // 64 rejected tags, then a valid 65th: none kept.
    const rejected = Array.from({ length: MAX_EMOJI_TAGS }, (_, i) => mastodonEmoji(`r${i}`, "javascript:alert(1)"));
    const late = await stored(
      t,
      bob,
      mastodonNote(bob, {
        content: "<p>:ok:</p>",
        tag: [...rejected, mastodonEmoji("ok", "https://m.example/ok.png")],
      }),
    );
    expect(late.emojis).toEqual([]);
    // Ten maximal entries take 12,191 bytes: an eleventh does not fit, and a smaller one after it is not kept either.
    const entries = Array.from({ length: 12 }, (_, i) => maximalEntry(i));
    entries[11] = ["small", "http://a/s"];
    const misfit = await stored(
      t,
      bob,
      mastodonNote(bob, {
        content: `<p>${entries.map(([name]) => `:${name}:`).join(" ")}</p>`,
        tag: entries.map(([name, url]) => mastodonEmoji(name, url)),
      }),
    );
    expect(misfit.emojis.map((emoji) => emoji.shortcode)).toEqual(entries.slice(0, 10).map(([name]) => name));
  });

  it("reads references in each text alone, and keeps both names of :aa:bb: unlike Mastodon", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    await followed(t, bob);
    const shown = await stored(
      t,
      bob,
      mastodonNote(bob, {
        summary: "cw :ab",
        content: "<p>: rest :aa:bb:</p>",
        tag: ["ab", "aa", "bb"].map((name) => mastodonEmoji(name)),
      }),
    );
    expect(shown.emojis.map((emoji) => emoji.shortcode)).toEqual(["aa", "bb"]);
    expect(shortcodesIn(["x:ab", ":y"])).toEqual(new Set());
    expect(shortcodesIn([":aa:bb:"])).toEqual(new Set(["aa", "bb"]));
  });

  it("shows a Question's emoji, and its poll the subset its choices reference, alone too", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    await followed(t, bob);
    const shown = await stored(
      t,
      bob,
      mastodonNote(bob, {
        type: "Question",
        content: "<p>which :q:</p>",
        endTime: "2026-10-20T12:00:00Z",
        oneOf: [
          { type: "Note", name: ":yes: yes", replies: { type: "Collection", totalItems: 0 } },
          { type: "Note", name: "no", replies: { type: "Collection", totalItems: 0 } },
        ],
        tag: [mastodonEmoji("q"), mastodonEmoji("yes")],
      }),
    );
    expect(shown.emojis.map((emoji) => emoji.shortcode)).toEqual(["q", "yes"]);
    expect(shown.poll!.emojis.map((emoji) => emoji.shortcode)).toEqual(["yes"]);
    const alone = await t.api<{ emojis: Emoji[] }>(`/api/v1/polls/${shown.poll!.id}`);
    expect(alone.body.emojis).toEqual(shown.poll!.emojis);
  });

  it("replaces the snapshot on a newer Update, keeps each version’s in the history, and ignores a forged one", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    await followed(t, bob);
    const note = mastodonNote(bob, { content: "<p>:one:</p>", tag: [mastodonEmoji("one")] });
    const first = await stored(t, bob, note);
    // A change of the emoji alone: no history entry and no edited_at.
    const recolored = { ...note, tag: [mastodonEmoji("one", "https://m.example/one-2.png")] };
    expect(await t.post(bob, update(bob, recolored, "2026-10-11T12:10:00Z"))).toBe(202);
    const still = await t.api<Shown>(`/api/v1/statuses/${first.id}`);
    expect(still.body).toMatchObject({ edited_at: null, emojis: [entity("one", "https://m.example/one-2.png")] });
    expect(await sql(t.store, "SELECT count(*) AS n FROM status_edits")).toEqual([{ n: 0 }]);
    const edited = { ...note, content: "<p>:two:</p>", tag: [mastodonEmoji("two")] };
    expect(await t.post(bob, update(bob, edited, "2026-10-11T12:20:00Z"))).toBe(202);
    // A stale Update changes nothing.
    expect(await t.post(bob, update(bob, recolored, "2026-10-11T12:15:00Z"))).toBe(202);
    // Another actor's Update of bob's status changes nothing.
    const mallory = await mastodonActor(t.web, "mallory", { key: 2 });
    const forged = { ...note, content: "<p>:evil:</p>", tag: [mastodonEmoji("evil")] };
    await t.post(mallory, { ...update(bob, forged, "2026-10-11T12:30:00Z"), actor: mallory.uri });
    const now = await t.api<Shown>(`/api/v1/statuses/${first.id}`);
    expect(now.body.emojis.map((emoji) => emoji.shortcode)).toEqual(["two"]);
    const history = await t.api<{ emojis: Emoji[] }[]>(`/api/v1/statuses/${first.id}/history`);
    expect(history.body.map((version) => version.emojis.map((emoji) => emoji.url))).toEqual([
      ["https://m.example/one-2.png"],
      [`${MASTODON}/system/custom_emojis/images/000/000/001/original/two.png`],
    ]);
  });

  it("takes no emoji from an embedded quote of another author, and shows a boost with none of its own", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    const carol = await mastodonActor(t.web, "carol", { key: 2 });
    await followed(t, bob);
    await followed(t, carol);
    const quoted = await stored(
      t,
      carol,
      mastodonNote(carol, { content: "<p>:mine:</p>", tag: [mastodonEmoji("mine")] }),
    );
    const [quotedRow] = await sql<{ uri: string }>(t.store, "SELECT uri FROM statuses WHERE id = ?", quoted.id);
    const embedded = mastodonNote(carol, {
      id: quotedRow!.uri,
      content: "<p>:forged:</p>",
      tag: [mastodonEmoji("forged")],
    });
    await stored(t, bob, mastodonNote(bob, { content: "<p>quote</p>", quote: embedded }));
    expect((await t.api<Shown>(`/api/v1/statuses/${quoted.id}`)).body.emojis.map((e) => e.shortcode)).toEqual(["mine"]);
    expect(await t.post(bob, announce(bob, quotedRow!.uri))).toBe(202);
    const [boost] = await sql<{ id: string; emojis: string | null }>(
      t.store,
      "SELECT id, emojis FROM statuses WHERE reblog_of_id = ?",
      quoted.id,
    );
    expect(boost!.emojis).toBeNull();
    const shown = await t.api<Shown>(`/api/v1/statuses/${boost!.id}`);
    expect(shown.body.emojis).toEqual([]);
    expect(shown.body.reblog!.emojis.map((e) => e.shortcode)).toEqual(["mine"]);
  });

  it("drops what the trigger would refuse and still stores the status", async () => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    await followed(t, bob);
    const shown = await stored(
      t,
      bob,
      mastodonNote(bob, {
        content: "<p>:bs: :dq: :big: :ok:</p>",
        tag: [
          mastodonEmoji("bs", "https://m.example/e.png?a\\b"),
          mastodonEmoji("dq", 'https://m"x.example/e.png'),
          // 170 '{' grow to 510 bytes percent-encoded: past 512 once normalized.
          mastodonEmoji("big", `https://m.example/${"{".repeat(170)}.png`),
          mastodonEmoji("ok", "https://M.EXAMPLE:443/./ok.png"),
        ],
      }),
    );
    expect(shown.emojis).toEqual([entity("ok", "https://m.example/ok.png")]);
  });
});

describe("remote custom emoji on accounts", () => {
  type ShownAccount = { emojis: Emoji[]; display_name: string; suspended?: true };

  it("shows the emoji the name, bio and presented fields reference, and replaces them on Update(Person)", async () => {
    const t = await setup();
    const neko = await misskeyActor(t.web, "9abcdefghi", "neko", {
      extra: {
        name: "みすきー :cat:",
        summary: "<p>:bio:</p>",
        attachment: [{ type: "PropertyValue", name: ":field:", value: ":value:" }],
        tag: ["cat", "bio", "field", "value", "unused"].map((name) => misskeyEmoji(name)),
      },
    });
    const id = await followed(t, neko);
    const before = await t.api<ShownAccount>(`/api/v1/accounts/${id}`);
    expect(before.body.emojis.map((e) => e.shortcode)).toEqual(["cat", "bio", "field", "value"]);
    const updated = { ...neko.document, name: "ねこ :dog:", tag: [misskeyEmoji("dog")] };
    t.web.serve(neko.uri, updated);
    const activity = {
      "@context": MISSKEY_CONTEXT,
      type: "Update",
      id: `${MISSKEY}/9upd`,
      actor: neko.uri,
      object: updated,
      to: [`${AS}#Public`],
    };
    expect(await t.post(neko, activity)).toBe(202);
    const after = await t.api<ShownAccount>(`/api/v1/accounts/${id}`);
    expect(after.body.emojis).toEqual([entity("dog", `${MISSKEY}/files/dog.webp`)]);
    // A suspended account shows none, as Mastodon's AccountSerializer#emojis.
    await sql(
      t.store,
      "UPDATE accounts SET suspended_at = '2026-10-11T00:00:00.000Z', suspension_source = 'account' WHERE id = ?",
      id,
    );
    const suspended = await t.api<ShownAccount>(`/api/v1/accounts/${id}`);
    expect(suspended.body).toMatchObject({ suspended: true, emojis: [] });
  });

  it("scans the fields as presented: after the aggregate cut, sanitizer growth and the UTF-16 cut", async () => {
    const t = await setup();
    const field = (name: string, value: string) => ({ type: "PropertyValue", name, value });
    const accounts = {
      // The SQL projection keeps the leading fields within 32 KiB of JSON: the ninth is not read.
      aggregate: Array.from({ length: 9 }, (_, i) => field(i === 8 ? ":far:" : `f${i} :near:`, "y".repeat(4000))),
      // Sanitizing writes '&' as '&amp;': the second field passes 32 KiB as presented and is left out.
      sanitized: [field("a :near:", "&".repeat(4096)), field(":far:", "&".repeat(4096))],
      // 131 code points, 257 code units: read whole by SQL, then cut at 255 code units before the reference ends.
      astral: [field(`${"😀".repeat(126)}:far:`, "v"), field(":near:", "v")],
    };
    for (const [name, attachment] of Object.entries(accounts)) {
      const actor = await mastodonActor(t.web, name, {
        extra: { attachment, tag: ["near", "far"].map((code) => mastodonEmoji(code)) },
      });
      const id = await followed(t, actor);
      const shown = await t.api<{ emojis: Emoji[]; fields: { name: string }[] }>(`/api/v1/accounts/${id}`);
      expect([name, shown.body.emojis.map((e) => e.shortcode)]).toEqual([name, ["near"]]);
      expect(shown.body.fields.length).toBe({ aggregate: 8, sanitized: 1, astral: 2 }[name]);
    }
  });
});

// The writer at each presented bound and one byte past it, through the inbox and the real triggers: at the bound
// every entry is stored and shown; one byte past it, the last entry is left out and the write still succeeds.
describe("snapshots at their bounds through ingestion (RES-2)", () => {
  const references = (pairs: [string, string][]) => pairs.map(([name]) => `:${name}:`).join(" ");
  const tags = (pairs: [string, string][]) => pairs.map(([name, url]) => mastodonEmoji(name, url));

  it.each([
    ["at 12,288 bytes", false],
    ["one byte past", true],
  ])("keeps a status snapshot %s", async (_name, over) => {
    const t = await setup();
    const bob = await mastodonActor(t.web, "bob");
    await followed(t, bob);
    const pairs = statusAtCap(over);
    const shown = await stored(t, bob, mastodonNote(bob, { content: `<p>${references(pairs)}</p>`, tag: tags(pairs) }));
    const kept = over ? pairs.slice(0, -1) : pairs;
    const [row] = await sql<{ emojis: string }>(t.store, "SELECT emojis FROM statuses WHERE id = ?", shown.id);
    expect(row!.emojis).toBe(JSON.stringify(kept));
    expect(new TextEncoder().encode(JSON.stringify(shown.emojis)).length).toBe(over ? 12_288 - 97 : 12_288);
    expect(shown.emojis.map((e) => e.shortcode)).toEqual(kept.map(([name]) => name));
  });

  it.each([
    ["at 6,144 bytes", false],
    ["one byte past", true],
  ])("keeps an account snapshot %s", async (_name, over) => {
    const t = await setup();
    const pairs = accountAtCap(over);
    const bob = await mastodonActor(t.web, "bob", {
      extra: { summary: `<p>${references(pairs)}</p>`, tag: tags(pairs) },
    });
    const id = await followed(t, bob);
    const kept = over ? pairs.slice(0, -1) : pairs;
    const [row] = await sql<{ emojis: string }>(t.store, "SELECT emojis FROM accounts WHERE id = ?", id);
    expect(row!.emojis).toBe(JSON.stringify(kept));
    const shown = await t.api<{ emojis: Emoji[] }>(`/api/v1/accounts/${id}`);
    expect(new TextEncoder().encode(JSON.stringify(shown.body.emojis)).length).toBe(over ? 6_144 + 1 - 86 : 6_144);
  });
});

describe("the snapshot writer and presenter (RES-2, HTML-3)", () => {
  const candidates = (n: number) => Array.from({ length: n }, (_, i) => maximalEntry(i));

  it("keeps typical emoji whole: 40 Mastodon-shaped per status and 20 per profile", () => {
    const url = (i: number) =>
      `https://mastodon.example/system/custom_emojis/images/000/123/${String(456 + i)}/original/${"0123456789abcdef"}.png`;
    const tags = Array.from({ length: 40 }, (_, i) => ({ shortcode: shortcode(16, i), url: url(i) }));
    const texts = [tags.map((tag) => `:${tag.shortcode}:`).join(" ")];
    expect(JSON.parse(emojiSnapshot(tags, texts, STATUS_EMOJIS_BYTES)!)).toHaveLength(40);
    expect(JSON.parse(emojiSnapshot(tags.slice(0, 20), texts, ACCOUNT_EMOJIS_BYTES)!)).toHaveLength(20);
  });

  it("writes only what the trigger accepts, at every bound", () => {
    for (const [n, bytes] of [
      [11, STATUS_EMOJIS_BYTES],
      [6, ACCOUNT_EMOJIS_BYTES],
    ] as const) {
      const tags = candidates(n).map(([name, url]) => ({ shortcode: name, url }));
      const text = tags.map((tag) => `:${tag.shortcode}:`).join("");
      const written = emojiSnapshot(tags, [text], bytes)!;
      expect(emojisValid(written, bytes)).toBe(true);
      expect(presentEmojis(written, bytes)).toHaveLength(bytes === STATUS_EMOJIS_BYTES ? 10 : 5);
    }
    const many = Array.from({ length: MAX_EMOJIS + 1 }, (_, i) => ({ shortcode: shortcode(2, i), url: "http://a/" }));
    const written = emojiSnapshot(many, [many.map((tag) => `:${tag.shortcode}:`).join("")], STATUS_EMOJIS_BYTES)!;
    expect(JSON.parse(written)).toHaveLength(MAX_EMOJIS);
    expect(emojisValid(written, STATUS_EMOJIS_BYTES)).toBe(true);
    expect(emojiSnapshot(many, ["no references"], STATUS_EMOJIS_BYTES)).toBeNull();
  });

  it("normalizes stored urls again, drops one that does not pass, and cuts at the presented bound", () => {
    const imported = JSON.stringify([
      ["grows", `https://m.example/${"{".repeat(170)}`],
      ["host", "https://M.EXAMPLE:443/./h.png"],
      ["ok", "http://a/"],
    ]);
    expect(emojisValid(imported, STATUS_EMOJIS_BYTES)).toBe(true);
    expect(presentEmojis(imported, STATUS_EMOJIS_BYTES)).toEqual([
      entity("host", "https://m.example/h.png"),
      entity("ok", "http://a/"),
    ]);
    // Normalization may grow an imported url: the entry that no longer fits ends the list.
    // 'http://a/{' is stored in 10 bytes and presented as 'http://a/%7B' in 12.
    const tight = JSON.stringify([
      ["a", emojiUrl(500)],
      ["b", "http://a/{"],
    ]);
    const fits = 1 + (67 + 1 + 2 * 500) + (67 + 1 + 2 * 12);
    expect(presentEmojis(tight, fits - 1)).toEqual([entity("a", emojiUrl(500))]);
    expect(presentEmojis(tight, fits)).toEqual([entity("a", emojiUrl(500)), entity("b", "http://a/%7B")]);
  });

  // A stored value the triggers refuse (SQLite's JSON functions stop at a NUL; an older Store; a hand edit) shows no
  // emoji, or skips the entries that are not pairs, and never fails the request.
  it("shows a malformed stored value as none, and skips malformed entries", () => {
    for (const stored of [
      '[["a","http://a/"]',
      '[["a","http://a/"]]\u0000junk',
      '{"a":"http://a/"}',
      '"a"',
      "1",
      "null",
    ]) {
      expect(presentEmojis(stored, STATUS_EMOJIS_BYTES)).toEqual([]);
    }
    const mixed = JSON.stringify([
      "a",
      ["b"],
      ["c", "http://a/c", "x"],
      [1, "http://a/d"],
      ["e", null],
      { shortcode: "f", url: "http://a/f" },
      ["ok", "http://a/ok"],
      ["bad name", "http://a/g"],
      ["js", "javascript:alert(1)"],
      ["ok2", "https://a/ok2"],
    ]);
    expect(presentEmojis(mixed, STATUS_EMOJIS_BYTES)).toEqual([
      entity("ok", "http://a/ok"),
      entity("ok2", "https://a/ok2"),
    ]);
  });

  it("reads the names and urls of Emoji tags as Mastodon and Misskey write them", () => {
    expect(
      emojiCandidates([
        { type: "Emoji", name: ":a:", icon: { url: "https://m.example/a.png" } },
        { type: ["Emoji"], name: "b", icon: [{ url: { type: "Link", href: "https://m.example/b.png" } }] },
        { type: "Emoji", name: ":c d:", icon: { url: "https://m.example/c.png" } },
        { type: "Emoji", name: `:${"e".repeat(129)}:`, icon: { url: "https://m.example/e.png" } },
        { type: "Emoji", name: ":f:", icon: { url: `https://m.example/${"f".repeat(600)}` } },
        { type: "Hashtag", name: ":g:", icon: { url: "https://m.example/g.png" } },
        { type: "Emoji", name: ":h\u0000:", icon: { url: "https://m.example/h.png" } },
      ]),
    ).toEqual([
      { shortcode: "a", url: "https://m.example/a.png" },
      { shortcode: "b", url: "https://m.example/b.png" },
    ]);
  });

  it("scans adversarial texts in linear time", () => {
    const content = `${":a".repeat(32 * 1024)}:`;
    const choices = Array.from({ length: 100 }, () => ":".repeat(1000));
    const start = performance.now();
    const names = shortcodesIn([content, ...choices, `${"x".repeat(128 * 1024)}`]);
    expect(names).toEqual(new Set(["a"]));
    expect(performance.now() - start).toBeLessThan(1_000);
  });
});
