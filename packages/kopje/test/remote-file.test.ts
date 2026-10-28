import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import {
  createRemoteFileFetcher,
  fetchRemoteFile,
  type RemoteFile,
  type RemoteFileDeps,
  type RemoteFileFailure,
  type RemoteFilePolicy,
  remoteFileRule,
  remoteFileUrlRefusal,
} from "../src/federation/remote-file";
import { WEB_PAGE_URL_LIMIT } from "../src/federation/web-page";
import { PACKAGE_VERSION } from "../src/platform/package-version";
import { remoteImageMetadata } from "../src/platform/remote-media-bytes";
import { ANIMATED_GIF, AVIF, GIF, JPEG_ICC, JPEG_WITH_GPS, PNG_PLAIN, WEBP_PLAIN } from "./fixtures/images";
import { bytes } from "./media-helpers";
import { concat, mp4, oggPage, VORBIS_PACKET, webm } from "./remote-media-fixtures";
import { trackedStream } from "./stream-helpers";

const DOMAIN = "kopje.example";
const FILE = "https://files.example/a";
const MiB = 1024 * 1024;

type Route = (request: Request) => Response | Promise<Response>;

// Deps over a route table that log every step in order: each admission (before the DNS check, then after it), each
// DNS check and each request.
function fakeDeps(routes: Record<string, Route>, extra: Partial<RemoteFileDeps> = {}) {
  const log: string[] = [];
  const requests: Request[] = [];
  const deps: RemoteFileDeps = {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      requests.push(request);
      log.push(`fetch ${request.url}`);
      const route = routes[request.url];
      return Promise.resolve(route === undefined ? new Response("missing", { status: 404 }) : route(request));
    },
    checkHost: (url) => {
      log.push(`dns ${url.hostname}`);
      return Promise.resolve();
    },
    admit: (host) => {
      log.push(`admit ${host}`);
      return Promise.resolve(false);
    },
    domain: DOMAIN,
    now: () => Date.now(),
    ...extra,
  };
  return { deps, log, requests };
}

const policy = (
  kind: RemoteFilePolicy["kind"],
  category: RemoteFilePolicy["category"] = "image",
): RemoteFilePolicy => ({
  kind,
  category,
  deadline: Date.now() + 30_000,
});

const serve =
  (body: BodyInit | null, headers: Record<string, string> = {}, status = 200) =>
  () =>
    new Response(body, { status, headers });
const redirect = (location: string) => () => new Response(null, { status: 302, headers: { location } });
const sized = (file: Uint8Array) => serve(file, { "content-length": String(file.length) });

function ok(result: RemoteFile | RemoteFileFailure): RemoteFile {
  if (!result.ok) {
    throw new Error(`failed: ${JSON.stringify(result)}`);
  }
  return result;
}

function failed(result: RemoteFile | RemoteFileFailure): RemoteFileFailure {
  if (result.ok) {
    throw new Error("expected a failure");
  }
  return result;
}

