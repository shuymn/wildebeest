import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { bundle, fingerprint } from "../scripts/build-assets.mjs";
import { L1_SCRIPT } from "../src/web/asset-versions.js";

// The L1 script bundle (docs/web-pages.md): the committed file is what the build makes from
// src/client/, named by its hash, and within its budget. The drift check across releases is in
// test-node/stylesheet.test.ts ("is what scripts/build-assets.mjs writes"); the rewrite itself is checked by
// test-node/local-time.test.ts and the browser job.

const PACKAGE = new URL("../", import.meta.url);

describe("the L1 bundle", () => {
  const rebuilt = bundle(fileURLToPath(PACKAGE));

  it("is committed as the bytes a rebuild gives, under the name their hash gives", () => {
    expect(L1_SCRIPT).toBe(`/assets/kopje.${fingerprint(rebuilt)}.js`);
    expect(readFileSync(new URL(`public${L1_SCRIPT}`, PACKAGE)).equals(rebuilt)).toBe(true);
  });

  it("is one minified IIFE with no source map and no comments", () => {
    const text = rebuilt.toString("utf8");
    expect(text).toMatch(/^"use strict";\(\(\)=>\{.*\}\)\(\);\n$/s);
    expect(text).not.toContain("sourceMappingURL");
    expect(text).not.toMatch(/\/\*|\/\/[ #@]/);
  });

  // The copy control's texts come from the page: the bundle holds none of the catalogue's.
  it("holds no UI text of the catalogue", () => {
    const text = rebuilt.toString("utf8");
    // The catalogue's copy texts (src/web/strings.ts, copy).
    for (const shown of ["Copy", "Copied", "Could not copy"]) {
      expect(text, shown).not.toContain(shown);
    }
  });

  // Bytes of the file as served, raw and gzip-compressed (≤ 3 KiB raw, ≤ 1.5 KiB gzip).
  it("stays within 3 KiB raw and 1.5 KiB gzip", () => {
    expect(rebuilt.byteLength).toBeLessThanOrEqual(3 * 1024);
    expect(gzipSync(rebuilt).byteLength).toBeLessThanOrEqual(1.5 * 1024);
  });
});
