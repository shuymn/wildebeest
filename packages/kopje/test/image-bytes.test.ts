import { describe, expect, it } from "vitest";

import { isAnimated, retainedMetadata, sniffImageType } from "../src/platform/image-bytes";
import { keyOfPath, mediaKeys, originalKey } from "../src/platform/media-files";
import {
  ANIMATED_WEBP,
  APNG,
  GIF,
  JPEG_COPYRIGHT_ONLY,
  JPEG_ICC,
  JPEG_SERIAL,
  JPEG_WITH_GPS,
  JPEG_XMP,
  PNG_ICC,
  PNG_PLAIN,
  PNG_WITH_GPS,
  WEBP_ICC,
  WEBP_PLAIN,
  WEBP_SERIAL,
  WEBP_WITH_GPS,
  WEBP_XMP,
  WIDE_PNG,
} from "./fixtures/images";
import { bytes, exifWithTag, jpegWithSegment, pngWithChunk } from "./media-helpers";
import { concat, jpegScans, jpegSegment, restartJpeg } from "./remote-media-fixtures";

const text = (value: string) => new TextEncoder().encode(value);

describe("sniffImageType (MEDIA-4)", () => {
  it("recognizes the accepted image types by signature", () => {
    expect(sniffImageType(bytes(JPEG_WITH_GPS))).toBe("image/jpeg");
    expect(sniffImageType(bytes(WIDE_PNG))).toBe("image/png");
    expect(sniffImageType(bytes(GIF))).toBe("image/gif");
    expect(sniffImageType(bytes(WEBP_WITH_GPS))).toBe("image/webp");
    expect(sniffImageType(new Uint8Array([0, 0, 0, 0x1c, ...text("ftypavif")]))).toBe("image/avif");
  });

  it("recognizes nothing else: HTML, SVG, video, audio, HEIC", () => {
    for (const input of [
      text("<!doctype html><script>alert(1)</script>"),
      text('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      new Uint8Array([0, 0, 0, 0x18, ...text("ftypisom"), 0, 0, 0, 0]),
      new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]),
      text("ID3\u0004\u0000\u0000\u0000\u0000"),
      new Uint8Array([0, 0, 0, 0x18, ...text("ftypheic"), 0, 0, 0, 0]),
      new Uint8Array([0xff, 0xd8]),
    ]) {
      expect(sniffImageType(input)).toBeNull();
    }
  });
});

