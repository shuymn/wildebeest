import { describe, expect, it } from "vitest";

// Pins the facts about workerd's HTMLRewriter (lol-html) that src/platform/html-scan.ts rests on. Each one is a
// property of the installed runtime, not of Kopje's code: if an upgrade changes one, this file fails first.

type Event =
  | { kind: "element"; tag: string; ns: string; attrs: Record<string, string | null> }
  | { kind: "text"; in: string; text: string; last: boolean }
  | { kind: "end"; tag: string };

async function rewrite(
  input: BodyInit,
  contentType: string,
  selectors: string[],
  attributes: string[] = [],
): Promise<Event[]> {
  const events: Event[] = [];
  let rewriter = new HTMLRewriter();
  for (const selector of selectors) {
    rewriter = rewriter.on(selector, {
      element(element) {
        const attrs: Record<string, string | null> = {};
        for (const name of attributes) {
          attrs[name] = element.getAttribute(name);
        }
        events.push({ kind: "element", tag: element.tagName, ns: element.namespaceURI, attrs });
        try {
          element.onEndTag((end) => {
            events.push({ kind: "end", tag: end.name });
          });
        } catch {
          // A void element has no end tag handler.
        }
      },
      text(text) {
        events.push({ kind: "text", in: selector, text: text.text, last: text.lastInTextNode });
      },
    });
  }
  const response = rewriter.transform(new Response(input, { headers: { "content-type": contentType } }));
  await response.body?.pipeTo(new WritableStream());
  return events;
}

const HTML = "text/html; charset=utf-8";
const XHTML = "http://www.w3.org/1999/xhtml";

function elements(events: Event[]) {
  return events.filter((event) => event.kind === "element");
}

function joinedText(events: Event[]): string {
  return events.map((event) => (event.kind === "text" ? event.text : "")).join("");
}

function chunked(parts: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      const part = parts[index++];
      if (part === undefined) {
        controller.close();
      } else {
        controller.enqueue(part);
      }
    },
  });
}

