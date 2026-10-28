import {
  CARD_IMAGE_HOLD_MS,
  CARD_IMAGE_ROUND_CLAIMS,
  type CardImageClaim,
  type CardImageClaims,
  type CardImageOutcome,
  type CardImageStart,
} from "../domain/card-images";
import { imageBlurhash } from "../platform/blurhash";
import { readConfig } from "../platform/config";
import { DeadlinePassed, inTime, withinKept } from "../platform/deadline";
import { errorFields } from "../platform/error-message";
import { webpSize, sniffImageType } from "../platform/image-bytes";
import {
  codecFailure,
  encodeBounded,
  encodeRgba,
  IMAGE_MATRIX_LIMIT,
  type ImageCodec,
  imagesCodec,
  type Size,
} from "../platform/images";
import { fileKey } from "../platform/media-files";
import { PACKAGE_VERSION } from "../platform/package-version";
import { callStore, type StoreStub } from "../platform/store-client";
import {
  CARD_DECODE_PIXELS,
  CARD_IMAGE_BODY_LIMIT,
  CARD_GIF_MATRIX_LIMIT,
  CARD_IMAGE_EDGE_MAX,
  CARD_IMAGE_OUTPUT_LIMIT,
  CARD_IMAGE_PIXELS,
} from "../platform/stored-bounds";
import { randomToken } from "../security/tokens";
import type { InboxDeps } from "./inbox";
import { dnsCheckHost } from "./loader";
import {
  admittedHops,
  fetchWebImage,
  WEB_PAGE_MAX_STORE_CALLS,
  WEB_PAGE_MAX_SUBREQUESTS,
  type WebPageDeps,
  type WebPageFailure,
  webPageUrlRefusal,
} from "./web-page";

// Card images, the Worker's part (domain/card-images.ts; Mastodon's PreviewCard image with its vips processing,
// app/models/preview_card.rb and lib/paperclip/vips_lazy_thumbnail.rb, v4.5.11), the third caller of the web-page
// sink (NET-3). The cron runs one round per tick, outside the env's maintenance, on its own (jobs/scheduled.ts
// scheduledCardImages). A round (cardImagesRound):
//   1. claims (claimCardImages) at every share, so the Store's expiry and image GC run at 0 too, with fresh file
//      tokens only while IMAGES_CARD_MONTHLY_TRANSFORMS is above 0 and no call a round gave up is still running;
//   2. runs its claims one at a time, each within CARD_IMAGE_CLAIM_MS and the fetches' window CARD_IMAGE_FETCHES_MS;
//   3. releases the claims it did not start, one by one (unattempted), within the round's end, and starts none after a
//      claim that stops the round (I10, I11, a lost or budget claim) or while a given-up call runs.
// One claim (runClaim):
//   I0   a source the sink refuses (webPageUrlRefusal) is no image, before any network step;
//   I1   the sink failing (blocked, refused, redirects, network, a timeout before the claim's deadline, a status other
//        than 200) is no image; Mastodon accepts any 2xx (declared);
//   I2   the shared budget, a timeout at the deadline or a policy RPC error leaves the claim unattempted;
//   I3   a body of CARD_IMAGE_BODY_LIMIT bytes or more, refused while it is read, is no image;
//   then the steps of processCardImage below, then
//   I16  the env's maintenance, admission #3 refused, or the deadline passed before the put: unattempted, nothing put;
//   I17  the put failing or given up: unattempted, its tombstone kept (the write may still land, and reconciliation
//        deletes it); given up, it stops the round;
//   I18  a record whose fence was lost: the object goes through its tombstone;
//   I19  stored: files/<token>/full in the media bucket, the row stored and the tombstone deleted in one transaction.
// A GET: the User-Agent Kopje/<version> (+https://<domain>/) Bot and nothing else, at most 3 redirects, a final 200
// of any content type, its body without a copy (fetchWebImage). Every hop is admitted as a Store write before and after
// its DNS check (web-page.ts admittedHops). Bounds (RES-6, test/card-image-rounds.test.ts): per claim one GET of at
// most 4 hops (12 subrequests, 4 policy reads before DNS and 4 after), 4 Images calls, 1 put and 5 own Store calls (4
// admissions and a record); per round CARD_IMAGE_ROUND_CLAIMS claims and CARD_IMAGE_OWN_STORE_CALLS. Memory: one claim
// at a time (or one given-up call), test/cron-memory.test.ts. Logs carry the event, the step and the hostname
// only.
//
// The steps of one claim after its fetch (processCardImage), each Images call under the claim's guard:
//   I4   a signature that is not JPEG, PNG, GIF or WebP (sniffImageType) is no image;
//   I5   admission #1 (the env's maintenance and the fence, as a write) refused: the claim is lost;
//   I6   the preflight info() failing, naming another format or no size is no image;
//   I7   a GIF past CARD_GIF_MATRIX_LIMIT or another image past IMAGE_MATRIX_LIMIT pixels is no image;
//   I8   a target edge past CARD_IMAGE_EDGE_MAX is no image;
//   I9   admission #2 (startCardImage, which charges one transformation) before the WebP output: lost, or unattempted
//        past the share;
//   I10  a guard that gives up on either output, its read or the WebP output's info() leaves the claim unattempted
//        (what was charged stays charged) and stops the round (the call may still hold its memory);
//   I11  error 9422 from the preflight, the WebP output or its info() leaves the claim unattempted; from the RGBA
//        output the image is kept without a blurhash; either way the round stops, whatever else failed;
//   I12  another Images error, or a WebP output encodeChecked refuses, is no image;
//   I13  a WebP output past CARD_IMAGE_OUTPUT_LIMIT bytes, refused while it is read, is no image;
//   I14  a WebP output whose header size differs from info()'s, or is past CARD_IMAGE_EDGE_MAX or CARD_DECODE_PIXELS,
//        is no image, before the RGBA output is asked for;
//   I15  admission #2 again, right before the RGBA output (the same input and transformation, format rgba): lost, the
//        claim is lost; refused at the share, the image is kept without a blurhash and the round stopped; the RGBA
//        output failing with another Images error, longer than 4 × w × h of I14's size (refused while it is read),
//        shorter, or the blurhash failing keeps the image without a blurhash.
// The target (cardImageTarget): an image of more than CARD_IMAGE_PIXELS is resized to fit floor(sqrt(P × W / H)) by
// floor(sqrt(P × H / W)), each edge from 1 to the original's (Mastodon rounds, at most 1 pixel more an edge);
// the stored output is always a still WebP without metadata (platform/images.ts), and the blurhash's pixels are
// Images' raw RGBA of the same transformation (encodeRgba): the Worker decodes no image (NET-3).

