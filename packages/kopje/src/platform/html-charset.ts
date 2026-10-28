// The character encoding of a fetched HTML page (federation/web-page.ts), as the HTML Standard's encoding sniffing
// chooses it (§13.2.3.2) without the confidence and change-the-encoding steps: a BOM, then a valid charset from the
// Content-Type header, then a valid one from the byte prescan of the first 1,024 bytes, then UTF-8. Kopje does not
// guess from frequency statistics as browsers may (the standard leaves that step optional). A label counts only when
// TextDecoder accepts it, under its canonical name; an invalid one passes to the next source. The output is a label
// only: a wrong one can mis-decode text, never create markup.

export type CharsetSource = "bom" | "header" | "meta" | "default";
export type Charset = { label: string; source: CharsetSource; bomLength: number };

const PRESCAN_BYTES = 1024;

// The canonical name of an encoding label (the Encoding Standard's "get an encoding"), or null.
export function encodingOf(label: string): string | null {
  try {
    return new TextDecoder(label).encoding;
  } catch {
    return null;
  }
}

export function chooseCharset(bytes: Uint8Array, headerCharset: string | null): Charset {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { label: "utf-8", source: "bom", bomLength: 3 };
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { label: "utf-16be", source: "bom", bomLength: 2 };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { label: "utf-16le", source: "bom", bomLength: 2 };
  }
  const header = headerCharset === null ? null : encodingOf(headerCharset);
  if (header !== null) {
    return { label: header, source: "header", bomLength: 0 };
  }
  const meta = prescanCharset(bytes);
  if (meta !== null) {
    return { label: meta, source: "meta", bomLength: 0 };
  }
  return { label: "utf-8", source: "default", bomLength: 0 };
}

const isSpace = (b: number | undefined) => b === 0x09 || b === 0x0a || b === 0x0c || b === 0x0d || b === 0x20;
const isLetter = (b: number | undefined) => b !== undefined && ((b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a));
const lower = (b: number) => (b >= 0x41 && b <= 0x5a ? b + 0x20 : b);

// Thrown inside the prescan when it runs past its 1,024 bytes: the standard then aborts it, and it finds nothing.
class EndOfInput extends Error {}

