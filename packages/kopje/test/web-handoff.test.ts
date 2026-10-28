import { afterEach, describe, expect, it, vi } from "vitest";

import { L1_SCRIPT } from "../src/web/asset-versions";
import { EMOJI_PAGE_IMAGES, emojiAllowance } from "../src/web/view/emoji";
import { accountPreview, accountTarget } from "../src/web/view/remote";
import { bearer, sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { pathOf } from "./media-helpers";
import { community, post, remoteAccount, seedStatus } from "./status-helpers";
import {
  accessibleName,
  attr,
  byId,
  closest,
  type Document,
  type Element,
  one,
  parseHtml,
  query,
  text,
} from "./web-dom";
import { account, customEmoji } from "./web-fixtures";
import { countedHarness, ORIGIN, signIn } from "./web-helpers";

// Following and interacting from another server: the profile's and the status's dialogs, and the handoff pages they
// submit to, /@username/interact and /@username/:id/interact (VIS-4, WEB-2, WEB-3, WEB-5). The handoff names a server
// only by a bounded DNS name, links to its /authorize_interaction with the target's URI, and fetches, stores,
// redirects and signs in nothing. What the dialogs and the copy control do once rendered is the browser job's
// (browser/pages.spec.ts).

type Harness = Awaited<ReturnType<typeof community>>;

// The handoff page's headers, as literals: the script-free CSP without media, no framing, kept by no shared cache and
// revalidated.
const HANDOFF = {
  "content-type": "text/html; charset=UTF-8",
  "content-security-policy":
    "default-src 'none'; style-src 'self'; img-src 'self' https:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
  "cache-control": "private, no-cache",
};

async function page(h: Harness, path: string, init?: RequestInit) {
  const response = await h.request(path, init);
  const html = await response.text();
  return { response, html, doc: parseHtml(html) };
}

function headersOf(response: Response): Record<string, string | null> {
  return Object.fromEntries(
    [...Object.keys(HANDOFF), "vary", "location", "access-control-allow-origin", "set-cookie"].map((name) => [
      name,
      response.headers.get(name),
    ]),
  );
}

const EXPECTED_HEADERS = {
  ...HANDOFF,
  vary: null,
  location: null,
  "access-control-allow-origin": null,
  "set-cookie": null,
};

// A page's copy fields: the value shown, the button's value and texts, and whether it is hidden.
function copyFields(doc: Document | Element) {
  return query(doc, "div", "copyfield").map((field) => {
    // Absent on a page without the L1 bundle: the value alone.
    const button = query(field, "button")[0];
    const of = (name: string) => (button === undefined ? null : attr(button, name));
    return {
      label: text(query(field, "p", "flabel")[0]!),
      // What to do with the value, in the hint under it (the failure note shares its place).
      hint: query(field, "p", "hint")
        .filter((p) => !(attr(p, "class") ?? "").includes("copy-failed"))
        .map(text),
      shown: text(query(field, "span", "mono")[0]!),
      copy: of("data-copy"),
      copied: of("data-copied"),
      failed: of("data-failed"),
      hidden: of("hidden") !== null,
      type: of("type"),
      name: button === undefined ? null : accessibleName(button, parseHtml("")),
      status: query(field, "p")
        .filter((p) => attr(p, "role") === "status")
        .map(text),
    };
  });
}

// The GET form naming the server, as the page emits it.
function serverForm(doc: Document | Element) {
  const [form] = query(doc, "form");
  const input = query(form!, "input")[0]!;
  return {
    method: attr(form!, "method"),
    action: attr(form!, "action"),
    inputs: query(form!, "input").map((i) => attr(i, "name")),
    type: attr(input, "type"),
    inputmode: attr(input, "inputmode"),
    spellcheck: attr(input, "spellcheck"),
    autocomplete: attr(input, "autocomplete"),
    autofocus: attr(input, "autofocus") !== null,
    invalid: attr(input, "aria-invalid"),
    describedBy: (attr(input, "aria-describedby") ?? "").split(" ").map((id) => text(byId(doc, id)!)),
  };
}

async function accountUri(h: Harness, id: string): Promise<string> {
  const response = await h.request(`/api/v1/accounts/${id}`);
  return (await response.json<{ uri: string }>()).uri;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the follow and interact dialogs", () => {
  it("open from the profile’s Follow, closed, with the GET form to the handoff and the handle to copy", async () => {
    const h = await community(["alice"]);
    const { doc } = await page(h, "/@alice");
    const dialog = byId(doc, "follow")!;
    expect(dialog.tagName).toBe("dialog");
    expect(attr(dialog, "open")).toBeNull();
    // Light dismiss, as every dialog: an outside click closes it.
    expect(attr(dialog, "closedby")).toBe("any");
    expect(accessibleName(dialog, doc)).toBe("Follow alice");
    // The opener sits beside the avatar in the profile card.
    const openers = query(doc, "button").filter((b) => attr(b, "commandfor") === "follow");
    expect(
      openers.map((b) => [
        attr(b, "type"),
        attr(b, "command"),
        accessibleName(b, doc),
        closest(b, (e) => e === dialog) !== null,
      ]),
    ).toEqual([
      ["button", "show-modal", "Follow", false],
      ["button", "close", "Close", true],
    ]);
    expect(closest(openers[0]!, (e) => attr(e, "class") === "card profile")).not.toBeNull();
    // The server field takes focus when it opens, and keeps the browser's autocomplete.
    expect(serverForm(dialog)).toEqual({
      method: "get",
      action: "/@alice/interact",
      inputs: ["server"],
      type: "text",
      inputmode: "url",
      spellcheck: "false",
      autocomplete: null,
      autofocus: true,
      invalid: null,
      describedBy: ["Its domain, for example social.example"],
    });
    // The handle, whole, with its hidden copy button and the catalogue's result texts.
    expect(copyFields(dialog)).toEqual([
      {
        label: "Handle",
        hint: ["Paste this handle into your server's search."],
        shown: "@alice@kopje.test",
        copy: "@alice@kopje.test",
        copied: "Copied",
        failed: "Could not copy. Select the text and copy it instead.",
        hidden: true,
        type: "button",
        name: "Copy handle",
        status: [""],
      },
    ]);
  });

  it("open from the status’s Open on your server and Embed: the status URL, and the code /api/oembed gives", async () => {
    const h = await community(["alice"]);
    const status = await post(h, h.users.alice, { status: "hello" });
    const path = pathOf(String(status.url));
    const { doc, html } = await page(h, path);
    const interact = byId(doc, "interact")!;
    expect(attr(interact, "closedby")).toBe("any");
    expect(accessibleName(interact, doc)).toBe("Open this post on your server");
    expect(serverForm(interact)).toMatchObject({ method: "get", action: `${path}/interact`, autofocus: true });
    expect(copyFields(interact).map(({ shown, copy, name }) => ({ shown, copy, name }))).toEqual([
      { shown: String(status.url), copy: String(status.url), name: "Copy URL" },
    ]);
    // The focal post's counts row ends in "Share", whose menu opens both.
    const acts = query(query(doc, "article")[0]!, "span", "acts")[0]!;
    expect(
      query(acts, "button").map((b) => [attr(b, "commandfor"), attr(b, "command"), accessibleName(b, doc)]),
    ).toEqual([
      ["actions", "toggle-popover", "Share"],
      ["interact", "show-modal", "Open on your server"],
      ["embed", "show-modal", "Embed"],
    ]);
    expect(attr(byId(doc, "actions")!, "popover")).toBe("auto");

    // The embed code is the oEmbed html (Mastodon's embed modal shows the same), found through the discovery link
    // in the head, as Mastodon's status page names it.
    const links = query(doc, "link").filter((l) => attr(l, "type") === "application/json+oembed");
    expect(links.map((l) => [attr(l, "rel"), attr(l, "href")])).toEqual([
      ["alternate", `${ORIGIN}/api/oembed?format=json&url=${encodeURIComponent(String(status.url))}`],
    ]);
    expect(html).toContain(`/api/oembed?format=json&amp;url=https%3A%2F%2Fkopje.test%2F%40alice%2F${status.id}`);
    const discovered = new URL(attr(links[0]!, "href")!);
    const oembed = await h.request(`${discovered.pathname}${discovered.search}`);
    expect(oembed.status).toBe(200);
    const { html: code } = await oembed.json<{ html: string }>();
    const embed = byId(doc, "embed")!;
    // Nothing is typed in it: light dismiss, and focus on its heading.
    expect(attr(embed, "closedby")).toBe("any");
    expect(query(embed, "div", "dhead").map((d) => [attr(d, "autofocus"), attr(d, "tabindex")])).toEqual([["", "-1"]]);
    expect(copyFields(embed).map(({ shown, copy, name, hidden }) => ({ shown, copy, name, hidden }))).toEqual([
      { shown: code, copy: code, name: "Copy code", hidden: true },
    ]);
    // The code is shown on one line, cut with an ellipsis (kopje.css); the whole of it is still the field's text.
    expect(query(embed, "span", "mono").map((d) => attr(d, "class"))).toEqual(["mono oneline"]);
  });

  it("head every profile tab: the same profile card, its Follow beside the avatar and the dialog it opens", async () => {
    const h = await community(["alice"]);
    await post(h, h.users.alice, { status: "#walks hello" });
    const heads: string[] = [];
    for (const path of [
      "/@alice",
      "/@alice/with_replies",
      "/@alice/media",
      "/@alice/tagged/walks",
      "/@alice/featured",
    ]) {
      const { response, doc, html } = await page(h, path);
      expect(response.status, path).toBe(200);
      const card = one(doc, "section", "profile");
      expect(
        query(card, "button").map((b) => [attr(b, "command"), attr(b, "commandfor")]),
        path,
      ).toEqual([["show-modal", "follow"]]);
      expect(byId(doc, "follow")?.nodeName, path).toBe("dialog");
      const head = html.slice(html.indexOf('<section class="card profile">'), html.indexOf("</dialog>"));
      // A tab without the L1 bundle (Featured, a tagged list) shows the handle alone, without the copy control
      // that only the bundle runs; otherwise every tab's head is the same.
      heads.push(
        html.includes(L1_SCRIPT)
          ? head
              .replace(/<span class="slot">.*?<\/button><\/span>/s, "")
              .replace(
                /<p class="vh" role="status"><\/p><div class="note">(<p class="hint">[^<]*<\/p>)<p class="hint copy-failed"[^>]*>[^<]*<\/p><\/div>/,
                "$1",
              )
          : head,
      );
    }
    expect(new Set(heads).size).toBe(1);
  });

  it("are not on the follow lists or the hashtag page, which have no Follow or post meta", async () => {
    const h = await community(["alice"]);
    await post(h, h.users.alice, { status: "#walks hello" });
    for (const path of ["/@alice/followers", "/tags/walks"]) {
      const { response, html } = await page(h, path);
      expect(response.status, path).toBe(200);
      expect(html, path).not.toContain("<dialog");
      expect(html, path).not.toContain("copyfield");
    }
  });
});