describe("fetchRemoteFile: URLs and hops", () => {
  it.each([
    ["http://files.example/a", "scheme"],
    ["https://files.example:8443/a", "port"],
    ["https://192.0.2.1/a", "ip-literal"],
    ["https://[2001:db8::1]/a", "ip-literal"],
    ["https://localhost/a", "local-host"],
    ["https://files/a", "local-host"],
    ["https://files.example./a", "trailing-dot"],
    [`https://files.example/${"a".repeat(WEB_PAGE_URL_LIMIT)}`, "url-too-long"],
    [`https://${DOMAIN}/media/a.png`, "own-host"],
    ["https://KOPJE.example/media/a.png", "own-host"],
  ])("NET-3: refuses a URL the sink or the own-host rule refuses before any network step (%s)", async (url, reason) => {
    expect(remoteFileUrlRefusal(url, DOMAIN)).toBe(reason);
    const { deps, log } = fakeDeps({});
    expect(failed(await fetchRemoteFile(url, deps, policy("avatar")))).toMatchObject({
      kind: "refused",
      reason,
      transient: false,
      policyFailed: false,
    });
    expect(log).toEqual([]);
  });

  it("refuses a kind and category that do not go together before any network step", async () => {
    const { deps, log } = fakeDeps({});
    expect(remoteFileRule("avatar", "video")).toBeNull();
    expect(failed(await fetchRemoteFile(FILE, deps, policy("avatar", "video")))).toMatchObject({ kind: "kind" });
    expect(failed(await fetchRemoteFile(FILE, deps, policy("emoji", "audio")))).toMatchObject({ kind: "kind" });
    expect(log).toEqual([]);
  });

  it("NET-3: admits every hop before and after its DNS check, follows at most 3 redirects, never lets fetch follow", async () => {
    const routes: Record<string, Route> = {};
    for (let i = 0; i < 3; i++) {
      routes[`https://h${i}.example/`] = redirect(`https://h${i + 1}.example/`);
    }
    routes["https://h3.example/"] = serve(bytes(GIF));
    const { deps, log, requests } = fakeDeps(routes);
    const got = ok(await fetchRemoteFile("https://h0.example/", deps, policy("emoji")));
    expect(got.hosts).toEqual(["h0.example", "h1.example", "h2.example", "h3.example"]);
    expect(log).toEqual(
      [0, 1, 2, 3].flatMap((i) => [
        `admit h${i}.example`,
        `dns h${i}.example`,
        `admit h${i}.example`,
        `fetch https://h${i}.example/`,
      ]),
    );
    for (const request of requests) {
      expect(request.redirect).toBe("manual");
      expect(request.method).toBe("GET");
      expect([...request.headers]).toEqual([["user-agent", `Kopje/${PACKAGE_VERSION} (+https://${DOMAIN}/)`]]);
    }
    routes["https://h3.example/"] = redirect("https://h4.example/");
    const tooMany = fakeDeps(routes);
    expect(failed(await fetchRemoteFile("https://h0.example/", tooMany.deps, policy("emoji")))).toMatchObject({
      kind: "redirects",
      transient: false,
    });
    expect(tooMany.requests).toHaveLength(4);
  });

  it("NET-3: refuses the own host on a redirect as a blocked host, without admitting or requesting it", async () => {
    const { deps, log } = fakeDeps({ [FILE]: redirect(`https://${DOMAIN}/media/x.png`) });
    expect(failed(await fetchRemoteFile(FILE, deps, policy("avatar")))).toMatchObject({
      kind: "blocked",
      host: DOMAIN,
      transient: false,
      policyFailed: false,
    });
    expect(log).toEqual(["admit files.example", "dns files.example", "admit files.example", `fetch ${FILE}`]);
  });

  it("NET-3: a host the policy refuses, before or after its DNS check, is blocked and never requested", async () => {
    for (const at of [1, 2]) {
      let calls = 0;
      const { deps, requests } = fakeDeps(
        { [FILE]: redirect("https://cdn.example/a"), "https://cdn.example/a": serve(bytes(GIF)) },
        { admit: (host) => Promise.resolve(host === "cdn.example" && ++calls === at) },
      );
      expect(failed(await fetchRemoteFile(FILE, deps, policy("avatar"))), String(at)).toMatchObject({
        kind: at === 1 ? "blocked" : "refused",
        host: "cdn.example",
      });
      expect(requests.map((r) => r.url)).toEqual([FILE]);
    }
  });

  it("reports a policy RPC failure, so the attempt does not count, and redacts it", async () => {
    const { deps, requests } = fakeDeps(
      { [FILE]: serve(bytes(GIF)) },
      { admit: () => Promise.reject(new Error("Store unavailable at https://secret.example/")) },
    );
    const failure = failed(await fetchRemoteFile(FILE, deps, policy("avatar")));
    expect(failure).toEqual({ ok: false, kind: "policy", host: "files.example", transient: true, policyFailed: true });
    expect(requests).toHaveLength(0);
  });

  it("classifies failures as permanent or transient, each with the host only", async () => {
    for (const [status, transient] of [
      [404, false],
      [410, false],
      [403, false],
      [408, true],
      [429, true],
      [500, true],
      [503, true],
    ] as const) {
      const { deps } = fakeDeps({ [`${FILE}?token=secret`]: serve("x", {}, status) });
      expect(failed(await fetchRemoteFile(`${FILE}?token=secret`, deps, policy("avatar")))).toEqual({
        ok: false,
        kind: "status",
        status,
        host: "files.example",
        transient,
        policyFailed: false,
      });
    }
    const network = fakeDeps({ [FILE]: () => Promise.reject(new Error("reset by https://secret.example/")) });
    expect(failed(await fetchRemoteFile(FILE, network.deps, policy("avatar")))).toEqual({
      ok: false,
      kind: "network",
      host: "files.example",
      transient: true,
      policyFailed: false,
    });
    const refused = fakeDeps({}, { checkHost: () => Promise.reject(new Error("private")) });
    expect(failed(await fetchRemoteFile(FILE, refused.deps, policy("avatar")))).toMatchObject({
      kind: "refused",
      reason: "host-check",
      transient: true,
    });
  });
});

