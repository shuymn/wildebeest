import { REMOTE_FIELD_LINK_BYTES } from "../platform/stored-bounds";

// Whether a local profile field's value is a link Kopje verifies (rel=me, domain/field-links.ts): a subset of
// Mastodon's Account::Field#verifiable? (app/models/account/field.rb:35-51, v4.5.11) on Addressable 2.9.0, so that a
// value Kopje verifies Mastodon would verify too. test/field-verification.test.ts holds it to the pinned expectations
// of test/fixtures/mastodon-4.5.11-verifiable.json and lists every value Mastodon accepts and Kopje does not.
//
// The value is split as Addressable splits it (RFC 3986 appendix B), then each part judged as written:
//   1. the scheme exactly "https" (ACCEPTED_SCHEMES, compared as written);
//   2. an authority with no "@" (any userinfo, an empty one included, makes Addressable's user non-nil) and no "%";
//   3. a port absent or exactly 443 (Mastodon has no port rule; the web-page sink requests the default port only);
//   4. a host of labels of 1 to 63 lowercase ASCII letters, digits, "_" and "-" joined by single dots, no trailing dot,
//      at most 253 characters, which the WHATWG parser keeps as written (so no IPv4 shorthand): Addressable's
//      normalized_host (downcase, unencode, IDNA ToASCII by label, a single trailing dot dropped) leaves such a host
//      unchanged, as libidn's ToASCII leaves an ASCII label of 1 to 63 characters;
//   5. a path empty or of RFC 3986 pchar and "/" with no "%" and no "." or ".." segment, which the WHATWG parser keeps
//      as written: Addressable's normalized_path re-encodes only characters outside pchar and removes dot segments
//      (and NFC-normalizes decoded percent sequences, which Kopje does not model: any "%" refuses);
//   6. a query and fragment of printable ASCII (Addressable reads neither for verifiable?).
// The rules that need a lookup (literal IPs, local and single-label names) are left to the sink, which refuses them
// before any request (federation/web-page.ts, NET-3).