describe("retainedMetadata (MEDIA-3)", () => {
  const jpeg = bytes(JPEG_ICC);
  const png = bytes(PNG_PLAIN);

  it("refuses every EXIF block, not only GPS: location, serial numbers, MakerNote", () => {
    expect(retainedMetadata(bytes(JPEG_WITH_GPS), "image/jpeg")).toBe("exif");
    expect(retainedMetadata(bytes(JPEG_SERIAL), "image/jpeg")).toBe("exif");
    expect(retainedMetadata(bytes(JPEG_COPYRIGHT_ONLY), "image/jpeg")).toBe("exif");
    expect(retainedMetadata(jpegWithSegment(jpeg, 0xe1, exifWithTag(0x927c, "maker")), "image/jpeg")).toBe("exif");
    expect(retainedMetadata(bytes(PNG_WITH_GPS), "image/png")).toBe("exif");
    expect(retainedMetadata(bytes(WEBP_WITH_GPS), "image/webp")).toBe("exif");
    expect(retainedMetadata(bytes(WEBP_SERIAL), "image/webp")).toBe("exif");
  });

  it("refuses XMP, IPTC, comments, text chunks and unknown JPEG application segments", () => {
    expect(retainedMetadata(bytes(JPEG_XMP), "image/jpeg")).toBe("xmp");
    expect(retainedMetadata(bytes(WEBP_XMP), "image/webp")).toBe("xmp");
    expect(retainedMetadata(jpegWithSegment(jpeg, 0xed, "Photoshop 3.0\0"), "image/jpeg")).toBe("iptc");
    expect(retainedMetadata(jpegWithSegment(jpeg, 0xfe, "shot by alice"), "image/jpeg")).toBe("comment");
    expect(retainedMetadata(jpegWithSegment(jpeg, 0xe3, "META"), "image/jpeg")).toBe("segment");
    expect(retainedMetadata(jpegWithSegment(jpeg, 0xe2, "MPF\0"), "image/jpeg")).toBe("segment");
    expect(retainedMetadata(pngWithChunk(png, "tEXt", "Author\0alice"), "image/png")).toBe("text");
    expect(retainedMetadata(pngWithChunk(png, "iTXt", "XML:com.adobe.xmp\0\0\0\0\0<x/>"), "image/png")).toBe("text");
    expect(retainedMetadata(pngWithChunk(png, "zTXt", "Comment\0\0x"), "image/png")).toBe("text");
  });

  it("accepts plain images and colour profiles (ICC)", () => {
    expect(retainedMetadata(bytes(JPEG_ICC), "image/jpeg")).toBeNull();
    expect(retainedMetadata(bytes(PNG_ICC), "image/png")).toBeNull();
    expect(retainedMetadata(bytes(WEBP_ICC), "image/webp")).toBeNull();
    expect(retainedMetadata(bytes(WEBP_PLAIN), "image/webp")).toBeNull();
    expect(retainedMetadata(bytes(WIDE_PNG), "image/png")).toBeNull();
  });

  it("walks a JPEG to EOI: metadata between and after scans counts, as does anything after EOI", () => {
    const { sos, eoi } = jpegScans(jpeg);
    const at = (offset: number, segment: Uint8Array) =>
      concat(jpeg.subarray(0, offset), segment, jpeg.subarray(offset));
    // Before the first scan, as before; then after it, and right before EOI.
    expect(retainedMetadata(at(sos[0] ?? 0, jpegSegment(0xfe, "x")), "image/jpeg")).toBe("comment");
    expect(retainedMetadata(at(eoi, jpegSegment(0xfe, "x")), "image/jpeg")).toBe("comment");
    expect(retainedMetadata(at(eoi, jpegSegment(0xe1, exifWithTag(0x927c, "maker"))), "image/jpeg")).toBe("exif");
    expect(retainedMetadata(at(eoi, jpegSegment(0xed, "Photoshop 3.0\0")), "image/jpeg")).toBe("iptc");
    expect(retainedMetadata(concat(jpeg, new Uint8Array([0xff, 0xd8, 0xff, 0xd9])), "image/jpeg")).toBe("unreadable");
    expect(retainedMetadata(jpeg.subarray(0, eoi), "image/jpeg")).toBe("unreadable");
    // Fill bytes before a restart marker keep it inside the scan.
    expect(retainedMetadata(restartJpeg([255, 0, 128, 255, 255], 3), "image/jpeg")).toBeNull();
    // Restart markers and stuffing inside a scan are its data, not markers.
    const restarts = restartJpeg([255, 0, 128, 255, 255]);
    expect(retainedMetadata(restarts, "image/jpeg")).toBeNull();
    expect(
      retainedMetadata(
        concat(restarts.subarray(0, restarts.length - 2), jpegSegment(0xfe, "x"), restarts.subarray(-2)),
        "image/jpeg",
      ),
    ).toBe("comment");
  });

  it("fails closed on truncated or unknown files", () => {
    expect(retainedMetadata(bytes(JPEG_WITH_GPS).subarray(0, 40), "image/jpeg")).toBe("unreadable");
    expect(retainedMetadata(bytes(PNG_WITH_GPS).subarray(0, 30), "image/png")).toBe("unreadable");
    expect(retainedMetadata(bytes(GIF), "image/gif")).toBe("unreadable");
    expect(retainedMetadata(text("<html>"), "image/jpeg")).toBe("unreadable");
  });

  it("walks a worst-case file at the upload bound within a generous time (RES-2)", () => {
    // 16 MB of fill bytes after the JPEG signature: one step per byte.
    const worst = new Uint8Array(16 * 1024 * 1024).fill(0xff);
    worst[1] = 0xd8;
    const start = performance.now();
    expect(retainedMetadata(worst, "image/jpeg")).toBe("unreadable");
    expect(performance.now() - start).toBeLessThan(2000);
  });
});