// The box a source of `size` is resized to fit, or null when it is stored at its own size.
export function cardImageTarget(size: Size): Size | null {
  const { width, height } = size;
  if (width * height <= CARD_IMAGE_PIXELS) {
    return null;
  }
  const edge = (a: number, b: number, limit: number) =>
    Math.min(limit, Math.max(1, Math.floor(Math.sqrt((CARD_IMAGE_PIXELS * a) / b))));
  return { width: edge(width, height, width), height: edge(height, width, height) };
}

// What processCardImage made of one claim's bytes.
// `stop`: the round starts no further claim (a 9422, the share used up between the outputs, or a call given up that
// may still run).
export type ProcessedCardImage =
  | { kind: "encoded"; bytes: Uint8Array; width: number; height: number; blurhash: string | null; stop: boolean }
  | { kind: "none"; reason: string }
  | { kind: "unattempted"; reason: "budget" | "deadline" | "quota"; stop: boolean }
  | { kind: "lost" };

export type CardImageHooks = {
  // Runs one Images call, or one read of the output, under the claim's deadline; rejects with DeadlinePassed once
  // given up, or at once past the deadline (a call is then not started).
  guard: <T>(work: () => Promise<T>) => Promise<T>;
  // Admission #1 (I5), before the preflight info().
  admit: () => Promise<boolean>;
  // Admission #2 (I9, I15), right before each Images output.
  start: () => Promise<"ok" | "budget" | "lost">;
};

const ACCEPTED = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
// The RGBA of the most pixels a checked WebP may hold (I14), in bytes: 1,048,576.
const CARD_RGBA_LIMIT = CARD_DECODE_PIXELS * 4;

// A failed Images call as a claim's outcome (I10-I12): a guard's give-up first, then 9422, then the rest.
function callFailure(error: unknown, what: string): ProcessedCardImage {
  if (error instanceof DeadlinePassed) {
    return { kind: "unattempted", reason: "deadline", stop: true };
  }
  const failure = codecFailure(error);
  return failure === "quota"
    ? { kind: "unattempted", reason: "quota", stop: true }
    : { kind: "none", reason: `${what} ${failure}` };
}

