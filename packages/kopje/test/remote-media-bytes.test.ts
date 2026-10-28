import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { IMAGE_MATRIX_LIMIT, type ImageType, retainedMetadata } from "../src/platform/image-bytes";
import {
  RECOGNITION_PREFIX_BYTES,
  recognizeMedia,
  remoteImageMetadata,
  verifyRemoteImage,
  type VerifiedImage,
} from "../src/platform/remote-media-bytes";
import {
  ANIMATED_GIF,
  ANIMATED_WEBP,
  APNG,
  AVIF,
  GIF,
  JPEG_ICC,
  JPEG_ORIENTATION_6,
  JPEG_WITH_GPS,
  PNG_ICC,
  PNG_PLAIN,
  PNG_WITH_GPS,
  WEBP_ICC,
  WEBP_PLAIN,
  WEBP_WITH_GPS,
  WEBP_XMP,
  WIDE_PNG,
} from "./fixtures/images";
import { bytes } from "./media-helpers";
import {
  animatedWebp,
  box,
  concat,
  exifOrientation,
  flac,
  fullBox,
  gifComment,
  gifExtension,
  gifPlainText,
  gifWithBlocks,
  gifXmp,
  id3,
  imageFacts,
  jpegMarkers,
  jpegScans,
  jpegSegment,
  madeFixture,
  mp3Frames,
  mp4,
  oggPage,
  pngWithChunkBeforeEnd,
  restartJpeg,
  riff,
  THEORA_PACKET,
  VORBIS_PACKET,
  wav,
  webm,
  webpChunk,
  webpChunks,
} from "./remote-media-fixtures";
import { encodeWebp } from "./webp-fixtures";

const text = (value: string) => new TextEncoder().encode(value);
const ALL: readonly ImageType[] = ["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif"];

function verified(input: Uint8Array, types: readonly ImageType[] = ALL): VerifiedImage {
  const result = verifyRemoteImage(input, types);
  if (!result.ok) {
    throw new Error(`refused: ${result.refusal}`);
  }
  return result;
}

function refusal(input: Uint8Array, types: readonly ImageType[] = ALL) {
  const result = verifyRemoteImage(input, types);
  return result.ok ? "accepted" : result.refusal;
}

// The first RECOGNITION_PREFIX_BYTES bytes of a file, as the streamed sink hands them over.
const recognize = (file: Uint8Array) =>
  recognizeMedia(file.subarray(0, Math.min(file.length, RECOGNITION_PREFIX_BYTES)), file.length);

// The JPEG with `segments` inserted right before the byte at `at`.
const insertAt = (jpeg: Uint8Array, at: number, ...segments: Uint8Array[]) =>
  concat(jpeg.subarray(0, at), ...segments, jpeg.subarray(at));

