import { describe, expect, it } from "vitest";

import {
  REMOTE_FIELD_HREF_BYTES,
  REMOTE_FIELD_SOURCE_BYTES,
  remoteFieldLink,
  verifiableLink,
} from "../src/domain/field-verification";
import remote from "./fixtures/mastodon-4.5.11-remote-links.json";
import fixture from "./fixtures/mastodon-4.5.11-verifiable.json";

// domain/field-verification.ts verifiableLink against Mastodon's Account::Field#verifiable? (v4.5.11, Addressable
// 2.9.0). The fixture is hand-written from the Addressable source, not generated (its `method`): no Ruby with
// Addressable 2.9.0 and idn-ruby was available. Kopje must never verify a value Mastodon would not.

type Case = { value: string; verifiable: boolean; reason: string };
const cases = (fixture as { cases: Case[] }).cases;

// Every value Mastodon accepts and Kopje refuses, with Kopje's reason.
const NARROWER: Record<string, string> = {
  "https://x.test..": "no empty label (the sink refuses the name too)",
  "https://x.test:8443/": "the default port only, as the sink requests",
  "https://x.test:/": "an empty port refuses",
  "https://x.test/%2F": "any % in the path refuses",
  "https://x.test/%C3%A9": "any % in the path refuses",
  "https://x.test/%FF": "any % in the path refuses",
  "https://x.test/?q=a b": "printable ASCII only",
  "https://[::1]/": "LDH and underscore labels only (the sink refuses a literal IP too)",
  "https://0x7f.1/": "the WHATWG parser reads it as 127.0.0.1, another host",
  [`https://${"a".repeat(64)}.test/`]: "labels of at most 63 characters",
};

describe("verifiableLink", () => {
  it("never accepts a value Mastodon refuses, and lists every value Mastodon accepts that it refuses", () => {
    expect((fixture as { generated: boolean }).generated).toBe(false);
    for (const { value, verifiable } of cases) {
      if (verifiableLink(value)) {
        expect(verifiable, value).toBe(true);
      }
    }
    const narrower = cases.filter((c) => c.verifiable && !verifiableLink(c.value)).map((c) => c.value);
    expect(narrower.sort()).toEqual(Object.keys(NARROWER).sort());
  });

  it.each([
    "https://x.test/e%CC%81",
    "https://x.test/%c3%a9",
    "https://exa%6Dple.test",
    "https://x.test/a\u0000",
    "https://x.test/é",
    "https://x.test:0443/",
    "https://x.test/a\\b",
    "https://x.test/a|b",
    "https://1.2.3/",
    "",
  ])("refuses %j", (value) => {
    expect(verifiableLink(value)).toBe(false);
  });
});

// remoteFieldLink against Mastodon's Account::Field#value_for_verification and #verifiable? for a remote account. The
// fixture is hand-written, its extractions checked with Nokogiri's HTML5 parser (its `method`). Kopje must never verify
// a value Mastodon would not, nor a different href.
type RemoteCase = { value: string; link: string | null; reason: string; overAcceptance?: true };
const remoteCases = (remote as { cases: RemoteCase[] }).cases;

// Every value Mastodon verifies and Kopje refuses, by the fixture's reason, with Kopje's.
const REMOTE_NARROWER: Record<string, string> = {
  "HTML5 lowercases tag and attribute names": "lowercase names only",
  "a single-quoted value": "double-quoted values only",
  "an unquoted value": "double-quoted values only",
  "a numeric character reference": "no character reference but &amp;",
  "a bare & that starts no character reference": "no & but &amp;",
  "a child element other than span": "text and spans of text only",
  "nested spans": "text and spans of text only",
  "a repeated attribute: HTML5 keeps the first": "distinct attribute names",
  "a non-ASCII attribute value": "printable ASCII and spaces in attribute values",
  "a > inside a quoted attribute value": "no > in an attribute value, so a tag ends at its first >",
  "an attribute without a value": "every attribute has a double-quoted value",
  "a self-closing flag, which HTML5 ignores on a": "no self-closing flag",
  "a NUL in the text, which HTML5 drops": "no NUL anywhere",
};

describe("remoteFieldLink", () => {
  it("pins its bounds to the stored ones and to Mastodon", () => {
    // MAX_CHARACTERS_COMPAT, and the longest X of `<a href="X">X</a>` within it.
    expect(REMOTE_FIELD_SOURCE_BYTES).toBe(2047);
    expect(Math.floor((REMOTE_FIELD_SOURCE_BYTES - '<a href=""></a>'.length) / 2)).toBe(REMOTE_FIELD_HREF_BYTES);
  });

  it("never verifies a value Mastodon refuses or another href, and lists every value Mastodon verifies that it refuses", () => {
    expect((remote as { generated: boolean }).generated).toBe(false);
    for (const { value, link, reason } of remoteCases) {
      const kopje = remoteFieldLink(value);
      if (kopje !== null) {
        expect(kopje, reason).toBe(link);
      }
    }
    const narrower = remoteCases
      .filter((c) => c.link !== null && remoteFieldLink(c.value) === null)
      .map((c) => c.reason);
    expect(narrower.sort()).toEqual(Object.keys(REMOTE_NARROWER).sort());
  });

  it("refuses the over-acceptance cases", () => {
    const over = remoteCases.filter((c) => c.overAcceptance === true);
    expect(over.map((c) => c.reason)).toHaveLength(3);
    for (const { value, link, reason } of over) {
      expect(link, reason).toBeNull();
      expect(remoteFieldLink(value), reason).toBeNull();
    }
  });

  it.each([
    ["an href past its bytes", `<a href="https://x.test/${"a".repeat(1002)}">https://x.test/${"a".repeat(1002)}</a>`],
    ["a refused character in the query", '<a href="https://x.test/?a|b">https://x.test/?a|b</a>'],
    ["a backtick in the fragment", '<a href="https://x.test/#a`b">https://x.test/#a`b</a>'],
    ["an astral character", '<a href="https://x.test/\u{1f600}">https://x.test/\u{1f600}</a>'],
    ["a value past 2,047 bytes", `<a href="https://x.test/">https://x.test/</a>${" ".repeat(2048)}`],
    ["an http href", '<a href="http://x.test/">http://x.test/</a>'],
  ])("refuses %s", (_label, value) => {
    expect(remoteFieldLink(value)).toBeNull();
  });
});
