import { ascii, type ImageType, VP8X_ANIMATION, VP8X_BYTES, walkPng, walkWebp } from "./image-bytes";
import { u24le, walkGif } from "./remote-media-bytes";

// A still of an animated remote image (NET-3), made by remuxing its container, never by decoding or re-encoding:
//   - GIF: the header, the logical screen descriptor and the global colour table, then the first frame's graphic
//     control extension (its delay set to 0), image descriptor, local colour table and LZW data, then the trailer;
//   - APNG: the PNG without acTL, fcTL and fdAT, which is its default image: frame 0 when the first fcTL precedes
//     IDAT, otherwise the static fallback the file declares for viewers without animation;
//   - animated WebP: only when the first ANMF covers the whole canvas at offset 0, a VP8X without the animation flag,
//     the ICCP chunk, then that frame's ALPH and VP8 or VP8L chunks; the ANIM background colour is not applied (as
//     viewers commonly ignore it).
// Anything else (an AVIF, whose image sequences are refused; a JPEG) gets none. The input is a verified image
// (remote-media-bytes.ts verifyRemoteImage), so it walks; the work is at most two walks and one copy, linear in the
// input, with bookkeeping that does not grow with its chunk count (RES-2).

// The still of `bytes`, an image of `type`, in a new buffer of at most min(bytes.length, maxBytes) bytes, or null
// when none can be made within that.
export function imageStill(bytes: Uint8Array, type: ImageType, maxBytes: number): Uint8Array | null {
  const limit = Math.min(bytes.length, maxBytes);
  if (type === "image/png") {
    return pngStill(bytes, limit);
  }
  const still = type === "image/gif" ? gifStill(bytes) : type === "image/webp" ? webpStill(bytes) : null;
  if (still === null) {
    return null;
  }
  // At most four ranges (GIF) or five (WebP: header, VP8X, ICCP, ALPH, bitstream).
  const { ranges, patch } = still;
  const total = ranges.reduce((sum, [start, end]) => sum + (end - start), 0);
  if (total > limit) {
    return null;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const [start, end] of ranges) {
    out.set(bytes.subarray(start, end), at);
    at += end - start;
  }
  patch?.(out);
  return out;
}

// GIF89a section 23: the graphic control extension's sub-block is 4 bytes (packed fields, delay, transparent index).
const GCE_SIZE = 4;

type Still = { ranges: [number, number][]; patch?: (out: Uint8Array) => void };

function gifStill(bytes: Uint8Array): Still | null {
  let header = null as [number, number] | null;
  let control = null as [number, number] | null;
  let frame = null as [number, number] | null;
  const walked = walkGif(bytes, (block) => {
    if (block.kind === "header") {
      header = [block.start, block.end];
    } else if (block.kind === "extension" && block.label === 0xf9) {
      control = bytes[block.dataStart] === GCE_SIZE ? [block.start, block.end] : null;
    } else if (block.kind === "image") {
      frame = [block.start, block.end];
      return true;
    }
    return undefined;
  });
  if (walked !== true || header === null || frame === null) {
    return null;
  }
  // A verified GIF ends with its trailer.
  const trailer: [number, number] = [bytes.length - 1, bytes.length];
  if (bytes[trailer[0]] !== 0x3b) {
    return null;
  }
  if (control === null) {
    return { ranges: [header, frame, trailer] };
  }
  // The delay is bytes 4-5 of the control extension (21 F9 04, the packed fields, the delay), right after the header.
  const delay = header[1] - header[0] + 4;
  const patch = (out: Uint8Array) => {
    out[delay] = 0;
    out[delay + 1] = 0;
  };
  return { ranges: [header, control, frame, trailer], patch };
}

// The PNG still in two walks with constant bookkeeping, however many chunks the file has: the first sums the kept
// chunks and stops as soon as they pass `limit`, the second copies them.
function pngStill(bytes: Uint8Array, limit: number): Uint8Array | null {
  const kept = (type: string) => type !== "acTL" && type !== "fcTL" && type !== "fdAT";
  let total = 8;
  const sized = walkPng(bytes, (type, _start, length) => {
    if (kept(type)) {
      total += length + 12;
    }
    return total > limit ? true : undefined;
  });
  if (sized !== undefined) {
    return null;
  }
  const out = new Uint8Array(total);
  out.set(bytes.subarray(0, 8));
  let at = 8;
  walkPng(bytes, (type, start, length) => {
    if (kept(type)) {
      out.set(bytes.subarray(start - 8, start + length + 4), at);
      at += length + 12;
    }
    return undefined;
  });
  return out;
}

// The chunks a WebP still keeps from its first frame's data (RFC 9649 section 2.7.1.1): alpha and the bitstream.
const FRAME_CHUNKS = new Set(["ALPH", "VP8 ", "VP8L"]);
// The VP8X flags a still keeps: the ICC profile (0x20) and alpha (0x10).
const STILL_FLAGS = 0x30;

function webpStill(bytes: Uint8Array): Still | null {
  let vp8x = -1;
  let icc = null as [number, number] | null;
  let frame = null as { start: number; length: number } | null;
  const walked = walkWebp(bytes, (type, start, length) => {
    if (type === "VP8X" && length >= VP8X_BYTES) {
      vp8x = start;
    } else if (type === "ICCP") {
      icc = [start - 8, start + length + (length % 2)];
    } else if (type === "ANMF") {
      frame = { start, length };
      return true;
    }
    return undefined;
  });
  if (walked !== true || vp8x < 0 || frame === null) {
    return null;
  }
  const { start, length } = frame;
  const canvasWidth = u24le(bytes, vp8x + 4) + 1;
  const canvasHeight = u24le(bytes, vp8x + 7) + 1;
  const whole =
    length >= 16 &&
    u24le(bytes, start) === 0 &&
    u24le(bytes, start + 3) === 0 &&
    u24le(bytes, start + 6) + 1 === canvasWidth &&
    u24le(bytes, start + 9) + 1 === canvasHeight;
  if (!whole) {
    return null;
  }
  const ranges: [number, number][] = [
    [0, 12],
    [vp8x - 8, vp8x + VP8X_BYTES],
  ];
  if (icc !== null) {
    ranges.push(icc);
  }
  let bitstreams = 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = start + length;
  for (let i = start + 16; i + 8 <= end;) {
    const chunk = ascii(bytes, i, 4);
    const size = view.getUint32(i + 4, true);
    const next = i + 8 + size + (size % 2);
    if (next > end) {
      return null;
    }
    if (FRAME_CHUNKS.has(chunk)) {
      if (ranges.length === 5) {
        return null;
      }
      ranges.push([i, next]);
      bitstreams += chunk === "ALPH" ? 0 : 1;
    }
    i = next;
  }
  if (bitstreams !== 1) {
    return null;
  }
  const patch = (out: Uint8Array) => {
    const outView = new DataView(out.buffer, out.byteOffset, out.byteLength);
    outView.setUint32(4, out.length - 8, true);
    // The VP8X chunk is kept at its 10 data bytes: its size field, then its flags without animation.
    outView.setUint32(16, VP8X_BYTES, true);
    out[20] = (out[20] ?? 0) & STILL_FLAGS & ~VP8X_ANIMATION;
  };
  return { ranges, patch };
}