describe("verifyRemoteImage: recognition", () => {
  it("accepts every image type with its real structure, and reports its size and frames", async () => {
    const avif = await madeFixture("avif");
    for (const [name, file, type, width, height, animated] of [
      ["JPEG", bytes(JPEG_ICC), "image/jpeg", 8, 6, false],
      ["PNG", bytes(PNG_PLAIN), "image/png", 8, 6, false],
      ["APNG", bytes(APNG), "image/png", 8, 6, true],
      ["GIF", bytes(GIF), "image/gif", 12, 12, false],
      ["animated GIF", bytes(ANIMATED_GIF), "image/gif", 10, 8, true],
      ["WebP", bytes(WEBP_PLAIN), "image/webp", 8, 6, false],
      ["animated WebP", bytes(ANIMATED_WEBP), "image/webp", 8, 6, true],
      ["AVIF", bytes(AVIF), "image/avif", null, null, false],
      ["sharp AVIF", avif, "image/avif", 64, 48, false],
    ] as const) {
      const result = verified(file);
      expect(result, name).toMatchObject({ type, animated });
      if (width !== null) {
        expect([result.width, result.height], name).toEqual([width, height]);
      }
      expect(remoteImageMetadata(result.bytes, type), name).toBeNull();
    }
  });

  it("reports a JPEG as one frame, a GIF and an AVIF by their own walks (where the shared helpers fail closed)", () => {
    expect(verified(bytes(JPEG_ICC)).animated).toBe(false);
    expect(verified(bytes(GIF)).animated).toBe(false);
    expect(verified(bytes(AVIF)).animated).toBe(false);
    expect(remoteImageMetadata(bytes(GIF), "image/gif")).toBeNull();
    expect(remoteImageMetadata(bytes(AVIF), "image/avif")).toBeNull();
    // The shared MEDIA-3 helpers, which only judge re-encoded output, do not know these types.
    expect(retainedMetadata(bytes(GIF), "image/gif")).toBe("unreadable");
  });

  it("refuses SVG, HTML, PDF, video and audio, and types its kind does not take", () => {
    for (const [name, file] of [
      ["SVG", text('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
      ["SVG with a BOM", text('﻿<svg xmlns="http://www.w3.org/2000/svg"/>')],
      ["HTML", text("<!doctype html><script>alert(1)</script>")],
      ["PDF", text("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n")],
      ["MP4", mp4()],
      ["WebM", webm()],
    ] as const) {
      expect(refusal(file), name).toBe("type");
    }
    // An emoji is PNG, GIF or WebP: a JPEG is refused for it, by its signature, not its name.
    expect(refusal(bytes(JPEG_ICC), ["image/png", "image/gif", "image/webp"])).toBe("type");
    expect(refusal(bytes(AVIF), ["image/jpeg", "image/png", "image/gif", "image/webp"])).toBe("type");
  });

  it("refuses an image past the pixel limit, read from its header, and keeps one at it", () => {
    // A PNG's IHDR stating 4096 × 4097 pixels, one row past the limit (16,777,216 = 4096 × 4096).
    const png = bytes(PNG_PLAIN);
    const view = new DataView(png.buffer);
    view.setUint32(16, 4096);
    view.setUint32(20, 4096);
    expect(refusal(png.slice())).toBe("accepted");
    view.setUint32(20, 4097);
    expect(IMAGE_MATRIX_LIMIT).toBe(4096 * 4096);
    expect(refusal(png)).toBe("pixels");
    // A GIF whose frame is past the limit inside a small screen.
    const gif = bytes(GIF);
    gif.set([0xff, 0xff, 0xff, 0xff], 13 + 6 + 8 + 5);
    expect(refusal(gif)).toBe("pixels");
    // A JPEG's SOF0 stating 5000 × 5000.
    const jpeg = bytes(JPEG_ICC);
    const sof = jpeg.findIndex((b, i) => b === 0xff && jpeg[i + 1] === 0xc0);
    jpeg.set([0x13, 0x88, 0x13, 0x88], sof + 5);
    expect(refusal(jpeg)).toBe("pixels");
    // A WebP canvas of 2^24 × 6, its frames within it.
    const webp = bytes(ANIMATED_WEBP);
    webp.set([0xff, 0xff, 0xff, 0x05, 0x00, 0x00], 24);
    expect(refusal(webp)).toBe("pixels");
  });
});

describe("verifyRemoteImage: JPEG metadata to EOI", () => {
  it("strips APP1, APP13 and COM between scans and after the last scan, and data after EOI", async () => {
    const progressive = await madeFixture("progressive-jpeg");
    const { sos, eoi } = jpegScans(progressive);
    expect(sos.length).toBeGreaterThan(1);
    // Byte stuffing in the entropy-coded data.
    expect(progressive.some((b, i) => b === 0xff && progressive[i + 1] === 0x00)).toBe(true);
    const second = sos[1] ?? 0;
    const dirty = concat(
      insertAt(
        insertAt(
          progressive,
          eoi,
          jpegSegment(0xe1, exifOrientation(1)),
          jpegSegment(0xed, "Photoshop 3.0\0"),
          jpegSegment(0xfe, "after the last scan"),
        ),
        second,
        jpegSegment(0xe1, "http://ns.adobe.com/xap/1.0/\0<x/>"),
        jpegSegment(0xfe, "between scans"),
        jpegSegment(0xed, "Photoshop 3.0\0"),
        jpegSegment(0xe3, "META"),
      ),
      text("<html>after EOI</html>"),
    );
    const before = await imageFacts(dirty);
    expect(before).toMatchObject({ exif: true, xmp: true });
    const original = dirty.slice();
    const result = verified(dirty);
    expect(result.bytes.length).toBeLessThan(original.length);
    expect(remoteImageMetadata(result.bytes, "image/jpeg")).toBeNull();
    // An independent marker scan: no APP1, APP13, COM or APP3 is left, the ICC profile and every scan are kept.
    const markers = jpegMarkers(result.bytes);
    expect(markers.filter((m) => m === 0xe1 || m === 0xed || m === 0xfe || m === 0xe3)).toEqual([]);
    expect(markers.filter((m) => m === 0xe2)).toHaveLength(1);
    expect(markers.filter((m) => m === 0xda)).toHaveLength(sos.length);
    expect(markers.at(-1)).toBe(0xd9);
    expect(result.bytes.at(-2)).toBe(0xff);
    expect(result.bytes.at(-1)).toBe(0xd9);
    // An independent reader finds no Exif, XMP or IPTC and the same pixels.
    const after = await imageFacts(result.bytes);
    expect(after).toMatchObject({ format: "jpeg", exif: false, xmp: false, iptc: false });
    expect(after?.rgba).toEqual(before?.rgba);
  });

  it("walks restart markers and stuffing in the entropy-coded data, and keeps them", async () => {
    // Levels whose DC codes put a 0xFF byte in the data, so that it is stuffed.
    const jpeg = restartJpeg([255, 0, 128, 255, 255, 64, 200, 17, 255, 255]);
    expect(jpeg.some((b, i) => b === 0xff && jpeg[i + 1] === 0x00)).toBe(true);
    const restarts = jpeg.filter((b, i) => jpeg[i - 1] === 0xff && b >= 0xd0 && b <= 0xd7).length;
    expect(restarts).toBe(9);
    const decoded = await imageFacts(jpeg);
    expect(decoded).toMatchObject({ format: "jpeg", width: 80, height: 8 });
    // Fill bytes before each restart marker: the scan goes on through them, and a decoder reads the same pixels.
    const padded = restartJpeg([255, 0, 128, 255, 255, 64, 200, 17, 255, 255], 2);
    expect(padded.some((b, i) => b === 0xff && padded[i + 1] === 0xff && padded[i + 2] === 0xff)).toBe(true);
    expect([...verified(padded.slice()).bytes]).toEqual([...padded]);
    expect((await imageFacts(padded))?.rgba).toEqual(decoded?.rgba);
    const withComment = insertAt(jpeg, jpeg.length - 2, jpegSegment(0xfe, "after the scan"));
    const result = verified(withComment);
    expect([...result.bytes]).toEqual([...jpeg]);
    expect((await imageFacts(result.bytes))?.rgba).toEqual(decoded?.rgba);
  });

  it("keeps a view of the input buffer (the strip works in place)", () => {
    const input = bytes(JPEG_WITH_GPS);
    const result = verified(input);
    expect(result.bytes.buffer).toBe(input.buffer);
    expect(result.bytes.byteOffset).toBe(input.byteOffset);
    expect(retainedMetadata(bytes(JPEG_WITH_GPS), "image/jpeg")).toBe("exif");
    expect(remoteImageMetadata(result.bytes, "image/jpeg")).toBeNull();
  });

  it("refuses a JPEG that does not walk to EOI, or holds two frames", () => {
    const jpeg = bytes(JPEG_ICC);
    expect(refusal(jpeg.subarray(0, jpeg.length - 2))).toBe("malformed");
    expect(refusal(jpeg.subarray(0, 40))).toBe("malformed");
    // A second SOI, and a byte outside a scan that is no marker.
    expect(refusal(insertAt(jpeg, 2, new Uint8Array([0xff, 0xd8])))).toBe("malformed");
    const sof = jpeg.findIndex((b, i) => b === 0xff && jpeg[i + 1] === 0xc0);
    expect(refusal(insertAt(jpeg, sof, new Uint8Array([0x00])))).toBe("malformed");
    const length = ((jpeg[sof + 2] ?? 0) << 8) | (jpeg[sof + 3] ?? 0);
    expect(refusal(insertAt(jpeg, sof, jpeg.slice(sof, sof + 2 + length)))).toBe("malformed");
  });
});

describe("verifyRemoteImage: orientation", () => {
  it.each([2, 3, 4, 5, 6, 7, 8])("refuses orientation %i in JPEG, PNG and WebP, in either byte order", (o) => {
    const jpeg = bytes(JPEG_ICC);
    const png = bytes(PNG_PLAIN);
    for (const order of ["II", "MM"] as const) {
      const exif = exifOrientation(o, order);
      expect(refusal(insertAt(jpeg, 2, jpegSegment(0xe1, exif))), order).toBe("orientation");
      expect(refusal(pngWithChunkBeforeEnd(png, "eXIf", exif.subarray(6))), order).toBe("orientation");
      const webp = riff([
        ...webpChunks(bytes(WEBP_ICC)).map(([type, payload]) => webpChunk(type, payload)),
        webpChunk("EXIF", exif.subarray(6)),
      ]);
      expect(refusal(webp), order).toBe("orientation");
    }
  });

  it("refuses the orientation fixture and an Exif block it cannot read, and keeps orientation 1 (stripped)", () => {
    expect(refusal(bytes(JPEG_ORIENTATION_6))).toBe("orientation");
    const jpeg = bytes(JPEG_ICC);
    expect(refusal(insertAt(jpeg, 2, jpegSegment(0xe1, concat(text("Exif\0\0"), text("XX*\0")))))).toBe("orientation");
    const kept = verified(insertAt(jpeg, 2, jpegSegment(0xe1, exifOrientation(1, "MM"))));
    expect([...kept.bytes]).toEqual([...jpeg]);
    const png = verified(pngWithChunkBeforeEnd(bytes(PNG_PLAIN), "eXIf", exifOrientation(1).subarray(6)));
    expect([...png.bytes]).toEqual([...bytes(PNG_PLAIN)]);
  });

  it("refuses an AVIF with a non-identity irot or any imir, and keeps irot 0", async () => {
    const avif = await madeFixture("avif");
    // The pixi property (16 bytes) rewritten in place as a 16-byte irot or imir, so every offset stays valid.
    const pixi = avif.findIndex((_, i) => String.fromCharCode(...avif.subarray(i, i + 4)) === "pixi") - 4;
    expect(pixi).toBeGreaterThan(0);
    const withProperty = (type: string, value: number) => {
      const out = avif.slice();
      const size = new DataView(out.buffer).getUint32(pixi);
      out.set(text(type), pixi + 4);
      out.fill(0, pixi + 8, pixi + size);
      out[pixi + 8] = value;
      return out;
    };
    expect(refusal(withProperty("irot", 1))).toBe("orientation");
    expect(refusal(withProperty("irot", 3))).toBe("orientation");
    expect(refusal(withProperty("imir", 0))).toBe("orientation");
    expect(refusal(withProperty("irot", 0))).toBe("accepted");
  });
});

describe("verifyRemoteImage: PNG, WebP, GIF and AVIF metadata", () => {
  it("strips PNG eXIf, text and time chunks and unknown ancillary chunks, and refuses an unknown critical chunk", async () => {
    const plain = bytes(PNG_PLAIN);
    let dirty = plain;
    for (const [type, payload] of [
      ["tEXt", text("Author\0alice")],
      ["zTXt", text("Comment\0\0x")],
      ["iTXt", text("XML:com.adobe.xmp\0\0\0\0\0<x/>")],
      ["tIME", new Uint8Array(7)],
      ["eXIf", exifOrientation(1).subarray(6)],
      ["bKGD", new Uint8Array(6)],
    ] as const) {
      dirty = pngWithChunkBeforeEnd(dirty, type, payload);
    }
    const result = verified(dirty);
    expect([...result.bytes]).toEqual([...plain]);
    expect(verified(bytes(PNG_WITH_GPS)).bytes.length).toBeLessThan(bytes(PNG_WITH_GPS).length);
    expect(await imageFacts(verified(bytes(PNG_WITH_GPS)).bytes)).toMatchObject({ exif: false, comments: 0 });
    expect(refusal(pngWithChunkBeforeEnd(plain, "XYZW", new Uint8Array(1)))).toBe("malformed");
    // Colour profiles stay.
    expect(verified(bytes(PNG_ICC)).bytes.length).toBe(bytes(PNG_ICC).length);
  });

  it("strips WebP EXIF and XMP, clears their VP8X flags and rewrites the RIFF size", async () => {
    for (const fixture of [WEBP_WITH_GPS, WEBP_XMP]) {
      const input = bytes(fixture);
      const before = await imageFacts(input);
      const result = verified(input);
      expect(webpChunks(result.bytes).map(([type]) => type)).not.toContain("EXIF");
      expect(webpChunks(result.bytes).map(([type]) => type)).not.toContain("XMP ");
      expect((result.bytes[20] ?? 0) & 0x0c).toBe(0);
      expect(new DataView(result.bytes.buffer, result.bytes.byteOffset).getUint32(4, true)).toBe(
        result.bytes.length - 8,
      );
      const after = await imageFacts(result.bytes);
      expect(after).toMatchObject({ exif: false, xmp: false });
      expect(after?.rgba).toEqual(before?.rgba);
    }
    expect(verified(bytes(WEBP_ICC)).bytes.length).toBe(bytes(WEBP_ICC).length);
  });

  it("strips GIF comments, plain text, foreign application extensions and data after the trailer", async () => {
    const gif = bytes(ANIMATED_GIF);
    // The first block after the header and its global colour table (2 entries).
    const at = 13 + 6;
    const dirty = concat(
      gifWithBlocks(gif, at, gifComment("shot by alice"), gifXmp(), gifPlainText()),
      text("appended"),
    );
    expect(remoteImageMetadata(gifWithBlocks(gif, at, gifComment("shot by alice")), "image/gif")).toBe("comment");
    expect(remoteImageMetadata(dirty, "image/gif")).toBe("unreadable");
    const before = await imageFacts(gif);
    const result = verified(dirty);
    expect([...result.bytes]).toEqual([...gif]);
    expect((await imageFacts(result.bytes))?.rgba).toEqual(before?.rgba);
    expect(remoteImageMetadata(gifWithBlocks(gif, at, gifXmp()), "image/gif")).toBe("segment");
    expect(remoteImageMetadata(gifWithBlocks(gif, at, gifPlainText()), "image/gif")).toBe("text");
    // The looping extension is kept.
    expect(verified(gif).bytes.length).toBe(gif.length);
    expect(refusal(gifWithBlocks(gif, at, gifExtension(0x02, new Uint8Array(3))))).toBe("malformed");
    expect(refusal(gif.subarray(0, gif.length - 1))).toBe("malformed");
  });

  it("refuses an AVIF with an Exif item or a foreign top-level box", async () => {
    const exif = await madeFixture("avif-exif");
    expect((await imageFacts(exif))?.exif).toBe(true);
    expect(remoteImageMetadata(exif, "image/avif")).toBe("exif");
    expect(refusal(exif)).toBe("metadata");
    const plain = bytes(AVIF);
    expect(refusal(concat(plain, box("uuid", new Uint8Array(16), text("<x:xmpmeta/>"))))).toBe("metadata");
    // An infe of type mime (XMP) in place of the av01 one.
    const mime = plain.slice();
    const infe = mime.findIndex((_, i) => String.fromCharCode(...mime.subarray(i, i + 4)) === "av01");
    mime.set(text("mime"), infe);
    expect(remoteImageMetadata(mime, "image/avif")).toBe("xmp");
    expect(refusal(mime)).toBe("metadata");
  });
});

describe("verifyRemoteImage: malformed input", () => {
  it("never reads out of bounds or throws on truncated or mutated files", { timeout: 60_000 }, () => {
    const fixtures = [
      bytes(JPEG_ICC),
      bytes(JPEG_WITH_GPS),
      bytes(PNG_PLAIN),
      bytes(APNG),
      bytes(ANIMATED_GIF),
      bytes(WEBP_ICC),
      bytes(ANIMATED_WEBP),
      bytes(AVIF),
      bytes(WIDE_PNG),
    ];
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: fixtures.length - 1 }),
        fc.array(fc.tuple(fc.nat(), fc.integer({ min: 0, max: 255 })), { maxLength: 8 }),
        fc.nat(),
        (index, edits, cut) => {
          const file = (fixtures[index] ?? new Uint8Array(0)).slice();
          for (const [at, value] of edits) {
            file[at % file.length] = value;
          }
          const input = file.subarray(0, file.length - (cut % (file.length + 1)));
          const result = verifyRemoteImage(input, ALL);
          if (result.ok) {
            expect(result.bytes.length).toBeLessThanOrEqual(input.length);
            expect(remoteImageMetadata(result.bytes, result.type)).toBeNull();
          }
          for (const type of ALL) {
            remoteImageMetadata(input, type);
          }
        },
      ),
      { numRuns: 2000 },
    );
  });

  it("walks a hostile 16 MiB file of each type in linear time", { timeout: 60_000 }, () => {
    const size = 16 * 1024 * 1024;
    // A JPEG scan of one long entropy run, a GIF of one-byte sub-blocks, a PNG and a WebP of tiny chunks.
    const jpegHead = bytes(JPEG_ICC);
    const sos = jpegScans(jpegHead).sos[0] ?? 0;
    const length = ((jpegHead[sos + 2] ?? 0) << 8) | (jpegHead[sos + 3] ?? 0);
    const jpeg = concat(
      jpegHead.subarray(0, sos + 2 + length),
      new Uint8Array(size).fill(0x01),
      new Uint8Array([0xff, 0xd9]),
    );
    const gifBody = new Uint8Array(size);
    for (let i = 0; i + 1 < size; i += 2) {
      gifBody[i] = 1;
    }
    const gif = concat(
      bytes(GIF).subarray(0, 13 + 6),
      new Uint8Array([0x21, 0xfe]),
      gifBody,
      new Uint8Array([0, 0x3b]),
    );
    const png = bytes(PNG_PLAIN);
    const tiny = concat(new Uint8Array([0, 0, 0, 0]), text("tIME"), new Uint8Array(4));
    const pngBody = new Uint8Array(Math.floor(size / 12) * 12);
    for (let i = 0; i < pngBody.length; i += 12) {
      pngBody.set(tiny, i);
    }
    const hostilePng = concat(png.subarray(0, png.length - 12), pngBody, png.subarray(png.length - 12));
    for (const [name, file] of [
      ["JPEG", jpeg],
      ["GIF", gif],
      ["PNG", hostilePng],
    ] as const) {
      const start = performance.now();
      const result = verifyRemoteImage(file, ALL);
      expect(performance.now() - start, name).toBeLessThan(5000);
      expect(result.ok || result.refusal, name).not.toBe("type");
    }
  });
});