describe("fetchRemoteFile: images read whole", () => {
  it("verifies a clean GIF, an AVIF and a JPEG, classifying the JPEG as one frame", async () => {
    for (const [name, file, kind, type, animated] of [
      ["GIF", bytes(GIF), "emoji", "image/gif", false],
      ["AVIF", bytes(AVIF), "thumbnail", "image/avif", false],
      ["JPEG", bytes(JPEG_ICC), "avatar", "image/jpeg", false],
      ["PNG", bytes(PNG_PLAIN), "header", "image/png", false],
      ["WebP", bytes(WEBP_PLAIN), "attachment", "image/webp", false],
    ] as const) {
      const { deps } = fakeDeps({ [FILE]: serve(file, { "content-type": "text/html" }) });
      const got = ok(await fetchRemoteFile(FILE, deps, policy(kind)));
      expect(got, name).toMatchObject({ mode: "buffered", type, category: "image", animated, still: null });
      expect(got.mode === "buffered" && [...got.bytes], name).toEqual([...file]);
    }
  });

  it("strips metadata in place and makes a still of an animated image within the still cap", async () => {
    const { deps } = fakeDeps({ [FILE]: serve(bytes(JPEG_WITH_GPS)) });
    const jpeg = ok(await fetchRemoteFile(FILE, deps, policy("avatar")));
    expect(jpeg.mode === "buffered" && remoteImageMetadata(jpeg.bytes, "image/jpeg")).toBeNull();
    expect(jpeg.mode === "buffered" && jpeg.bytes.length).toBeLessThan(bytes(JPEG_WITH_GPS).length);
    const animated = fakeDeps({ [FILE]: serve(bytes(ANIMATED_GIF)) });
    const gif = ok(await fetchRemoteFile(FILE, animated.deps, policy("avatar")));
    expect(gif).toMatchObject({ animated: true, still: { type: "image/gif" } });
    // A thumbnail gets no still.
    const thumbnail = fakeDeps({ [FILE]: serve(bytes(ANIMATED_GIF)) });
    expect(ok(await fetchRemoteFile(FILE, thumbnail.deps, policy("thumbnail")))).toMatchObject({
      animated: true,
      still: null,
    });
  });

  it("makes no still of an animated attachment image when it would pass the 2 MiB still cap", async () => {
    // Two frames, the first of 2 MiB of LZW sub-blocks (255 bytes each).
    const header = bytes(ANIMATED_GIF).subarray(0, 13 + 6);
    const block = new Uint8Array(256).fill(0);
    block[0] = 255;
    const data = concat(...Array.from({ length: Math.ceil((2 * MiB) / 256) }, () => block));
    const frame = (lzw: Uint8Array) =>
      concat(new Uint8Array([0x2c, 0, 0, 0, 0, 10, 0, 8, 0, 0, 2]), lzw, new Uint8Array([0]));
    const file = concat(header, frame(data), frame(new Uint8Array([1, 0])), new Uint8Array([0x3b]));
    expect(file.length).toBeLessThan(16 * MiB);
    const { deps } = fakeDeps({ [FILE]: serve(file) });
    expect(ok(await fetchRemoteFile(FILE, deps, policy("attachment")))).toMatchObject({ animated: true, still: null });
    // The same frames under 2 MiB get one.
    const small = concat(
      header,
      frame(data.subarray(0, 64 * 256)),
      frame(new Uint8Array([1, 0])),
      new Uint8Array([0x3b]),
    );
    const second = fakeDeps({ [FILE]: serve(small) });
    expect(ok(await fetchRemoteFile(FILE, second.deps, policy("attachment")))).toMatchObject({
      still: { type: "image/gif" },
    });
  });

  it("refuses an image its kind does not take, or that does not verify, permanently", async () => {
    for (const [name, file, kind, reason] of [
      ["an emoji JPEG", bytes(JPEG_ICC), "emoji", "type"],
      ["an avatar AVIF", bytes(AVIF), "avatar", "type"],
      ["SVG", new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'), "avatar", "type"],
      ["a truncated PNG", bytes(PNG_PLAIN).subarray(0, 40), "avatar", "malformed"],
      ["a video for an image", mp4(), "attachment", "type"],
    ] as const) {
      const { deps } = fakeDeps({ [FILE]: serve(file, { "content-type": "image/png" }) });
      expect(failed(await fetchRemoteFile(FILE, deps, policy(kind))), name).toEqual({
        ok: false,
        kind: reason,
        host: "files.example",
        transient: false,
        policyFailed: false,
      });
    }
  });

  it("NET-3: cancels a body at its kind cap, decoded bytes counted", async () => {
    const { stream, state } = trackedStream(Array.from({ length: 8 }, () => new Uint8Array(64 * 1024)));
    // Content-Encoding gzip is decoded by workerd before the cap counts; the fake serves the decoded bytes.
    const { deps } = fakeDeps({ [FILE]: serve(stream, { "content-encoding": "gzip", "content-length": "100" }) });
    expect(failed(await fetchRemoteFile(FILE, deps, policy("emoji")))).toMatchObject({
      kind: "too-large",
      transient: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(state.cancelled).toBe(true);
    expect(state.pulls).toBeLessThanOrEqual(5);
    expect(remoteFileRule("emoji", "image")).toMatchObject({ maxBytes: 256 * 1024 - 1, stillMaxBytes: 256 * 1024 - 1 });
    expect(remoteFileRule("avatar", "image")).toMatchObject({ maxBytes: 2 * MiB - 1 });
    expect(remoteFileRule("thumbnail", "image")).toMatchObject({ maxBytes: 2 * MiB - 1, stillMaxBytes: null });
    expect(remoteFileRule("attachment", "image")).toMatchObject({ maxBytes: 16 * MiB - 1, stillMaxBytes: 2 * MiB - 1 });
    expect(remoteFileRule("attachment", "video")).toEqual({ mode: "streamed", maxBytes: 40 * MiB - 1 });
  });

  it("NET-3: ends at the file deadline, a stalled DNS check or body included", async () => {
    const never = () => new Promise<never>(() => {});
    const started = Date.now();
    const dns = fakeDeps({}, { checkHost: never });
    const deadline = { ...policy("avatar"), deadline: Date.now() + 100 };
    expect(failed(await fetchRemoteFile(FILE, dns.deps, deadline))).toMatchObject({ kind: "timeout", transient: true });
    expect(dns.requests).toHaveLength(0);
    const body = trackedStream([new Uint8Array(4)], true);
    const stalled = fakeDeps({ [FILE]: serve(body.stream) });
    expect(
      failed(await fetchRemoteFile(FILE, stalled.deps, { ...deadline, deadline: Date.now() + 100 })),
    ).toMatchObject({
      kind: "timeout",
    });
    expect(Date.now() - started).toBeLessThan(2000);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(body.state.cancelled).toBe(true);
  });
});

describe("fetchRemoteFile: video and audio streamed", () => {
  it("streams a recognized video or audio file of its declared length", async () => {
    for (const [name, file, category, type] of [
      ["MP4", mp4(), "video", "video/mp4"],
      ["WebM audio", webm({ tracks: [2] }), "audio", "audio/webm"],
    ] as const) {
      const { deps, requests } = fakeDeps({ [FILE]: sized(file) });
      const got = ok(await fetchRemoteFile(FILE, deps, policy("attachment", category)));
      expect(got, name).toMatchObject({
        mode: "streamed",
        type,
        category,
        length: file.length,
        hosts: ["files.example"],
      });
      expect(requests[0]?.headers.get("accept-encoding")).toBe("identity");
      if (got.mode === "streamed") {
        expect(new Uint8Array(await new Response(got.body).arrayBuffer()), name).toEqual(file);
      }
    }
  });

  it("stores a streamed file whole in R2, and nothing of a short or long one", async () => {
    // Longer than the recognition prefix, so that the body is read on after it.
    const file = mp4({ mdat: 2 * MiB });
    const good = fakeDeps({ [FILE]: sized(file) });
    const got = ok(await fetchRemoteFile(FILE, good.deps, policy("attachment", "video")));
    const key = `test/remote-file/${crypto.randomUUID()}`;
    if (got.mode === "streamed") {
      await env.MEDIA.put(key, got.body);
    }
    expect((await env.MEDIA.head(key))?.size).toBe(file.length);
    for (const [name, chunks] of [
      ["short", [file.subarray(0, MiB), file.subarray(MiB, file.length - 10)]],
      ["long", [file.subarray(0, MiB), file.subarray(MiB), new Uint8Array(10)]],
    ] as const) {
      const { stream } = trackedStream([...chunks]);
      const { deps } = fakeDeps({ [FILE]: serve(stream, { "content-length": String(file.length) }) });
      const streamed = ok(await fetchRemoteFile(FILE, deps, policy("attachment", "video")));
      const missing = `test/remote-file/${crypto.randomUUID()}`;
      if (streamed.mode === "streamed") {
        await expect(env.MEDIA.put(missing, streamed.body), name).rejects.toThrow("network");
      }
      expect(await env.MEDIA.head(missing), name).toBeNull();
    }
  });

  it("refuses a stream without a length, past the cap or encoded, before reading it", async () => {
    for (const [name, headers, kind] of [
      ["no length", {}, "no-length"],
      ["past the cap", { "content-length": String(40 * MiB) }, "too-large"],
      ["gzip", { "content-length": "100", "content-encoding": "gzip" }, "encoding"],
    ] as const) {
      const { stream, state } = trackedStream([mp4()]);
      const { deps } = fakeDeps({
        [FILE]: () => {
          const response = new Response(stream, { headers });
          if (!("content-length" in headers)) {
            response.headers.delete("content-length");
          }
          return response;
        },
      });
      expect(failed(await fetchRemoteFile(FILE, deps, policy("attachment", "video"))), name).toMatchObject({
        kind,
        transient: false,
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(state.cancelled, name).toBe(true);
    }
  });

  it("refuses Ogg, a category mismatch and an image from the prefix, cancelling the rest unread", async () => {
    const big = concat(mp4({ handlers: ["vide"] }), new Uint8Array(2 * MiB));
    for (const [name, file, category, expected] of [
      ["Ogg", concat(oggPage(VORBIS_PACKET), new Uint8Array(2 * MiB)), "audio", { kind: "type", reason: "ogg" }],
      ["a video for an audio slot", big, "audio", { kind: "category" }],
      ["a WebM video for an audio slot", webm({ tracks: [1, 2] }), "audio", { kind: "category" }],
      ["an image for a video slot", bytes(GIF), "video", { kind: "type", reason: "type" }],
    ] as const) {
      const chunks = [file.subarray(0, MiB), file.subarray(MiB)].filter((chunk) => chunk.length > 0);
      const { stream, state } = trackedStream(chunks);
      const { deps } = fakeDeps({ [FILE]: serve(stream, { "content-length": String(file.length) }) });
      expect(failed(await fetchRemoteFile(FILE, deps, policy("attachment", category))), name).toMatchObject({
        ...expected,
        transient: false,
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(state.pulls, name).toBeLessThanOrEqual(2);
      if (file.length > MiB) {
        expect(state.cancelled, name).toBe(true);
      }
    }
  });

  it("NET-3: a returned stream errors at the file deadline while its consumer is still reading", async () => {
    // The prefix arrives, then the body stalls.
    const file = mp4({ mdat: 2 * MiB });
    const sent = file.subarray(0, MiB + 1024);
    const { stream, state } = trackedStream([sent], true);
    const { deps } = fakeDeps({ [FILE]: serve(stream, { "content-length": String(file.length) }) });
    const started = Date.now();
    const got = ok(await fetchRemoteFile(FILE, deps, { ...policy("attachment", "video"), deadline: started + 200 }));
    expect(got.mode).toBe("streamed");
    if (got.mode === "streamed") {
      const reader = got.body.getReader();
      let read = 0;
      await expect(
        (async () => {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) {
              return;
            }
            read += value.length;
          }
        })(),
      ).rejects.toThrow("timeout");
      expect(read).toBe(sent.length);
    }
    expect(Date.now() - started).toBeLessThan(2000);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(state.cancelled).toBe(true);
  });

  it("NET-3: a returned stream nobody reads errors at the file deadline, consuming nothing", async () => {
    const file = mp4({ mdat: 2 * MiB });
    const { stream, state } = trackedStream([file.subarray(0, MiB), file.subarray(MiB)]);
    const { deps } = fakeDeps({ [FILE]: serve(stream, { "content-length": String(file.length) }) });
    const started = Date.now();
    const got = ok(await fetchRemoteFile(FILE, deps, { ...policy("attachment", "video"), deadline: started + 200 }));
    if (got.mode !== "streamed") {
      throw new Error("expected a stream");
    }
    const reader = got.body.getReader();
    // Nothing is read until past the deadline.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(state.cancelled).toBe(true);
    // The deadline errored the body: the first read fails without a byte.
    await expect(reader.read()).rejects.toThrow("timeout");
    await expect(reader.closed).rejects.toThrow("timeout");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("NET-3: a small file nobody reads errors at the file deadline, though its body ended", async () => {
    // Within the prefix: upstream has ended, and only the consumer's reads are outstanding.
    const file = mp4();
    expect(file.length).toBeLessThan(MiB);
    const { deps, requests } = fakeDeps({ [FILE]: sized(file) });
    const started = Date.now();
    const got = ok(await fetchRemoteFile(FILE, deps, { ...policy("attachment", "video"), deadline: started + 200 }));
    if (got.mode !== "streamed") {
      throw new Error("expected a stream");
    }
    const reader = got.body.getReader();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(requests[0]?.signal.aborted).toBe(true);
    await expect(reader.read()).rejects.toThrow("timeout");
    await expect(reader.closed).rejects.toThrow("timeout");
  });

  it("NET-3: a consumer that pauses before the final chunk past the file deadline gets an error, not the rest", async () => {
    const file = mp4({ mdat: 2 * MiB });
    const { stream } = trackedStream([file.subarray(0, MiB), file.subarray(MiB)]);
    const { deps } = fakeDeps({ [FILE]: serve(stream, { "content-length": String(file.length) }) });
    const started = Date.now();
    const got = ok(await fetchRemoteFile(FILE, deps, { ...policy("attachment", "video"), deadline: started + 300 }));
    if (got.mode !== "streamed") {
      throw new Error("expected a stream");
    }
    const reader = got.body.getReader();
    let read = 0;
    while (read < MiB) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      read += value.length;
    }
    expect(read).toBeLessThan(file.length);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await expect(
      (async () => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            return;
          }
          read += value.length;
        }
      })(),
    ).rejects.toThrow("timeout");
    expect(read).toBeLessThan(file.length);
  });

  it("releases the call once the consumer has read every byte", async () => {
    const file = mp4();
    const { deps, requests } = fakeDeps({ [FILE]: sized(file) });
    const got = ok(await fetchRemoteFile(FILE, deps, policy("attachment", "video")));
    if (got.mode !== "streamed") {
      throw new Error("expected a stream");
    }
    expect(requests[0]?.signal.aborted).toBe(false);
    expect(new Uint8Array(await new Response(got.body).arrayBuffer())).toEqual(file);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(requests[0]?.signal.aborted).toBe(true);
  });
});

describe("fetchRemoteFile: a check that throws", () => {
  it("is a permanent failure that cancels the body, never an exception", async () => {
    const boom = () => {
      throw new RangeError("a bug");
    };
    const file = concat(mp4({ handlers: ["vide"] }), new Uint8Array(2 * MiB));
    const { stream, state } = trackedStream([file.subarray(0, MiB), file.subarray(MiB)]);
    const streamed = fakeDeps({ [FILE]: serve(stream, { "content-length": String(file.length) }) });
    const recognizing = createRemoteFileFetcher({ recognizeMedia: boom });
    expect(await recognizing(FILE, streamed.deps, policy("attachment", "video"))).toEqual({
      ok: false,
      kind: "malformed",
      reason: "verification",
      host: "files.example",
      transient: false,
      policyFailed: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(state.cancelled).toBe(true);
    for (const hook of ["verifyRemoteImage", "imageStill", "remoteImageMetadata"] as const) {
      const { deps } = fakeDeps({ [FILE]: serve(bytes(ANIMATED_GIF)) });
      expect(await createRemoteFileFetcher({ [hook]: boom })(FILE, deps, policy("avatar")), hook).toMatchObject({
        ok: false,
        kind: "malformed",
        reason: "verification",
        transient: false,
      });
    }
    // Without the hooks, the same files are fetched.
    const plain = fakeDeps({ [FILE]: serve(bytes(ANIMATED_GIF)) });
    expect(await createRemoteFileFetcher({})(FILE, plain.deps, policy("avatar"))).toMatchObject({ ok: true });
  });
});