describe("the handoff pages", () => {
  it("render the dialog’s form without a server: script-free, never kept by a shared cache", async () => {
    const h = await community(["alice"]);
    const status = await post(h, h.users.alice, { status: "hello" });
    const path = pathOf(String(status.url));
    for (const [handoff, value, title] of [
      ["/@alice/interact", "@alice@kopje.test", "Follow alice"],
      [`${path}/interact`, String(status.url), "Open this post on your server"],
    ] as const) {
      const { response, html, doc } = await page(h, handoff);
      expect(response.status, handoff).toBe(200);
      expect(headersOf(response), handoff).toEqual(EXPECTED_HEADERS);
      expect(html, handoff).not.toContain("<script");
      expect(text(query(doc, "h1")[0]!)).toBe(title);
      // Outside a dialog, nothing takes focus by itself.
      expect(serverForm(doc), handoff).toMatchObject({
        method: "get",
        action: handoff,
        autofocus: false,
        invalid: null,
      });
      expect(query(doc, "p").filter((p) => attr(p, "role") === "alert")).toEqual([]);
      expect(copyFields(doc).map((field) => field.shown)).toEqual([value]);
      // Script-free: the value alone, with no copy button, status element or failure note.
      expect(copyFields(doc).map(({ copy, status }) => ({ copy, status }))).toEqual([{ copy: null, status: [] }]);
      expect(query(doc, "p", "copy-failed")).toEqual([]);
    }
  });

  it("link to the server’s /authorize_interaction with the read’s actor or status URI, writing and fetching nothing", async () => {
    const { h, calls } = await countedHarness(["alice"]);
    const status = await post(h, h.users.alice, { status: "hello" });
    const path = pathOf(String(status.url));
    const actor = await accountUri(h, h.users.alice.id);
    expect(actor).toBe(`${ORIGIN}/ap/users/alice`);
    const fetches = vi.spyOn(globalThis, "fetch");
    for (const [handoff, uri, back, search] of [
      ["/@alice/interact", actor, "/@alice", "@alice@kopje.test"],
      [`${path}/interact`, String(status.uri), path, String(status.url)],
    ] as const) {
      // An IDN, with spaces around it and in another case, is its canonical ASCII name.
      for (const [server, host] of [
        ["social.example", "social.example"],
        [" Bücher.Example ", "xn--bcher-kva.example"],
      ] as const) {
        const request = `${handoff}?server=${encodeURIComponent(server)}`;
        const before = await calls(request);
        expect(before, request).toEqual({ status: 200, calls: ["webInteractTarget"] });
        const { response, html, doc } = await page(h, request);
        expect(headersOf(response), request).toEqual(EXPECTED_HEADERS);
        expect(html).not.toContain("<script");
        expect(html).not.toContain("<form");
        expect(text(query(doc, "h1")[0]!)).toBe(`Continue to ${host}`);
        expect(
          query(query(doc, "main")[0]!, "a").map((a) => [attr(a, "href"), attr(a, "rel"), accessibleName(a, doc)]),
        ).toEqual([
          // Back above the heading, then the one action; the server is named once, in the heading.
          [back, null, "Back"],
          [`https://${host}/authorize_interaction?uri=${encodeURIComponent(uri)}`, "nofollow noopener", "Continue"],
        ]);
        expect(copyFields(doc).map((field) => [field.label, field.hint, field.shown])).toEqual([
          [
            handoff === "/@alice/interact" ? "Handle" : "Post URL",
            ["If the link does not work, paste this into your server's search."],
            search,
          ],
        ]);
      }
      // The link's uri is what another Kopje's /authorize_interaction takes: this one's prefills its form with it.
      const form = await page(h, `/authorize_interaction?uri=${encodeURIComponent(uri)}`);
      expect(query(form.doc, "input").find((i) => attr(i, "name") === "uri")?.attrs).toContainEqual({
        name: "value",
        value: uri,
      });
    }
    expect(fetches).not.toHaveBeenCalled();
  });

  it("name the target before the link: the account’s row, or the post’s author and its text (its warning if any)", async () => {
    const h = await community(["alice"]);
    const plain = await post(h, h.users.alice, { status: "A walk by the river" });
    const warned = await post(h, h.users.alice, { status: "What the warning hides", spoiler_text: "Spoilers" });
    const target = (doc: Document) => {
      const card = one(doc, "section", "card");
      const children = card.childNodes.filter((n): n is Element => "tagName" in n);
      return {
        order: children.map((c) => attr(c, "class")),
        name: text(one(card, "span", "name")),
        address: text(one(card, "span", "handle")),
        text: query(card, "p", "clamp").map((p) => text(p)),
        links: query(card, "a").map((a) => attr(a, "href")?.split("?")[0]),
      };
    };
    const account = await page(h, "/@alice/interact?server=social.example");
    expect(target(account.doc)).toEqual({
      order: ["who", "group", "copyfield"],
      name: "alice",
      address: "@alice@kopje.test",
      text: [],
      links: ["https://social.example/authorize_interaction"],
    });
    for (const [status, shown] of [
      [plain, "A walk by the river"],
      [warned, "Spoilers"],
    ] as const) {
      const { html, doc } = await page(h, `${pathOf(String(status.url))}/interact?server=social.example`);
      expect(target(doc)).toMatchObject({ order: ["who", "clamp", "group", "copyfield"], text: [shown] });
      expect(html).not.toContain("What the warning hides");
    }
  });

  it("charge an account’s name to the page’s emoji allowance once, for the title and the target’s row", () => {
    const allowance = emojiAllowance();
    const url = "https://kopje.test/emoji/a.png";
    const named = account({ display_name: ":a: and :b:", emojis: [customEmoji("a", url), customEmoji("b", url)] });
    const target = accountTarget(named, "kopje.test", allowance);
    expect(EMOJI_PAGE_IMAGES - allowance.images).toBe(2);
    const preview = accountPreview(named, "kopje.test", target);
    expect(EMOJI_PAGE_IMAGES - allowance.images).toBe(2);
    expect(preview.author.name).toEqual(target.name!.inline);
  });

  it("refuse every server that is not a bounded DNS name with the same 400 bytes, showing nothing given", async () => {
    const h = await community(["alice"]);
    const label = (n: number, c = "a") => c.repeat(n);
    // 253 octets in four labels, and 63 in one: the longest names DNS has (RFC 1035 §2.3.4).
    const longest = [label(63), label(63, "b"), label(63, "c"), label(61, "d")].join(".");
    expect(longest).toHaveLength(253);
    const accepted = [longest, `${label(63)}.example`, "xn--bcher-kva.example", "a-b.example", "1.example"];
    for (const server of accepted) {
      const response = await h.request(`/@alice/interact?server=${encodeURIComponent(server)}`);
      expect(response.status, server).toBe(200);
      expect(await response.text(), server).toContain(`Continue to ${server}`);
    }
    const refused = [
      "",
      "   ",
      // One label.
      "localhost",
      "example",
      // IP literals, in every form the URL parser reads as one.
      "192.0.2.1",
      "0x7f.1",
      "2130706433",
      "1.2.3",
      "[2001:db8::1]",
      "2001:db8::1",
      // More than a host name.
      "social.example:443",
      "https://social.example",
      "social.example/path",
      "social.example?x=1",
      "social.example#x",
      "user@social.example",
      "user:pass@social.example",
      "//social.example",
      "social.example.",
      // Past DNS's lengths: the whole name, a label, and an IDN label whose ASCII form is past 63.
      `${longest}a`,
      `a.${longest}`,
      `${label(64)}.example`,
      `${"ü".repeat(60)}.example`,
      // Characters no DNS name has, and hyphens at a label's end.
      "soc ial.example",
      "social_example.com",
      "social.example\u0000",
      "%00.example",
      "-social.example",
      "social-.example",
      "social.-example",
      "<b>x</b>.example",
      '"x".example',
    ];
    const bytes = new Set<string>();
    for (const server of refused) {
      const response = await h.request(`/@alice/interact?server=${encodeURIComponent(server)}`);
      expect(response.status, JSON.stringify(server)).toBe(400);
      expect(headersOf(response), JSON.stringify(server)).toEqual(EXPECTED_HEADERS);
      bytes.add(await response.text());
    }
    expect(bytes.size).toBe(1);
    const [html] = [...bytes] as [string];
    const doc = parseHtml(html);
    // The form again, refusing with an alert the field names, and nothing of what was given.
    const alert = query(doc, "p").filter((p) => attr(p, "role") === "alert");
    expect(alert.map(text)).toEqual(["Enter the domain of your server, for example social.example."]);
    expect(serverForm(doc)).toMatchObject({
      action: "/@alice/interact",
      invalid: "true",
      autofocus: false,
      // The error stands in for the hint while it shows.
      describedBy: ["Enter the domain of your server, for example social.example."],
    });
    expect(html).not.toContain("authorize_interaction");
    for (const given of ["localhost", "192.0.2.1", "pass", "&lt;b&gt;", "ü"]) {
      expect(html, given).not.toContain(given);
    }
  });

  it("answer the ordinary 404 for every target its page would not show, a suspended account’s included", async () => {
    const h = await community(["alice", "bob"]);
    const { alice, bob } = h.users;
    const carol = await remoteAccount(h.store, "carol", "carol.example");
    const missing = await page(h, "/@nobody");
    expect(missing.response.status).toBe(404);
    const shown = await post(h, alice, { status: "public" });
    const paths = ["/@nobody/interact", "/@carol@carol.example/interact", "/@alice@other.example/interact"];
    for (const visibility of ["private", "direct"]) {
      paths.push(
        `${pathOf(String((await post(h, alice, { status: `@bob ${visibility}`, visibility })).url))}/interact`,
      );
    }
    const limited = await seedStatus(h.store, { accountId: alice.id, visibility: "limited", uri: `${ORIGIN}/ap/o/l` });
    const bobs = await post(h, bob, { status: "bob public" });
    const boost = await h.request(`/api/v1/statuses/${bobs.id}/reblog`, bearer(alice.token, { method: "POST" }));
    const remote = await seedStatus(h.store, { accountId: carol, visibility: "public" });
    paths.push(
      `/@alice/${limited}/interact`,
      `/@alice/${(await boost.json<{ id: string }>()).id}/interact`,
      `/@alice/${bobs.id}/interact`,
      `/@carol@carol.example/${remote}/interact`,
      `/@alice/${remote}/interact`,
      "/@alice/100000000000000001/interact",
      // A legacy id has no handoff of its own: the dialog names the status by its API id.
      "/@alice/3f1c2b9e-0000-4000-8000-000000000001/interact",
    );
    const hidden = async (path: string) => {
      for (const query of ["", "?server=social.example", "?server=192.0.2.1"]) {
        const answer = await page(h, `${path}${query}`);
        expect(answer.response.status, `${path}${query}`).toBe(404);
        expect(answer.html, `${path}${query}`).toBe(missing.html);
      }
    };
    // With alice active, so each refusal is its target's own: the guarded branch runs, as the same requests for
    // what the pages show answer 200.
    const visible = ["/@alice/interact", `${pathOf(String(shown.url))}/interact`];
    for (const path of visible) {
      expect((await h.request(`${path}?server=social.example`)).status, path).toBe(200);
    }
    for (const path of paths) {
      await hidden(path);
    }
    // A suspended account, and its status that was shown before: the same 404.
    await sql(
      h.store,
      "UPDATE local_accounts SET suspended_at = ? WHERE account_id = ?",
      new Date(NOW).toISOString(),
      alice.id,
    );
    for (const path of visible) {
      await hidden(path);
    }
  });

  it("read no session: the same answer with and without one", async () => {
    const h = await community(["alice"]);
    const browser = await signIn(h);
    for (const path of ["/@alice/interact", "/@alice/interact?server=social.example", "/@alice/interact?server=x"]) {
      const anonymous = await page(h, path);
      const signedIn = await page(h, path, { headers: { cookie: browser.cookie } });
      expect(signedIn.response.status, path).toBe(anonymous.response.status);
      expect(signedIn.html, path).toBe(anonymous.html);
      expect(headersOf(signedIn.response), path).toEqual(headersOf(anonymous.response));
    }
  });
});
