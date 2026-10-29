// The names status_tags holds. No imports: the cutover's converter runs this module from the sources on Node
// (cli/lib/cutover/kopje-runtime.js).

// ASCIIFolding::NON_ASCII_CHARS and EQUIVALENT_ASCII_CHARS, as Mastodon has them: a fixed table, not a general
// diacritic stripper (decomposing and dropping every mark would also fold, for example, Japanese dakuten).
const FOLD_FROM =
  "ÀÁÂÃÄÅàáâãäåĀāĂăĄąÇçĆćĈĉĊċČčÐðĎďĐđÈÉÊËèéêëĒēĔĕĖėĘęĚěĜĝĞğĠġĢģĤĥĦħÌÍÎÏìíîïĨĩĪīĬĭĮįİıĴĵĶķĸĹĺĻļĽľĿŀŁłÑñŃńŅņŇňŉŊŋÒÓÔÕÖØòóôõöøŌōŎŏŐőŔŕŖŗŘřŚśŜŝŞşŠšſŢţŤťŦŧÙÚÛÜùúûüŨũŪūŬŭŮůŰűŲųŴŵÝýÿŶŷŸŹźŻżŽž";
const FOLD_TO =
  "AAAAAAaaaaaaAaAaAaCcCcCcCcCcDdDdDdEEEEeeeeEeEeEeEeEeGgGgGgGgHhHhIIIIiiiiIiIiIiIiIiJjKkkLlLlLlLlLlNnNnNnNnnNnOOOOOOooooooOoOoOoRrRrRrSsSsSsSssTtTtTtUUUUuuuuUuUuUuUuUuUuWwYyyYyYZzZzZz";
const FOLD = new Map([...FOLD_FROM].map((char, i) => [char, FOLD_TO[i]!]));

// Tag::HASHTAG_INVALID_CHARS_RE: anything but [[:alnum:]] (in Onigmo on Unicode text, Alphabetic or
// Decimal_Number), Thai U+0E47 to U+0E4E, and Tag::HASHTAG_SEPARATORS (_, U+00B7, U+30FB, U+200C).
const INVALID = /[^\p{Alphabetic}\p{Nd}\u0E47-\u0E4E_\u00B7\u30FB\u200C]/gu;

// HashtagNormalizer#normalize: NFKC (cjk_width), then String#downcase, which maps each code point on its own (Ruby has
// no final-sigma rule, so Σ is σ wherever it stands), then ASCIIFolding#fold, then the characters that cannot be in a
// hashtag dropped. Not idempotent: a dropped character can leave two that compose (U+1100 U+0301 U+1161 gives
// U+1100 U+1161, which NFKC makes U+AC00).
export function normalizeOnce(name: string): string {
  let out = "";
  for (const char of name.normalize("NFKC")) {
    for (const lower of char.toLowerCase()) {
      out += FOLD.get(lower) ?? lower;
    }
  }
  return out.replace(INVALID, "");
}

// status_tags.name: normalizeOnce applied twice, a fixed point (normalizeTag(normalizeTag(x)) === normalizeTag(x)). Every
// character normalizeOnce leaves is one it keeps as it is, so the second pass is NFC of the first's result, and NFC of
// such a name holds only such characters again; test-node/tag-key-fixed-points.test.ts proves this from the runtime's
// Unicode tables. Mastodon's key, wherever its single pass is already a fixed point, is unchanged. ASCII needs no second
// pass. Empty when nothing is left, which is no hashtag.
export function normalizeTag(name: string): string {
  const once = normalizeOnce(name);
  return /^[\0-\x7f]*$/.test(once) ? once : normalizeOnce(once);
}

// The status_tags name of an ActivityPub Hashtag's `name` ("#name"), as ActivityPub::Activity::Create#process_hashtag
// reads it: the whole name normalized, so its # (or a fullwidth or small one, # after NFKC) is dropped with the other
// characters a hashtag cannot hold.
export function hashtagObjectName(name: string): string {
  return normalizeTag(name);
}