// Steps I4 to I14 over the fetched bytes: the checked output and its transformation's target, or the claim's outcome.
async function encodeInput(
  codec: ImageCodec,
  bytes: Uint8Array,
  hooks: CardImageHooks,
): Promise<{ bytes: Uint8Array; width: number; height: number; target: Size | null } | ProcessedCardImage> {
  const type = sniffImageType(bytes);
  if (type === null || !ACCEPTED.has(type)) {
    return { kind: "none", reason: "type" };
  }
  if (!(await hooks.admit())) {
    return { kind: "lost" };
  }
  let info;
  try {
    info = await hooks.guard(() => codec.info(bytes));
  } catch (error) {
    return callFailure(error, "info");
  }
  const { width, height } = info;
  if (info.format !== type || width === undefined || height === undefined || width < 1 || height < 1) {
    return { kind: "none", reason: "info" };
  }
  if (width * height > (type === "image/gif" ? CARD_GIF_MATRIX_LIMIT : IMAGE_MATRIX_LIMIT)) {
    return { kind: "none", reason: "pixels" };
  }
  const target = cardImageTarget({ width, height });
  if (Math.max(target?.width ?? width, target?.height ?? height) > CARD_IMAGE_EDGE_MAX) {
    return { kind: "none", reason: "edge" };
  }
  const started = await hooks.start();
  if (started !== "ok") {
    return started === "lost" ? { kind: "lost" } : { kind: "unattempted", reason: "budget", stop: false };
  }
  let output;
  try {
    output = await encodeBounded(
      codec,
      bytes,
      { ...target, format: "image/webp", still: true },
      CARD_IMAGE_OUTPUT_LIMIT,
      hooks.guard,
    );
  } catch (error) {
    return callFailure(error, "encode");
  }
  const header = webpSize(output.bytes);
  if (
    header === null ||
    header.width !== output.width ||
    header.height !== output.height ||
    Math.max(header.width, header.height) > CARD_IMAGE_EDGE_MAX ||
    header.width * header.height > CARD_DECODE_PIXELS
  ) {
    return { kind: "none", reason: "output size" };
  }
  return { bytes: output.bytes, width: header.width, height: header.height, target };
}

// Steps I4 to I15 over a claim's fetched bytes (`input.bytes`, held for both outputs and dropped on every exit after
// them). See the module's head.
export async function processCardImage(
  codec: ImageCodec,
  input: { bytes: Uint8Array | null },
  hooks: CardImageHooks,
): Promise<ProcessedCardImage> {
  const source = input.bytes;
  try {
    if (source === null) {
      return { kind: "none", reason: "empty" };
    }
    const encoded = await encodeInput(codec, source, hooks);
    if ("kind" in encoded) {
      return encoded;
    }
    const { target, ...image } = encoded;
    const kept = (blurhash: string | null, stop: boolean): ProcessedCardImage => ({
      kind: "encoded",
      ...image,
      blurhash,
      stop,
    });
    const started = await hooks.start();
    if (started !== "ok") {
      return started === "lost" ? { kind: "lost" } : kept(null, true);
    }
    let rgba;
    try {
      // The WebP's own input and transformation, read within the size of its verified header (I14).
      rgba = await encodeRgba(codec, source, { ...target }, image, CARD_RGBA_LIMIT, hooks.guard);
    } catch (error) {
      const failure = callFailure(error, "rgba");
      if (failure.kind === "unattempted" && failure.reason === "deadline") {
        return failure;
      }
      return kept(null, failure.kind === "unattempted");
    }
    return kept(imageBlurhash(rgba), false);
  } finally {
    input.bytes = null;
  }
}

// ---- The round

export const CARD_IMAGE_ROUND_MS = 60_000;
const CARD_IMAGE_FINISH_MS = 10_000;
export const CARD_IMAGE_FETCHES_MS = CARD_IMAGE_ROUND_MS - CARD_IMAGE_FINISH_MS;
export const CARD_IMAGE_CLAIM_MS = 16_000;
// Each claim's work fits the fetches' window, and a claim's hold outlasts twice the round that holds it.
if (CARD_IMAGE_ROUND_CLAIMS * CARD_IMAGE_CLAIM_MS > CARD_IMAGE_FETCHES_MS) {
  throw new Error("a card image round's claims must fit CARD_IMAGE_FETCHES_MS");
}
if (CARD_IMAGE_HOLD_MS < 2 * CARD_IMAGE_ROUND_MS) {
  throw new Error("CARD_IMAGE_HOLD_MS must be at least twice a card image round");
}
export const CARD_IMAGE_SUBREQUESTS = CARD_IMAGE_ROUND_CLAIMS * WEB_PAGE_MAX_SUBREQUESTS;
export const CARD_IMAGE_STORE_CALLS = CARD_IMAGE_ROUND_CLAIMS * WEB_PAGE_MAX_STORE_CALLS;
export const CARD_IMAGE_IMAGES_CALLS = CARD_IMAGE_ROUND_CLAIMS * 4;
export const CARD_IMAGE_PUTS = CARD_IMAGE_ROUND_CLAIMS;
export const CARD_IMAGE_OWN_STORE_CALLS = 1 + CARD_IMAGE_ROUND_CLAIMS * 5;