// An M4A whose mdat precedes moov and is sized in 64 bits (size 1 and a largesize).
function largeMdatFirst(): Uint8Array {
  const file = mp4({ brands: ["M4A ", "isom"], handlers: ["soun"] });
  const ftypEnd = new DataView(file.buffer).getUint32(0);
  const large = new Uint8Array(16 + 32);
  const view = new DataView(large.buffer);
  view.setUint32(0, 1);
  large.set(text("mdat"), 4);
  view.setBigUint64(8, BigInt(large.length));
  const moovEnd = ftypEnd + new DataView(file.buffer).getUint32(ftypEnd);
  return concat(file.subarray(0, ftypEnd), large, file.subarray(ftypEnd, moovEnd));
}

describe("recognizeMedia", () => {
  it("recognizes video and audio by their containers", () => {
    for (const [name, file, type, category] of [
      ["MP4 with video and audio", mp4(), "video/mp4", "video"],
      ["MP4 with video only", mp4({ handlers: ["vide"] }), "video/mp4", "video"],
      ["M4A", mp4({ brands: ["M4A ", "mp42", "isom"], handlers: ["soun"] }), "audio/mp4", "audio"],
      ["M4A with a 64-bit mdat first", largeMdatFirst(), "audio/mp4", "audio"],
      ["WebM", webm(), "video/webm", "video"],
      ["WebM audio", webm({ tracks: [2] }), "audio/webm", "audio"],
      ["MP3 with an ID3 tag", concat(id3(), mp3Frames()), "audio/mpeg", "audio"],
      ["MP3 without a tag", mp3Frames(), "audio/mpeg", "audio"],
      ["FLAC", flac(), "audio/flac", "audio"],
      ["FLAC after an ID3 tag", concat(id3(), flac()), "audio/flac", "audio"],
      ["WAV", wav(), "audio/wav", "audio"],
      ["WAV of floats", wav(3), "audio/wav", "audio"],
    ] as const) {
      expect(recognize(file), name).toEqual({ ok: true, type, category });
    }
  });

  it("refuses HEIF and AVIF branded as video, QuickTime, and a moov past the prefix", () => {
    for (const brands of [
      ["mp42", "mif1", "heic"],
      ["heic", "mif1"],
      ["msf1", "iso8"],
      ["avis", "msf1"],
    ]) {
      expect(recognize(mp4({ brands })), brands.join()).toEqual({ ok: false, refusal: "heif" });
    }
    expect(recognize(mp4({ brands: ["qt  "] }))).toEqual({ ok: false, refusal: "quicktime" });
    expect(recognize(mp4({ brands: ["isom", "qt  "] }))).toEqual({ ok: false, refusal: "quicktime" });
    const late = mp4({ before: RECOGNITION_PREFIX_BYTES + 1024 });
    expect(recognize(late)).toEqual({ ok: false, refusal: "moov" });
    // The same layout within the prefix is read.
    expect(recognize(mp4({ before: 4096 }))).toMatchObject({ ok: true, category: "video" });
    expect(recognize(concat(mp4({ handlers: [] })))).toEqual({ ok: false, refusal: "tracks" });
    expect(recognize(mp4({ handlers: ["text"] }))).toEqual({ ok: false, refusal: "tracks" });
  });

  it("refuses Ogg whatever it carries, Matroska, and a WebM whose tracks it cannot read before a cluster", () => {
    expect(recognize(oggPage(THEORA_PACKET))).toEqual({ ok: false, refusal: "ogg" });
    expect(recognize(oggPage(VORBIS_PACKET))).toEqual({ ok: false, refusal: "ogg" });
    expect(recognize(webm({ docType: "matroska" }))).toEqual({ ok: false, refusal: "matroska" });
    expect(recognize(webm({ clusterFirst: true }))).toEqual({ ok: false, refusal: "tracks" });
    expect(recognize(webm({ tracks: [0x11] }))).toEqual({ ok: false, refusal: "tracks" });
    // A video track is a video, whatever the file was declared as.
    expect(recognize(webm({ tracks: [2, 1] }))).toMatchObject({ category: "video" });
  });

  it("refuses an ID3 tag with no frames, a lone frame, and anything else", () => {
    expect(recognize(concat(id3(), new Uint8Array(64)))).toEqual({ ok: false, refusal: "type" });
    expect(recognize(id3(false))).toEqual({ ok: false, refusal: "type" });
    expect(recognize(mp3Frames(1))).toEqual({ ok: false, refusal: "type" });
    expect(recognize(wav(0x55))).toEqual({ ok: false, refusal: "type" });
    for (const file of [
      bytes(JPEG_ICC),
      bytes(PNG_PLAIN),
      bytes(GIF),
      bytes(AVIF),
      text('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      text("%PDF-1.7\n"),
    ]) {
      expect(recognize(file).ok).toBe(false);
    }
    // An AVIF still image starts with ftyp too, and is refused by its brand.
    expect(recognize(bytes(AVIF))).toEqual({ ok: false, refusal: "heif" });
  });

  it("never reads out of bounds or throws on truncated or mutated files", { timeout: 60_000 }, () => {
    const fixtures = [mp4(), webm(), concat(id3(), mp3Frames()), flac(), wav(), oggPage(VORBIS_PACKET)];
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: fixtures.length - 1 }),
        fc.array(fc.tuple(fc.nat(), fc.integer({ min: 0, max: 255 })), { maxLength: 8 }),
        fc.nat(),
        (index, edits, cut) => {
          const file = (fixtures[index] ?? new Uint8Array(0)).slice();
          for (const [at, value] of edits) {
            file[at % file.length] = value;
          }
          const prefix = file.subarray(0, file.length - (cut % (file.length + 1)));
          recognizeMedia(prefix, file.length);
        },
      ),
      { numRuns: 2000 },
    );
  });
});

