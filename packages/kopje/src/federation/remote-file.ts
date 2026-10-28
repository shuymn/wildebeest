import { normalizeDomain } from "../platform/domain-name";
import { remoteMediaUrlRefusal } from "../platform/http-url";
import type { ImageType } from "../platform/image-bytes";
import { imageStill } from "../platform/image-still";
import { PACKAGE_VERSION } from "../platform/package-version";
import {
  type MediaRefusal,
  type MediaType,
  RECOGNITION_PREFIX_BYTES,
  recognizeMedia,
  type RemoteCategory,
  type RemoteFileKind,
  remoteFileLimits,
  remoteImageMetadata,
  verifyRemoteImage,
} from "../platform/remote-media-bytes";
import {
  admittedHops,
  fetchWebMedia,
  streamWebMedia,
  type WebPageBudget,
  type WebPageDeps,
  type WebPageFailure,
  type WebPageRefusal,
} from "./web-page";

// One remote media file (NET-3 in docs/threat-model.md), fetched through the web-page sink's media mode
// and verified, with nothing stored: the caller writes what it returns. fetchRemoteFile:
//   - refuses a URL the sink's rules refuse, or one on the instance's own host, before any network step;
//   - admits every hop through `admit` (the Store's webHopRefused, a write) before and after its DNS check, the own
//     host refused at every hop as a blocked host, unsigned, sending only the User-Agent
//     Kopje/<version> (+https://<domain>/) (and accept-encoding: identity when streamed);
//   - reads an image whole within its kind's cap and verifies it in place (platform/remote-media-bytes.ts), and makes
//     a still of an animated one within its kind's still cap (platform/image-still.ts); or
//   - streams a video or audio file of a declared length within its cap, recognized from its first
//     RECOGNITION_PREFIX_BYTES bytes before anything is read past them, as the sink's body of known length (web-page.ts
//     handOver), which a refusal cancels.
// Everything is bound to the file's deadline, which a streamed body carries too.

export type { RemoteFileKind };

// What a kind takes in a category: read whole (an image) or streamed (video and audio), the image types it accepts,
// the largest file and the largest still in bytes (each cap less one: files are less than the cap), or no still.
export type RemoteFileRule =
  | { mode: "buffered"; types: readonly ImageType[]; maxBytes: number; stillMaxBytes: number | null }
  | { mode: "streamed"; maxBytes: number };

const PROFILE_TYPES: readonly ImageType[] = ["image/jpeg", "image/png", "image/gif", "image/webp"];
const EMOJI_TYPES: readonly ImageType[] = ["image/png", "image/gif", "image/webp"];
const IMAGE_TYPES: readonly ImageType[] = ["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif"];

// The kind's limits (platform/remote-media-bytes.ts remoteFileLimits) with the image types it takes: avatars and
// headers JPEG, PNG, GIF or WebP; emoji PNG, GIF or WebP; thumbnails and attachment images any of them or AVIF.
export function remoteFileRule(kind: RemoteFileKind, category: RemoteCategory): RemoteFileRule | null {
  const limits = remoteFileLimits(kind, category);
  if (limits === null) {
    return null;
  }
  if (limits.streamed) {
    return { mode: "streamed", maxBytes: limits.maxBytes };
  }
  const types = kind === "emoji" ? EMOJI_TYPES : kind === "avatar" || kind === "header" ? PROFILE_TYPES : IMAGE_TYPES;
  return { mode: "buffered", types, maxBytes: limits.maxBytes, stillMaxBytes: limits.stillMaxBytes };
}

export type RemoteFilePolicy = {
  kind: RemoteFileKind;
  // The category the owner's current type gives (images for every kind but an attachment).
  category: RemoteCategory;
  // The file's deadline (Date.now() epoch ms): DNS, every hop, the body and a streamed body's reading.
  deadline: number;
  budget?: WebPageBudget;
  signal?: AbortSignal;
};

export type RemoteFileDeps = {
  // Production: the Worker's global fetch (federation/web-page.ts).
  fetch: typeof fetch;
  checkHost?: (url: URL) => Promise<void>;
  // Each hop's domain policy, true when refused: the Store's webHopRefused.
  admit: (host: string) => Promise<boolean>;
  // The instance's domain, which is never fetched from.
  domain: string;
  now: () => number;
};

export type RemoteStill = { type: ImageType; bytes: Uint8Array };

export type RemoteFile =
  | {
      ok: true;
      mode: "buffered";
      type: ImageType;
      category: "image";
      // A view of the read buffer, stripped in place.
      bytes: Uint8Array;
      width: number;
      height: number;
      animated: boolean;
      still: RemoteStill | null;
      hosts: string[];
    }
  | {
      ok: true;
      mode: "streamed";
      type: MediaType;
      category: "video" | "audio";
      length: number;
      // Exactly `length` bytes, erroring at the file's deadline.
      body: ReadableStream<Uint8Array>;
      hosts: string[];
    };

export type RemoteFileFailureKind =
  | WebPageFailure["kind"]
  | "kind"
  | "type"
  | "category"
  | "malformed"
  | "orientation"
  | "pixels"
  | "metadata";

// A failure names a closed kind, its reason and the hostname only. `transient`: trying again later may succeed (the
// sink's classes). `policyFailed`: a domain policy RPC failed at some hop, so the attempt does not count.
export type RemoteFileFailure = {
  ok: false;
  kind: RemoteFileFailureKind;
  reason?: WebPageFailure["reason"] | "own-host" | MediaRefusal | "verification";
  status?: number;
  host: string | null;
  transient: boolean;
  policyFailed: boolean;
};