export type CardImagesDeps = InboxDeps & {
  // Tests only: the codec over the Images binding, the sink's GET, the bucket and the file tokens.
  images?: (env: Env) => ImageCodec;
  fetchWebImage?: typeof fetchWebImage;
  bucket?: (env: Env) => R2Bucket;
  randomToken?: () => string;
};

export type CardImagesRound = {
  claimed: number;
  stored: number;
  none: number;
  unattempted: number;
  released: number;
  lost: number;
  // Whether the round stopped starting claims (I10, I11, a lost or budget claim, or a given-up call running).
  stopped: boolean;
};

// The calls a round gave up that are still running: each keeps its memory, so no round starts a claim while
// any is. Module scope: one isolate's.
const running = new Set<Promise<unknown>>();

// The given-up calls still running, for the memory model's witnesses.
export function outstandingCardImageCalls(): number {
  return running.size;
}

// `work` within `end`, a call given up kept in `running` until it settles.
function bounded<T>(work: () => Promise<T>, end: number, now: () => number): Promise<T> {
  return withinKept(running, work, end, now);
}

// Whether the env holds the Worker in maintenance (a write must not start).
function envMaintenance(env: Env): boolean {
  const config = readConfig(env);
  return !config.ok || config.config.MAINTENANCE !== "off";
}

type ClaimResult = { outcome: CardImageOutcome | "lost"; stop: boolean; step: string; host?: string | null };