describe("HTMLRewriter facts", () => {
  it("returns attribute values raw, references undecoded", async () => {
    const events = await rewrite('<a href="https://a.example/?x=1&amp;y=&#50;&lt" rel="me">', HTML, ["a"], ["href"]);
    expect(elements(events)).toEqual([
      { kind: "element", tag: "a", ns: XHTML, attrs: { href: "https://a.example/?x=1&amp;y=&#50;&lt" } },
    ]);
  });

  it("returns text chunks raw and lets a reference split across chunks", async () => {
    const encoder = new TextEncoder();
    const events = await rewrite(chunked([encoder.encode("<title>a &am"), encoder.encode("p; b\r\nc</title>")]), HTML, [
      "title",
    ]);
    const texts = events.filter((event) => event.kind === "text");
    expect(texts.length).toBeGreaterThan(1);
    expect(joinedText(events)).toBe("a &amp; b\r\nc");
  });

  it("keeps CR, CRLF and NUL raw in attribute values and text", async () => {
    const events = await rewrite('<a href="a\r\nb\rc\0d"></a><title>e\r\nf\0</title>', HTML, ["a", "title"], ["href"]);
    expect(elements(events)[0]).toMatchObject({ attrs: { href: "a\r\nb\rc\0d" } });
    expect(joinedText(events)).toBe("e\r\nf\0");
  });

  it("never emits a start tag cut by the end of the input", async () => {
    expect(elements(await rewrite('<p><a rel=me href="https://a.example/"', HTML, ["a"]))).toHaveLength(0);
    expect(elements(await rewrite('<p><a rel=me href="https://a.example/', HTML, ["a"]))).toHaveLength(0);
  });

  it("returns the first of duplicate attributes", async () => {
    const events = await rewrite('<a rel="nofollow" rel="me" href="https://a.example/">', HTML, ["a"], ["rel"]);
    expect(elements(events)[0]).toMatchObject({ attrs: { rel: "nofollow" } });
  });

  it("treats noscript as raw text (scripting on), exposing markup a scripting-off parser comments out", async () => {
    const events = await rewrite(
      '<body><noscript><!--</noscript><a rel=me href="https://actor.example/u/a">--></noscript>',
      HTML,
      ["a"],
      ["rel"],
    );
    expect(elements(events)).toHaveLength(1);
    const inside = await rewrite('<body><noscript><a rel=me href="https://actor.example/u/a"></noscript>', HTML, ["a"]);
    expect(elements(inside)).toHaveLength(0);
  });

  it("gives SVG and MathML elements their namespaces, and HTML inside an integration point XHTML", async () => {
    const events = await rewrite(
      "<svg><a></a><foreignObject><a></a></foreignObject></svg><math><mi><a></a></mi></math><a></a>",
      HTML,
      ["a"],
    );
    expect(elements(events).map((event) => (event.kind === "element" ? event.ns : ""))).toEqual([
      "http://www.w3.org/2000/svg",
      XHTML,
      XHTML,
      XHTML,
    ]);
  });

  it("gives an integration point element itself the XHTML namespace (unlike the spec)", async () => {
    const events = await rewrite(
      "<svg><title></title><desc></desc><foreignObject></foreignObject><g></g></svg>" +
        '<math><mi></mi><annotation-xml encoding="text/html"></annotation-xml></math>',
      HTML,
      ["*"],
    );
    expect(
      elements(events).map((event) => (event.kind === "element" ? `${event.tag} ${event.ns.split("/").pop()}` : "")),
    ).toEqual([
      "svg svg",
      "title xhtml",
      "desc xhtml",
      "foreignobject xhtml",
      "g svg",
      "math MathML",
      "mi xhtml",
      "annotation-xml xhtml",
    ]);
  });

  it("fails the transformed stream when the open elements pass the memory limit", async () => {
    await expect(rewrite("<span>".repeat(50_000), HTML, ["a"])).rejects.toThrow(/memory/i);
    expect(await rewrite("<span>".repeat(10_000), HTML, ["a"])).toEqual([]);
  });

  it("calls the end tag handler only for an explicit end tag", async () => {
    const closed = await rewrite("<title>a</title>", HTML, ["title"]);
    expect(closed.some((event) => event.kind === "end")).toBe(true);
    const open = await rewrite("<title>a", HTML, ["title"]);
    expect(open.some((event) => event.kind === "end")).toBe(false);
  });

  it("does not re-sniff a meta charset that disagrees with the given label", async () => {
    // 0xE9 is é in windows-1252 and invalid alone in UTF-8.
    const bytes = new Uint8Array([
      ...new TextEncoder().encode('<meta charset="utf-8"><title>'),
      0xe9,
      ...new TextEncoder().encode("</title>"),
    ]);
    expect(joinedText(await rewrite(bytes, "text/html; charset=windows-1252", ["title"]))).toBe("é");
  });

  it.each(["utf-16le", "utf-16be", "iso-2022-jp", "x-no-such-label"])(
    "refuses the label %s synchronously, before pumping",
    (label) => {
      expect(() =>
        new HTMLRewriter()
          .on("a", { element() {} })
          .transform(new Response("<a>", { headers: { "content-type": `text/html; charset=${label}` } })),
      ).toThrow("Parser error: ");
    },
  );

  it.each([
    "utf-8",
    "windows-1252",
    "shift_jis",
    "euc-jp",
    "gbk",
    "gb18030",
    "big5",
    "euc-kr",
    "iso-8859-2",
    "koi8-r",
    "x-user-defined",
  ])("accepts the ASCII-compatible label %s", async (label) => {
    const events = await rewrite('<a href="x">', `text/html; charset=${label}`, ["a"], ["href"]);
    expect(elements(events)).toHaveLength(1);
  });

  it("fails the transformed stream on a parsing ambiguity", async () => {
    await expect(rewrite('<select><xmp><a rel=me href="x"></xmp></select>', HTML, ["a"])).rejects.toThrow(/ambigu/i);
  });

  it("fails the transformed stream when a buffered tag passes the memory limit", async () => {
    const encoder = new TextEncoder();
    const parts = [encoder.encode('<a href="')];
    const filler = encoder.encode("x".repeat(64 * 1024));
    for (let i = 0; i < 64; i++) {
      parts.push(filler);
    }
    await expect(rewrite(chunked(parts), HTML, ["a"], ["href"])).rejects.toThrow(/memory/i);
  });
});