// The rule a remote file URL breaks before any network step: the sink's (web-page.ts webPageUrlRefusal), or the
// instance's own host.
export function remoteFileUrlRefusal(url: string, domain: string): WebPageRefusal | "own-host" | null {
  return remoteMediaUrlRefusal(url, domain);
}

function ownDomain(domain: string): string {
  return normalizeDomain(domain) ?? domain;
}

function permanent(
  kind: RemoteFileFailureKind,
  host: string | null,
  reason?: RemoteFileFailure["reason"],
): RemoteFileFailure {
  return { ok: false, kind, ...(reason === undefined ? {} : { reason }), host, transient: false, policyFailed: false };
}

// The byte checks fetchRemoteFile runs; a test may replace one (createRemoteFileFetcher). Production code never does.
export type RemoteFileChecks = {
  recognizeMedia: typeof recognizeMedia;
  verifyRemoteImage: typeof verifyRemoteImage;
  imageStill: typeof imageStill;
  remoteImageMetadata: typeof remoteImageMetadata;
};

const CHECKS: RemoteFileChecks = { recognizeMedia, verifyRemoteImage, imageStill, remoteImageMetadata };

export function createRemoteFileFetcher(testHooks: Partial<RemoteFileChecks>) {
  const checks = { ...CHECKS, ...testHooks };
  return (url: string, deps: RemoteFileDeps, policy: RemoteFilePolicy) => getRemoteFile(url, deps, policy, checks);
}

export function fetchRemoteFile(
  url: string,
  deps: RemoteFileDeps,
  policy: RemoteFilePolicy,
): Promise<RemoteFile | RemoteFileFailure> {
  return getRemoteFile(url, deps, policy, CHECKS);
}

// A check that throws (a bug, never a property of the file) is a permanent failure, its body cancelled; it never
// escapes to the caller.
function guarded<T>(check: () => T, host: string, body?: ReadableStream<Uint8Array>): T | RemoteFileFailure {
  try {
    return check();
  } catch {
    body?.cancel().catch(() => {});
    return permanent("malformed", host, "verification");
  }
}

async function getRemoteFile(
  url: string,
  deps: RemoteFileDeps,
  policy: RemoteFilePolicy,
  checks: RemoteFileChecks,
): Promise<RemoteFile | RemoteFileFailure> {
  const rule = remoteFileRule(policy.kind, policy.category);
  if (rule === null) {
    return permanent("kind", null);
  }
  const refusal = remoteFileUrlRefusal(url, deps.domain);
  if (refusal !== null) {
    return permanent("refused", null, refusal);
  }
  const own = ownDomain(deps.domain);
  const admission = admittedHops((host) => (host === own ? Promise.resolve(true) : deps.admit(host)), deps.checkHost);
  const web: WebPageDeps = {
    fetch: deps.fetch,
    ...admission.web,
    userAgent: `Kopje/${PACKAGE_VERSION} (+https://${own}/)`,
    now: deps.now,
  };
  const options = { deadline: policy.deadline, budget: policy.budget, signal: policy.signal, maxBytes: rule.maxBytes };
  const failed = (failure: WebPageFailure): RemoteFileFailure => ({
    ok: false,
    kind: failure.kind,
    ...(failure.reason === undefined ? {} : { reason: failure.reason }),
    ...(failure.status === undefined ? {} : { status: failure.status }),
    host: failure.host,
    transient: failure.transient,
    policyFailed: admission.failed(),
  });
  if (rule.mode === "streamed") {
    const got = await streamWebMedia(url, web, { ...options, prefixBytes: RECOGNITION_PREFIX_BYTES });
    if (!got.ok) {
      return failed(got);
    }
    const host = new URL(got.finalUrl).hostname;
    const media = guarded(() => checks.recognizeMedia(got.prefix, got.length), host, got.body);
    if ("policyFailed" in media) {
      return media;
    }
    if (!media.ok || media.category !== policy.category) {
      got.body.cancel().catch(() => {});
      return media.ok ? permanent("category", host) : permanent("type", host, media.refusal);
    }
    return {
      ok: true,
      mode: "streamed",
      type: media.type,
      category: media.category,
      length: got.length,
      body: got.body,
      hosts: got.hosts,
    };
  }
  const got = await fetchWebMedia(url, web, options);
  if (!got.ok) {
    return failed(got);
  }
  const host = new URL(got.finalUrl).hostname;
  const verified = guarded(() => {
    const image = checks.verifyRemoteImage(got.bytes, rule.types);
    if (!image.ok) {
      return permanent(image.refusal, host);
    }
    let still: RemoteStill | null = null;
    if (image.animated && rule.stillMaxBytes !== null) {
      const bytes = checks.imageStill(image.bytes, image.type, rule.stillMaxBytes);
      if (bytes !== null && checks.remoteImageMetadata(bytes, image.type) === null) {
        still = { type: image.type, bytes };
      }
    }
    return { image, still };
  }, host);
  if ("policyFailed" in verified) {
    return verified;
  }
  const { image, still } = verified;
  return {
    ok: true,
    mode: "buffered",
    type: image.type,
    category: "image",
    bytes: image.bytes,
    width: image.width,
    height: image.height,
    animated: image.animated,
    still,
    hosts: got.hosts,
  };
}