// Shifts each item's base offset in an AVIF's iloc by `delta`, after mdat moved (iloc version 0, as sharp writes it:
// 4-byte offsets, lengths and base offsets).
function shiftIloc(out: Uint8Array, delta: number): void {
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const iloc = out.findIndex((_, i) => String.fromCharCode(...out.subarray(i + 4, i + 8)) === "iloc");
  expect([out[iloc + 8], out[iloc + 12], out[iloc + 13]]).toEqual([0, 0x44, 0x40]);
  const count = view.getUint16(iloc + 14);
  let entry = iloc + 16;
  for (let k = 0; k < count; k++) {
    view.setUint32(entry + 4, view.getUint32(entry + 4) + delta);
    entry += 10 + view.getUint16(entry + 8) * 8;
  }
}

// The AVIF with `child` inserted as the last child of the innermost of `parents` (box types found in the file,
// outermost first), each of them grown to hold it, and iloc's base offsets shifted past the insertion (mdat comes
// after it).
function avifWith(avif: Uint8Array, parents: string[], child: Uint8Array): Uint8Array {
  const find = (type: string) => avif.findIndex((_, i) => String.fromCharCode(...avif.subarray(i + 4, i + 8)) === type);
  const starts = parents.map(find);
  const view = new DataView(avif.buffer, avif.byteOffset, avif.byteLength);
  const innermost = starts.at(-1) ?? 0;
  const at = innermost + view.getUint32(innermost);
  const out = concat(avif.subarray(0, at), child, avif.subarray(at));
  const outView = new DataView(out.buffer);
  for (const start of starts) {
    outView.setUint32(start, view.getUint32(start) + child.length);
  }
  shiftIloc(out, child.length);
  return out;
}