// The prescan of §13.2.3.2 over the first 1,024 bytes: comments skipped, <meta> attributes read by the standard's own
// "get an attribute" (its quoting, ASCII lowercasing, no character reference decoding), other tags' attributes skipped,
// </, <! and <? up to the next >. No raw-text, foreign-content or tree logic. O(1,024).
export function prescanCharset(input: Uint8Array): string | null {
  const end = Math.min(input.length, PRESCAN_BYTES);
  let position = 0;
  const at = (i: number): number => {
    if (i >= end) {
      throw new EndOfInput();
    }
    return input[i] as number;
  };
  const startsWith = (text: string, caseless: boolean): boolean => {
    for (let i = 0; i < text.length; i++) {
      const b = input[position + i];
      if (position + i >= end || b === undefined || (caseless ? lower(b) : b) !== text.charCodeAt(i)) {
        return false;
      }
    }
    return true;
  };
  // "Get an attribute": the name and value as byte strings (code points equal to the bytes), or null at '>'.
  const attribute = (): [string, string] | null => {
    while (isSpace(at(position)) || at(position) === 0x2f) {
      position++;
    }
    if (at(position) === 0x3e) {
      return null;
    }
    let name = "";
    let value = "";
    for (;;) {
      const b = at(position);
      if (b === 0x3d && name !== "") {
        position++;
        break;
      }
      if (isSpace(b)) {
        while (isSpace(at(position))) {
          position++;
        }
        if (at(position) !== 0x3d) {
          return [name, ""];
        }
        position++;
        break;
      }
      if (b === 0x2f || b === 0x3e) {
        return [name, ""];
      }
      name += String.fromCharCode(lower(b));
      position++;
    }
    while (isSpace(at(position))) {
      position++;
    }
    const first = at(position);
    if (first === 0x22 || first === 0x27) {
      position++;
      for (;;) {
        const b = at(position);
        position++;
        if (b === first) {
          return [name, value];
        }
        value += String.fromCharCode(lower(b));
      }
    }
    if (first === 0x3e) {
      return [name, ""];
    }
    value += String.fromCharCode(lower(first));
    position++;
    for (;;) {
      const b = at(position);
      if (isSpace(b) || b === 0x3e) {
        return [name, value];
      }
      value += String.fromCharCode(lower(b));
      position++;
    }
  };
  try {
    while (position < end) {
      if (startsWith("<!--", false)) {
        // The first '>' preceded by "--" after the '<', so "<!-->" ends at once.
        position += 2;
        while (!(at(position) === 0x2d && at(position + 1) === 0x2d && at(position + 2) === 0x3e)) {
          position++;
        }
        position += 3;
      } else if (startsWith("<meta", true) && (isSpace(input[position + 5]) || input[position + 5] === 0x2f)) {
        position += 6;
        const found = metaCharset(attribute);
        if (found !== null) {
          return found;
        }
      } else if (
        at(position) === 0x3c &&
        (isLetter(input[position + 1]) || (input[position + 1] === 0x2f && isLetter(input[position + 2])))
      ) {
        position += input[position + 1] === 0x2f ? 2 : 1;
        while (!isSpace(at(position)) && at(position) !== 0x3e) {
          position++;
        }
        while (attribute() !== null) {
          // Other tags' attributes are skipped.
        }
        position++;
      } else if (startsWith("<!", false) || startsWith("</", false) || startsWith("<?", false)) {
        while (at(position) !== 0x3e) {
          position++;
        }
        position++;
      } else {
        position++;
      }
    }
  } catch (error) {
    if (error instanceof EndOfInput) {
      return null;
    }
    throw error;
  }
  return null;
}

// The <meta> steps of the prescan: the encoding a charset attribute, or an http-equiv content-type with a content
// charset, names, or null to go on scanning.
function metaCharset(attribute: () => [string, string] | null): string | null {
  const seen = new Set<string>();
  let gotPragma = false;
  let needPragma: boolean | null = null;
  let charset: string | null = null;
  for (let next = attribute(); next !== null; next = attribute()) {
    const [name, value] = next;
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    if (name === "http-equiv" && value === "content-type") {
      gotPragma = true;
    } else if (name === "content" && charset === null) {
      const label = charsetFromContent(value);
      const encoding = label === null ? null : encodingOf(label);
      if (encoding !== null) {
        charset = encoding;
        needPragma = true;
      }
    } else if (name === "charset") {
      charset = encodingOf(value);
      needPragma = false;
    }
  }
  if (needPragma === null || (needPragma && !gotPragma) || charset === null) {
    return null;
  }
  if (charset === "utf-16le" || charset === "utf-16be") {
    return "utf-8";
  }
  return charset === "x-user-defined" ? "windows-1252" : charset;
}

// "Extracting a character encoding from a meta element" (§2.6.5): the label after "charset" and "=" in a content value.
export function charsetFromContent(content: string): string | null {
  let position = 0;
  for (;;) {
    const found = content.toLowerCase().indexOf("charset", position);
    if (found < 0) {
      return null;
    }
    position = found + 7;
    while (isSpace(content.charCodeAt(position))) {
      position++;
    }
    if (content[position] === "=") {
      position++;
      break;
    }
  }
  while (isSpace(content.charCodeAt(position))) {
    position++;
  }
  const first = content[position];
  if (first === undefined) {
    return null;
  }
  if (first === '"' || first === "'") {
    const close = content.indexOf(first, position + 1);
    return close < 0 ? null : content.slice(position + 1, close);
  }
  let stop = position;
  while (stop < content.length && !isSpace(content.charCodeAt(stop)) && content[stop] !== ";") {
    stop++;
  }
  return content.slice(position, stop);
}