const RFC3986 = /^(([^:/?#]+):)?(\/\/([^/?#]*))?([^?#]*)(\?([^#]*))?(#(.*))?$/;
const PRINTABLE = /^[!-~]*$/;
const LABEL = /^[a-z0-9_-]{1,63}$/;
const HOST_LIMIT = 253;
// RFC 3986 pchar without pct-encoded, and "/".
const PATH = /^[A-Za-z0-9\-._~!$&'()*+,;=:@/]*$/;

export function verifiableLink(value: string): boolean {
  if (value.length === 0 || !PRINTABLE.test(value)) {
    return false;
  }
  const parts = RFC3986.exec(value);
  if (parts === null || parts[2] !== "https" || parts[4] === undefined) {
    return false;
  }
  const authority = parts[4];
  const path = parts[5] ?? "";
  if (authority.includes("@") || authority.includes("%")) {
    return false;
  }
  const colon = authority.lastIndexOf(":");
  const host = colon === -1 ? authority : authority.slice(0, colon);
  if (colon !== -1 && authority.slice(colon + 1) !== "443") {
    return false;
  }
  if (host.length > HOST_LIMIT || !host.split(".").every((label) => LABEL.test(label))) {
    return false;
  }
  if (!PATH.test(path) || path.split("/").some((segment) => segment === "." || segment === "..")) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.hostname === host && url.pathname === (path === "" ? "/" : path);
}

// A remote field's link Kopje verifies (domain/remote-field-links.ts): of its original attachment value `value` (before
// any cut), the href that Mastodon's Account::Field#extract_url_from_html (app/models/account/field.rb:75-93, v4.5.11)
// returns and #verifiable? accepts, for a subset of the values Mastodon reads, else null. The value:
//   1. trimmed as Ruby's String#strip trims (tab, LF, VT, FF, CR and space at either end); a NUL refuses it (Kopje's
//      projection passes none);
//   2. at most REMOTE_FIELD_SOURCE_BYTES UTF-8 bytes, so within Account::Field::MAX_CHARACTERS_COMPAT (2,047
//      characters) uncut;
//   3. exactly one <a> element, lowercase, its attributes lowercase names, distinct, each with a double-quoted value and
//      separated by HTML whitespace (the WHATWG ASCII whitespace: tab, LF, FF, CR and space; not VT), exactly one href;
//   4. whose children are text runs and <span> elements of text only, written the same way;
//   5. with no character reference but &amp; and no other & or < in a text or an attribute value;
//   6. whose decoded href equals its text (all of it, spans included) and passes verifiableLink, within
//      REMOTE_FIELD_HREF_BYTES and none of "<>\^`{|}.
// test/field-verification.test.ts holds it to test/fixtures/mastodon-4.5.11-remote-links.json, which lists every value
// Mastodon accepts and Kopje does not, and the values Kopje must refuse though a looser reading would accept them.

// The stored href bound (stored-bounds.ts REMOTE_FIELD_LINK_BYTES), and Account::Field::MAX_CHARACTERS_COMPAT in bytes
// (test pins the bound to the shortest anchor within it).
export { REMOTE_FIELD_LINK_BYTES as REMOTE_FIELD_HREF_BYTES };
export const REMOTE_FIELD_SOURCE_BYTES = 2047;

const RUBY_STRIP = /^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g;
const WS = "[\\t\\n\\f\\r ]";
// One character of a text run: printable ASCII but ", & and <, or &amp; (an href is printable ASCII without ", so a
// text equal to it is too).
const TEXT_UNIT = "(?:[!#-%'-;=-~]|&amp;)";
// An attribute's value: printable ASCII and spaces but ", &, < and >, or &amp; (so a tag ends at its first >).
const VALUE = "(?:[ !#-%'-;=?-~]|&amp;)*";
const ATTRIBUTES = `(?:${WS}+[a-z][a-z0-9-]*="${VALUE}")*`;
const SPAN = `<span${ATTRIBUTES}${WS}*>${TEXT_UNIT}*</span>`;
const ANCHOR = new RegExp(`^<a(${ATTRIBUTES})${WS}*>((?:${TEXT_UNIT}|${SPAN})*)</a>$`);
const ATTRIBUTE = new RegExp(`${WS}+([a-z][a-z0-9-]*)="(${VALUE})"`, "g");
const SPAN_TAG = /<\/?span[^>]*>/g;
const REFUSED = /["<>\\^`{|}]/;
const ENCODER = new TextEncoder();

// The attributes of a start tag's attribute list, by name; null when a name repeats.
function attributesOf(list: string): Map<string, string> | null {
  const attributes = new Map<string, string>();
  for (const [, name = "", value = ""] of list.matchAll(ATTRIBUTE)) {
    if (attributes.has(name)) {
      return null;
    }
    attributes.set(name, value);
  }
  return attributes;
}

export function remoteFieldLink(value: string): string | null {
  if (value.includes("\u0000") || ENCODER.encode(value).length > REMOTE_FIELD_SOURCE_BYTES) {
    return null;
  }
  const parts = ANCHOR.exec(value.replace(RUBY_STRIP, ""));
  const attributes = parts === null ? null : attributesOf(parts[1] ?? "");
  const children = parts?.[2] ?? "";
  const spans = children.match(/<span[^>]*>/g) ?? [];
  if (attributes === null || spans.some((tag) => attributesOf(tag.slice("<span".length, -1)) === null)) {
    return null;
  }
  const decode = (text: string) => text.replaceAll("&amp;", "&");
  const raw = attributes.get("href");
  const href = raw === undefined ? null : decode(raw);
  return href !== null &&
    href === decode(children.replace(SPAN_TAG, "")) &&
    href.length <= REMOTE_FIELD_LINK_BYTES &&
    !REFUSED.test(href) &&
    verifiableLink(href)
    ? href
    : null;
}
