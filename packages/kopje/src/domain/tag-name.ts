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

// status_tags.name: HashtagNormalizer#normalize. NFKC (cjk_width), then String#downcase, which maps each code point on
// its own (Ruby has no final-sigma rule, so Σ is σ wherever it stands), then ASCIIFolding#fold, then the characters
// that cannot be in a hashtag dropped. Empty when nothing is left, which is no hashtag.
export function normalizeTag(name: string): string {
  let out = "";
  for (const char of name.normalize("NFKC")) {
    for (const lower of char.toLowerCase()) {
      out += FOLD.get(lower) ?? lower;
    }
  }
  return out.replace(INVALID, "");
}

// The status_tags name of an ActivityPub Hashtag's `name` ("#name"), as ActivityPub::Activity::Create#process_hashtag
// reads it: the whole name normalized, so its # (or a fullwidth or small one, # after NFKC) is dropped with the other
// characters a hashtag cannot hold.
export function hashtagObjectName(name: string): string {
  return normalizeTag(name);
}