describe("isAnimated (MEDIA-3)", () => {
  // A WebP of `body` (its chunks after 'WEBP') with an exact RIFF extent.
  const riff = (body: Uint8Array) => {
    const out = new Uint8Array(12 + body.length);
    out.set(text("RIFF"));
    new DataView(out.buffer).setUint32(4, 4 + body.length, true);
    out.set(text("WEBP"), 8);
    out.set(body, 12);
    return out;
  };
  const chunk = (type: string, payload: Uint8Array) => {
    const out = new Uint8Array(8 + payload.length + (payload.length % 2));
    out.set(text(type));
    new DataView(out.buffer).setUint32(4, payload.length, true);
    out.set(payload, 8);
    return out;
  };
  const webpPlain = bytes(WEBP_PLAIN);
  const webpIcc = bytes(WEBP_ICC);
  const png = bytes(PNG_PLAIN);
  // PNG_PLAIN with one more chunk right before IEND (after IDAT); CRC left zero.
  const beforeIend = (type: string, payload: Uint8Array) => {
    const header = new Uint8Array(8);
    new DataView(header.buffer).setUint32(0, payload.length);
    header.set(text(type), 4);
    const iend = png.length - 12;
    return new Uint8Array([...png.subarray(0, iend), ...header, ...payload, 0, 0, 0, 0, ...png.subarray(iend)]);
  };

  it("finds the frames of an animated WebP and an APNG, wherever their marks are", () => {
    expect(isAnimated(bytes(ANIMATED_WEBP), "image/webp")).toBe(true);
    expect(isAnimated(bytes(APNG), "image/png")).toBe(true);
    // The VP8X animation flag alone (WEBP_ICC's VP8X with 0x02 set).
    const flagged = webpIcc.slice();
    flagged[20] = (flagged[20] ?? 0) | 0x02;
    expect(isAnimated(flagged, "image/webp")).toBe(true);
    // ANIM without the flag.
    expect(
      isAnimated(riff(new Uint8Array([...webpPlain.subarray(12), ...chunk("ANIM", new Uint8Array(6))])), "image/webp"),
    ).toBe(true);
    expect(isAnimated(beforeIend("acTL", new Uint8Array(8)), "image/png")).toBe(true);
  });

  it("finds none in still images, colour profiles included", () => {
    expect(isAnimated(webpPlain, "image/webp")).toBe(false);
    expect(isAnimated(webpIcc, "image/webp")).toBe(false);
    expect(isAnimated(png, "image/png")).toBe(false);
    expect(isAnimated(bytes(PNG_ICC), "image/png")).toBe(false);
  });

  it("counts a file it cannot walk, a short VP8X or an unknown type as animated (fail closed)", () => {
    const huge = webpPlain.slice();
    new DataView(huge.buffer).setUint32(16, 0xffffffff, true);
    const hugePng = png.slice();
    new DataView(hugePng.buffer).setUint32(8, 0xffffffff);
    for (const [name, file, type] of [
      ["a truncated WebP", webpPlain.subarray(0, 40), "image/webp"],
      ["a truncated PNG", png.subarray(0, 30), "image/png"],
      ["a WebP chunk of 0xFFFFFFFF bytes", huge, "image/webp"],
      ["a PNG chunk of 0xFFFFFFFF bytes", hugePng, "image/png"],
      ["a RIFF extent past the file", webpPlain.subarray(0, webpPlain.length - 2), "image/webp"],
      ["bytes past the RIFF extent", new Uint8Array([...webpPlain, 0, 0]), "image/webp"],
      [
        "a VP8X of 9 bytes",
        riff(new Uint8Array([...chunk("VP8X", new Uint8Array(9)), ...webpPlain.subarray(12)])),
        "image/webp",
      ],
      ["a PNG without IEND", png.subarray(0, png.length - 12), "image/png"],
      ["a GIF", bytes(GIF), "image/gif"],
      ["a JPEG", bytes(JPEG_ICC), "image/jpeg"],
    ] as const) {
      expect(isAnimated(file, type), name).toBe(true);
    }
  });
});

describe("media keys (MEDIA-2)", () => {
  const token = "A".repeat(43);

  it("builds keys from server ids and tokens only", () => {
    expect(mediaKeys("100000000000000001", token)).toEqual([
      "originals/100000000000000001",
      `files/${token}/full`,
      `files/${token}/small`,
    ]);
    expect(() => originalKey("../x")).toThrow();
  });

  it("maps only served files of a well-formed token to a key", () => {
    expect(keyOfPath(token, "full.jpg")).toEqual({ key: `files/${token}/full`, extension: "jpg" });
    expect(keyOfPath(token, "small.webp")).toEqual({ key: `files/${token}/small`, extension: "webp" });
    for (const [t, file] of [
      [token, "original.jpg"],
      [token, "full.html"],
      [token, "full.svg"],
      [token, "full"],
      [token, "../full.jpg"],
      ["..", "full.jpg"],
      [`${token}/..`, "full.jpg"],
      ["originals%2F100000000000000001", "full.jpg"],
      ["short", "full.jpg"],
    ] as const) {
      expect(keyOfPath(t, file), `${t} ${file}`).toBeNull();
    }
  });
});
