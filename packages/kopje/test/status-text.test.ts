import { describe, expect, it } from "vitest";

import {
  exceedsRawLength,
  MAX_RAW_LENGTH,
  MAX_URL_LENGTH,
  parseStatusText,
  renderStatusHtml,
  statusLength,
} from "../src/domain/status-text";

const KNOWN: Record<string, string> = {
  "bob@": "https://kopje.test/@bob",
  "carol@remote.example": "https://remote.example/@carol",
};

function render(text: string): string {
  return renderStatusHtml(parseStatusText(text).segments, {
    mention: (m) => {
      const url = KNOWN[`${m.username.toLowerCase()}@${m.domain ?? ""}`];
      return url === undefined ? undefined : { url, username: m.username };
    },
    tagUrl: (name) => `https://kopje.test/tags/${encodeURIComponent(name)}`,
  });
}

const link = (url: string, shown: string, prefix = "https://", hidden = "") =>
  `<a href="${url}" target="_blank" rel="nofollow noopener noreferrer"><span class="invisible">${prefix}</span>` +
  `<span class="${hidden === "" ? "" : "ellipsis"}">${shown}</span><span class="invisible">${hidden}</span></a>`;

describe("status text to HTML (Mastodon TextFormatter)", () => {
  it("escapes everything that is not an entity", () => {
    expect(render(`<script>alert("x")</script> & 'q'`)).toBe(
      "<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39;</p>",
    );
  });

  it("splits paragraphs on blank lines and breaks single newlines", () => {
    expect(render("a\r\nb\n\n\nc")).toBe("<p>a<br />b</p><p>c</p>");
  });

  it("links only absolute http(s) URLs", () => {
    expect(render("see https://example.com/x and http://www.example.org")).toBe(
      `<p>see ${link("https://example.com/x", "example.com/x")} and ${link("http://www.example.org", "example.org", "http://www.")}</p>`,
    );
    for (const text of [
      "example.com",
      "ftp://example.com/x",
      "mailto:a@example.com",
      "//example.com",
      "a@example.com",
    ]) {
      expect(render(text)).toBe(`<p>${text}</p>`);
    }
    expect(render("javascript:alert(1)")).toBe("<p>javascript:alert(1)</p>");
  });

  it("escapes the URL in the attribute and cuts long links with an ellipsis", () => {
    const url = 'https://example.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/b?x="1"';
    const html = render(url);
    expect(html).not.toContain('"1"');
    expect(html).toContain('<span class="ellipsis">example.com/aaaaaaaaaaaaaaaaaa</span>');
  });

  it("links known mentions and leaves unknown ones as escaped text", () => {
    expect(render("@bob @Carol@Remote.Example @dave @bob@nowhere.example")).toBe(
      '<p><span class="h-card"><a href="https://kopje.test/@bob" class="u-url mention">@<span>bob</span></a></span> ' +
        '<span class="h-card"><a href="https://remote.example/@carol" class="u-url mention">@<span>Carol</span></a></span> ' +
        "@dave @bob@nowhere.example</p>",
    );
  });

  it("finds mentions and hashtags only where Mastodon does", () => {
    const parsed = parseStatusText(
      "mail@bob.example x/@bob a#b #1 #a1 #日本語 #Tag_A #tag_a https://example.com/#tag @bob",
    );
    expect(parsed.mentions).toEqual([{ username: "bob", domain: null }]);
    expect(parsed.tags).toEqual(["a1", "日本語", "tag_a"]);
  });

  it("normalizes tags and keeps the written form in the text", () => {
    expect(render("#Ｋｏｐｊｅ")).toBe(
      '<p><a href="https://kopje.test/tags/kopje" class="mention hashtag" rel="tag">#<span>Ｋｏｐｊｅ</span></a></p>',
    );
  });
});

describe("status length (StatusLengthValidator)", () => {
  it("counts graphemes, a URL as 23 and a remote mention by its username", () => {
    expect(statusLength("👍🏽👨‍👩‍👧", "")).toBe(2);
    expect(statusLength(`https://example.com/${"x".repeat(100)}`, "")).toBe(23);
    expect(statusLength("@carol@remote.example", "")).toBe("@carol".length);
    expect(statusLength("abc", "cw")).toBe(5);
  });
});

describe("raw input bound", () => {
  it("refuses to parse text over the bound, and counts text and spoiler together", () => {
    expect(() => parseStatusText("x".repeat(MAX_RAW_LENGTH + 1))).toThrow(RangeError);
    expect(() => statusLength("x".repeat(MAX_RAW_LENGTH + 1), "")).toThrow(RangeError);
    expect(parseStatusText("x".repeat(MAX_RAW_LENGTH)).segments).toHaveLength(1);
    expect(exceedsRawLength("x".repeat(MAX_RAW_LENGTH), "")).toBe(false);
    expect(exceedsRawLength("x".repeat(MAX_RAW_LENGTH), "y")).toBe(true);
  });

  it("does not link a URL longer than twitter-text allows, and counts it as text", () => {
    const long = `https://example.com/${"p".repeat(MAX_URL_LENGTH)}`;
    expect(parseStatusText(long).segments).toEqual([{ kind: "text", text: long }]);
    expect(statusLength(long, "")).toBe(long.length);
    const longest = `https://example.com/${"p".repeat(MAX_URL_LENGTH - "https://example.com/".length)}`;
    expect(parseStatusText(longest).segments).toEqual([{ kind: "url", url: longest, text: longest }]);
  });
});