describe("verifyRemoteImage: AVIF allowlists", () => {
  it("refuses an image sequence: the avis brand, major or compatible, or a moov box", async () => {
    const avif = await madeFixture("avif");
    const major = avif.slice();
    major.set(text("avis"), 8);
    expect(refusal(major)).toBe("type");
    // The compatible brands at offset 16: mif1 becomes avis.
    const compatible = avif.slice();
    const at = compatible.findIndex(
      (_, i) => i >= 16 && String.fromCharCode(...compatible.subarray(i, i + 4)) === "mif1",
    );
    compatible.set(text("avis"), at);
    expect(refusal(compatible)).toBe("type");
    const moov = concat(avif, box("moov", box("trak", box("meta", new Uint8Array(4), box("Exif", new Uint8Array(8))))));
    expect(refusal(moov)).toBe("type");
    expect(refusal(avif.slice())).toBe("accepted");
  });

  it("keeps an alpha plane, and refuses any property, meta box or colour outside the allowlist", async () => {
    const alpha = await madeFixture("avif-alpha");
    expect(refusal(alpha.slice())).toBe("accepted");
    expect(await imageFacts(alpha)).toMatchObject({ format: "heif", width: 64, height: 48 });
    const avif = await madeFixture("avif");
    const udes = avifWith(avif, ["meta", "iprp", "ipco"], fullBox("udes", 0, text("en\0name\0description\0tags\0")));
    // The grown file is still a valid AVIF to a decoder.
    expect(await imageFacts(udes)).toMatchObject({ width: 64, height: 48 });
    expect(remoteImageMetadata(udes, "image/avif")).toBe("segment");
    expect(refusal(udes)).toBe("metadata");
    const unknownColour = avifWith(avif, ["meta", "iprp", "ipco"], box("colr", text("XYZW")));
    expect(refusal(unknownColour)).toBe("metadata");
    expect(refusal(avifWith(avif, ["meta", "iprp", "ipco"], box("colr", text("nclx"), new Uint8Array(7))))).toBe(
      "accepted",
    );
    const depth = avifWith(avif, ["meta", "iprp", "ipco"], fullBox("auxC", 0, text("urn:example:depth\0")));
    expect(refusal(depth)).toBe("metadata");
    const xml = avifWith(avif, ["meta"], fullBox("xml ", 0, text("<x:xmpmeta/>")));
    expect(refusal(xml)).toBe("metadata");
  });

  it("reads a long ftyp one brand at a time", { timeout: 60_000 }, async () => {
    const avif = await madeFixture("avif");
    const ftypEnd = new DataView(avif.buffer).getUint32(0);
    // 400,000 compatible brands (1.6 MB), avis last.
    const brands = new Uint8Array(400_000 * 4);
    const brand = text("mif1");
    for (let i = 0; i < brands.length; i += 4) {
      brands.set(brand, i);
    }
    const grown = (brands: Uint8Array, last: string) => {
      const ftyp = concat(avif.subarray(4, ftypEnd), brands, text(last));
      const out = concat(new Uint8Array(4), ftyp, avif.subarray(ftypEnd));
      new DataView(out.buffer).setUint32(0, ftypEnd + brands.length + 4);
      shiftIloc(out, brands.length + 4);
      return out;
    };
    // The construction keeps a decodable AVIF: a decoder reads it with 10 more brands. (libvips identifies a HEIF
    // file from its first bytes and does not take one whose ftyp runs to the long case's 1.6 MB.)
    expect(await imageFacts(grown(brands.subarray(0, 40), "miaf"))).toMatchObject({ width: 64, height: 48 });
    expect(refusal(grown(brands.subarray(0, 40), "miaf"))).toBe("accepted");
    const sequence = grown(brands, "avis");
    const still = grown(brands, "miaf");
    // Reading brands keeps no list that grows with the ftyp: a scoped counter (restored in finally, no call history
    // kept) records the longest array any push extends while the brands are read.
    const longestPush = (work: () => void) => {
      const push = Array.prototype.push;
      let longest = 0;
      Array.prototype.push = function (this: unknown[], ...items: unknown[]) {
        longest = Math.max(longest, this.length);
        return push.apply(this, items);
      };
      try {
        work();
      } finally {
        Array.prototype.push = push;
      }
      return longest;
    };
    const start = performance.now();
    expect(
      longestPush(() => {
        expect(refusal(sequence)).toBe("type");
        expect(refusal(still)).toBe("accepted");
      }),
    ).toBeLessThan(1000);
    // An MP4's long ftyp within the prefix: heic last.
    const heif = mp4({ brands: ["isom", ...new Array<string>(200_000).fill("iso2"), "heic"] });
    const video = mp4({ brands: ["isom", ...new Array<string>(200_000).fill("iso2")] });
    expect(
      longestPush(() => {
        expect(recognize(heif)).toEqual({ ok: false, refusal: "heif" });
        expect(recognize(video)).toMatchObject({ ok: true });
      }),
    ).toBeLessThan(1000);
    expect(performance.now() - start).toBeLessThan(5000);
  });
});

