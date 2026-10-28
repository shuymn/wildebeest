import type { CustomEmoji } from "../../domain/custom-emojis";
import { httpUrl } from "../../platform/http-url";
import { EMOJI_SHORTCODE, isEmojiUrl } from "../../platform/stored-bounds";

// Custom emoji on the pages (HTML-3). A field's text references an emoji by `:name:`, read as the presenter's
// shortcodesIn reads it (the segments between two colons); a reference to one of the field's own emojis becomes an
// image while the allowance lasts, and stays escaped text past it. The images are bounded per field
// (EMOJI_FIELD_IMAGES), per page (EMOJI_PAGE_IMAGES) and by the bytes of their markup as written, escaped attributes
// included (EMOJI_PAGE_BYTES), in the order the page builds its fields: document order, the focal content first.

export const EMOJI_FIELD_IMAGES = 64;
export const EMOJI_PAGE_IMAGES = 512;
// 512 images of about 650 bytes each: a few hundred KiB a page at most.
export const EMOJI_PAGE_BYTES = 512 * 650;

// An emoji image: its shortcode (EMOJI_SHORTCODE) and its url (http(s), within EMOJI_URL_LIMIT and
// EMOJI_URL_ALPHABET).
export type EmojiRef = { shortcode: string; url: string };

// A run of inline text: plain text, which the page escapes, or an emoji image.
export type Inline = string | EmojiRef;

// What a page may still spend on emoji images. One per rendered page, made where the page is built.
export type EmojiAllowance = { images: number; bytes: number };

export function emojiAllowance(): EmojiAllowance {
  return { images: EMOJI_PAGE_IMAGES, bytes: EMOJI_PAGE_BYTES };
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" };

// The markup of an emoji image, exactly as the Emoji component writes it (hono/jsx's attribute escaping;
// test/web-emoji.test.ts compares the two), so the allowance charges the bytes the page holds.
export function emojiHtml(ref: EmojiRef): string {
  const escape = (value: string) => value.replace(/[&<>'"]/g, (c) => ESCAPES[c] ?? c);
  return `<img class="emoji" src="${escape(ref.url)}" alt=":${escape(ref.shortcode)}:" width="20" height="20" loading="lazy" decoding="async"/>`;
}

// One field's references: `text` for plain text (names, warnings, poll choices), `html` for a run of text the
// sanitizer has escaped (HTML-1: what it returns is written unescaped, so it keeps the escaped text as it is and adds
// only emojiHtml's markup). A reference in HTML is read within one run, between character references and tags, so
// one written with a character reference (`&#58;a&#58;`) stays text.
export type EmojiField = { text(text: string): Inline[]; html(escaped: string): string };

// The emojis `emojis` (a presented snapshot) offer a field, each judged again at the sink: a shortcode within
// EMOJI_SHORTCODE and a url that is http(s), serialized as it is and within the stored bounds (HTML-3).
function usable(emojis: readonly CustomEmoji[]): Map<string, EmojiRef> {
  const refs = new Map<string, EmojiRef>();
  for (const emoji of emojis) {
    const url = emoji.static_url;
    if (
      !refs.has(emoji.shortcode) &&
      EMOJI_SHORTCODE.test(emoji.shortcode) &&
      isEmojiUrl(url) &&
      httpUrl(url)?.href === url
    ) {
      refs.set(emoji.shortcode, { shortcode: emoji.shortcode, url });
    }
  }
  return refs;
}

// The fields of one snapshot on one page: the snapshot is judged once, and each call makes a field with its own
// count, charged to the page's allowance in the order the fields are made.
export function emojiFields(emojis: readonly CustomEmoji[], allowance: EmojiAllowance): () => EmojiField {
  const refs = usable(emojis);
  return () => field(refs, allowance);
}

// One field of `emojis` on the page whose allowance is `allowance`.
export function emojiField(emojis: readonly CustomEmoji[], allowance: EmojiAllowance): EmojiField {
  return emojiFields(emojis, allowance)();
}

function field(refs: ReadonlyMap<string, EmojiRef>, allowance: EmojiAllowance): EmojiField {
  let left = EMOJI_FIELD_IMAGES;
  // The image for `name`, charged to the field and the page, or null when it is not one of the field's emojis or the
  // allowance does not cover it.
  const take = (name: string): EmojiRef | null => {
    const ref = refs.get(name);
    if (ref === undefined || left === 0 || allowance.images === 0) {
      return null;
    }
    const bytes = emojiHtml(ref).length;
    if (bytes > allowance.bytes) {
      return null;
    }
    left--;
    allowance.images--;
    allowance.bytes -= bytes;
    return ref;
  };
  // Each segment strictly between two colons that names an image becomes it, the colons with it; any other colon
  // stays text. `:a:b:` is a then `b:`.
  const split = <T>(text: string, image: (ref: EmojiRef) => T, plain: (text: string) => T): T[] => {
    const segments = text.split(":");
    const out: T[] = [plain(segments[0] ?? "")];
    for (let i = 1; i < segments.length; i++) {
      const ref = i + 1 < segments.length ? take(segments[i]!) : null;
      if (ref === null) {
        out.push(plain(`:${segments[i]}`));
      } else {
        out.push(image(ref), plain(segments[i + 1]!));
        i++;
      }
    }
    return out;
  };
  return {
    text(text) {
      const parts: Inline[] = [];
      for (const part of split<Inline>(
        text,
        (ref) => ref,
        (plain) => plain,
      )) {
        const last = parts.at(-1);
        if (typeof part === "string" && typeof last === "string") {
          parts[parts.length - 1] = last + part;
        } else if (part !== "") {
          parts.push(part);
        }
      }
      return parts;
    },
    html(escaped) {
      return split(escaped, emojiHtml, (plain) => plain).join("");
    },
  };
}
