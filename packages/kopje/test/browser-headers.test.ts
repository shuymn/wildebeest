import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

import {
  CONSENT_PAGE_HEADERS,
  EMBED_PAGE_HEADERS,
  ERROR_PAGE_HEADERS,
  HANDOFF_PAGE_HEADERS,
  L1_PAGE_HEADERS,
  PRIVATE_PAGE_HEADERS,
  PUBLIC_PAGE_HEADERS,
  remoteMediaHeaders,
  UNAVAILABLE_PAGE_HEADERS,
} from "../browser/headers";
import { POLYGLOT } from "../browser/polyglot";
import type { StoreStub } from "../src/platform/store-client";
import { StoreUnavailableError } from "../src/platform/store-errors";
import { consentPage, decide, registerApp, setSetting } from "./api-helpers";
import { harness } from "./app-helpers";
import { migratedStore } from "./helpers";
import { pathOf } from "./media-helpers";
import { community, post } from "./status-helpers";

// The browser job serves its fixtures with pinned header literals; these are exactly the headers the
// Worker sends for each page type it renders, so the browser runs under the production CSP and cannot drift from it.

describe("the browser job headers", () => {
  it("equal every header the Worker sends with each fixture page type", async () => {
    const h = await community(["alice"]);
    const status = await post(h, h.users.alice, { status: "hello", spoiler_text: "careful" });
    await setSetting(h.store, "privacy_policy", "<p>Policy</p>");
    const pages: [string, Readonly<Record<string, string>>, number][] = [
      ["/@alice", L1_PAGE_HEADERS, 200],
      [pathOf(String(status.url)), L1_PAGE_HEADERS, 200],
      ["/tags/walks", L1_PAGE_HEADERS, 200],
      ["/about", PUBLIC_PAGE_HEADERS, 200],
      ["/privacy-policy", PUBLIC_PAGE_HEADERS, 200],
      ["/@nobody", PUBLIC_PAGE_HEADERS, 404],
      [`${pathOf(String(status.url))}/embed`, EMBED_PAGE_HEADERS, 200],
      ["/authorize_interaction", PRIVATE_PAGE_HEADERS, 200],
      ["/@alice/interact", HANDOFF_PAGE_HEADERS, 200],
      ["/@alice/interact?server=x", HANDOFF_PAGE_HEADERS, 400],
      [`${pathOf(String(status.url))}/interact?server=social.example`, HANDOFF_PAGE_HEADERS, 200],
    ];
    for (const [path, pinned, code] of pages) {
      const response = await h.request(path);
      expect(response.status, path).toBe(code);
      expect(Object.fromEntries(response.headers), path).toEqual(pinned);
    }
  });

  it("equal every header the Worker sends with the OAuth pages and a browser’s error pages", async () => {
    const h = await community(["alice"]);
    const oob = await registerApp(h, { redirectUri: "urn:ietf:wg:oauth:2.0:oob" });
    const accept = { accept: "text/html" };
    const failing = (error: Error) =>
      harness(new Proxy({} as StoreStub, { get: () => () => Promise.reject(error) })).request("/about", {
        headers: accept,
      });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const answers: [string, Response, Readonly<Record<string, string>>, number][] = [
      ["consent", await consentPage(h, h.app), CONSENT_PAGE_HEADERS, 200],
      ["code", await decide(h, oob, "approve"), PRIVATE_PAGE_HEADERS, 200],
      ["404", await h.request("/nope", { headers: accept }), PUBLIC_PAGE_HEADERS, 404],
      ["500", await failing(new Error("boom")), ERROR_PAGE_HEADERS, 500],
      ["503", await failing(new StoreUnavailableError("transient")), UNAVAILABLE_PAGE_HEADERS, 503],
    ];
    logged.mockRestore();
    for (const [name, response, pinned, code] of answers) {
      expect(response.status, name).toBe(code);
      expect(Object.fromEntries(response.headers), name).toEqual(pinned);
      await response.arrayBuffer();
    }
  });

  it("equal the headers of a cached remote file, whole and ranged, and serve the polyglot as stored", async () => {
    const token = "G".repeat(43);
    await env.MEDIA.put(`remote/${token}/full`, POLYGLOT, { httpMetadata: { contentType: "image/gif" } });
    const h = harness(await migratedStore());
    const whole = await h.request(`/media/r/${token}/full.gif`);
    expect(whole.status).toBe(200);
    expect(Object.fromEntries(whole.headers)).toEqual({
      ...remoteMediaHeaders("image/gif"),
      etag: expect.any(String) as unknown,
      "content-length": String(POLYGLOT.length),
    });
    expect(new Uint8Array(await whole.arrayBuffer())).toEqual(POLYGLOT);
    const ranged = await h.request(`/media/r/${token}/full.gif`, { headers: { range: "bytes=0-" } });
    expect(ranged.status).toBe(206);
    expect(Object.fromEntries(ranged.headers)).toEqual({
      ...remoteMediaHeaders("image/gif"),
      etag: expect.any(String) as unknown,
      "content-length": String(POLYGLOT.length),
      "content-range": `bytes 0-${POLYGLOT.length - 1}/${POLYGLOT.length}`,
    });
    await ranged.arrayBuffer();
  });
});