describe("verifyRemoteImage: WebP frames", () => {
  it("refuses metadata or another chunk inside a later frame, and frame chunks out of order", async () => {
    const first = await encodeWebp(16, 12);
    const second = await encodeWebp(16, 12, { fill: "flat" });
    const size = { width: 16, height: 12 };
    expect(refusal(animatedWebp([first, second], size))).toBe("accepted");
    for (const [name, extra] of [
      ["EXIF", webpChunk("EXIF", exifOrientation(1).subarray(6))],
      ["XMP", webpChunk("XMP ", text("<x:xmpmeta/>"))],
      ["unknown", webpChunk("ABCD", new Uint8Array(3))],
    ] as const) {
      const file = animatedWebp([first, second], size, {
        frameChunks: (chunks, i) => (i === 1 ? [...chunks, extra] : chunks),
      });
      expect(remoteImageMetadata(file, "image/webp"), name).toBe("segment");
      expect(refusal(file), name).toBe("metadata");
    }
    // The first frame has ALPH then VP8; reversed in the second frame.
    const reversed = animatedWebp([first, first], size, {
      frameChunks: (chunks, i) => (i === 1 ? [...chunks].reverse() : chunks),
    });
    expect(refusal(reversed)).toBe("malformed");
  });
});

describe("recognizeMedia: hostile WebM", () => {
  it("refuses a DocType of several hundred KiB without building a string of it", () => {
    const long = new TextEncoder().encode("webm".padEnd(400 * 1024, "x"));
    expect(() => recognize(webm({ docTypeBytes: long }))).not.toThrow();
    expect(recognize(webm({ docTypeBytes: long }))).toEqual({ ok: false, refusal: "type" });
    // webm padded with NULs is webm.
    const padded = concat(text("webm"), new Uint8Array(300 * 1024));
    expect(recognize(webm({ docTypeBytes: padded }))).toMatchObject({ ok: true, type: "video/webm" });
  });
});