// One round (above). Returns what it did, for the logs and tests.
export async function cardImagesRound(env: Env, deps: CardImagesDeps): Promise<CardImagesRound> {
  const build = deps.build(env);
  const rpc = <T>(call: (store: StoreStub) => Promise<T>) => callStore(() => call(deps.store(env)));
  const config = readConfig(env);
  const share = config.ok ? config.config.IMAGES_CARD_MONTHLY_TRANSFORMS : 0;
  const start = deps.now();
  const end = start + CARD_IMAGE_ROUND_MS;
  const fetchesEnd = start + CARD_IMAGE_FETCHES_MS;
  const round: CardImagesRound = {
    claimed: 0,
    stored: 0,
    none: 0,
    unattempted: 0,
    released: 0,
    lost: 0,
    stopped: running.size > 0,
  };
  const token = deps.randomToken ?? randomToken;
  const tokens = share > 0 && running.size === 0 ? Array.from({ length: CARD_IMAGE_ROUND_CLAIMS }, token) : [];
  const claimed = await inTime(
    () => rpc((s) => s.claimCardImages(build, { now: deps.now(), tokens, share }) as Promise<CardImageClaims>),
    fetchesEnd,
    deps.now,
  );
  if (claimed.expired > 0 || claimed.dropped > 0 || claimed.collected > 0 || claimed.paused) {
    console.log({
      event: "kopje.card_images.maintained",
      expired: claimed.expired,
      dropped: claimed.dropped,
      collected: claimed.collected,
      paused: claimed.paused,
    });
  }
  if (claimed.domain === null || claimed.claims.length === 0) {
    return round;
  }
  round.claimed = claimed.claims.length;
  const codec = deps.images?.(env) ?? imagesCodec(env.IMAGES);
  const bucket = deps.bucket?.(env) ?? env.MEDIA;
  const get = deps.fetchWebImage ?? fetchWebImage;
  const dns = deps.loader.checkHost ?? dnsCheckHost;
  const userAgent = `Kopje/${PACKAGE_VERSION} (+https://${claimed.domain}/) Bot`;
  const budget = { subrequests: CARD_IMAGE_SUBREQUESTS, storeCalls: CARD_IMAGE_STORE_CALLS, deadline: fetchesEnd };
  const fence = (claim: CardImageClaim) => ({ id: claim.id, claim: claim.claim, token: claim.token });
  // An admission (#1 or #3): the env's maintenance first, then the Store's write under the fence, within `until`.
  const admitted = async (claim: CardImageClaim, until: number): Promise<boolean> => {
    if (envMaintenance(env)) {
      return false;
    }
    try {
      return (await inTime(() => rpc((s) => s.admitCardImage(build, fence(claim))), until, deps.now)).held;
    } catch {
      return false;
    }
  };

  const runClaim = async (claim: CardImageClaim, until: number): Promise<ClaimResult> => {
    if (webPageUrlRefusal(claim.sourceUrl) !== null) {
      return { outcome: { kind: "none" }, stop: false, step: "url" };
    }
    const admission = admittedHops((host) => rpc((s) => s.webHopRefused(build, { host })), dns);
    const web: WebPageDeps = { fetch: deps.loader.fetch, ...admission.web, userAgent, now: deps.now };
    const fetched = await get(claim.sourceUrl, web, { budget, deadline: until, maxBytes: CARD_IMAGE_BODY_LIMIT - 1 });
    if (!fetched.ok) {
      const failure: WebPageFailure = fetched;
      const later =
        admission.failed() || failure.kind === "budget" || (failure.kind === "timeout" && deps.now() >= until);
      return { outcome: { kind: later ? "unattempted" : "none" }, stop: false, step: failure.kind, host: failure.host };
    }
    const host = new URL(fetched.finalUrl).hostname;
    const processed = await processCardImage(
      codec,
      { bytes: fetched.bytes },
      {
        guard: (work) => bounded(work, until, deps.now),
        admit: () => admitted(claim, until),
        start: async () => {
          if (envMaintenance(env)) {
            return "lost";
          }
          try {
            const started = await inTime(
              () =>
                rpc(
                  (s) =>
                    s.startCardImage(build, { ...fence(claim), share, now: deps.now() }) as Promise<CardImageStart>,
                ),
              until,
              deps.now,
            );
            return started.status;
          } catch {
            return "lost";
          }
        },
      },
    );
    if (processed.kind === "lost") {
      return { outcome: "lost", stop: true, step: "admission", host };
    }
    if (processed.kind === "none") {
      return { outcome: { kind: "none" }, stop: false, step: processed.reason, host };
    }
    if (processed.kind === "unattempted") {
      return {
        outcome: { kind: "unattempted" },
        stop: processed.stop || processed.reason === "budget",
        step: processed.reason,
        host,
      };
    }
    // I16: nothing is put once the env or the Store refuses a write, or the deadline has passed. `processed.stop`
    // (I11, I15) stops the round whatever happens after it.
    if (!(await admitted(claim, until))) {
      return { outcome: { kind: "unattempted" }, stop: processed.stop, step: "admission", host };
    }
    try {
      await bounded(
        () =>
          bucket.put(fileKey(claim.token, "full"), processed.bytes, { httpMetadata: { contentType: "image/webp" } }),
        until,
        deps.now,
      );
    } catch (error) {
      return {
        outcome: { kind: "unattempted" },
        stop: processed.stop || error instanceof DeadlinePassed,
        step: "put",
        host,
      };
    }
    return {
      outcome: { kind: "stored", width: processed.width, height: processed.height, blurhash: processed.blurhash },
      stop: processed.stop,
      step: "stored",
      host,
    };
  };

  const record = (claim: CardImageClaim, outcome: CardImageOutcome) =>
    inTime(() => rpc((s) => s.recordCardImage(build, { ...fence(claim), outcome, now: deps.now() })), end, deps.now);

  const queue = [...claimed.claims];
  for (let claim = queue.shift(); claim !== undefined; claim = queue.shift()) {
    if (round.stopped || running.size > 0 || deps.now() >= fetchesEnd) {
      round.stopped = true;
      queue.unshift(claim);
      break;
    }
    try {
      const result = await runClaim(claim, Math.min(fetchesEnd, deps.now() + CARD_IMAGE_CLAIM_MS));
      round.stopped ||= result.stop;
      if (result.step !== "stored") {
        console.log({ event: "kopje.card_images.no_image", step: result.step, host: result.host ?? null });
      }
      if (result.outcome === "lost") {
        round.lost++;
        continue;
      }
      const recorded = await record(claim, result.outcome);
      if (!recorded.held) {
        round.lost++;
      } else {
        round[result.outcome.kind]++;
      }
    } catch (error) {
      // The claim stays open and is claimed again after its hold.
      round.lost++;
      if (!(error instanceof DeadlinePassed)) {
        console.error({ event: "kopje.card_images.claim_failed", ...errorFields(error) });
      }
    }
  }
  for (const claim of queue) {
    try {
      if ((await record(claim, { kind: "unattempted" })).held) {
        round.released++;
      }
    } catch (error) {
      if (!(error instanceof DeadlinePassed)) {
        console.error({ event: "kopje.card_images.release_failed", ...errorFields(error) });
      }
      break;
    }
  }
  return round;
}
