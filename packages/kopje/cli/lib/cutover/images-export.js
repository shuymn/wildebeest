// `kopje-admin images-export`: downloads the images a legacy instance kept in Cloudflare Images, so the cutover can
// move them into Kopje's own media (docs/cutover.md, "Media"). It runs on the operator's machine, before the cutover
// and again on the final export; a rerun downloads only what is not there yet.
//
// Legacy stored local images in Cloudflare Images and wrote their delivery URLs into the data:
// https://imagedelivery.net/<account hash>/<image id>/<variant>. This command reads the export, collects every image
// id under the operator's account hash from the columns the converter carries over (actor and object properties, and
// earlier versions of edited statuses), and downloads each image once: the original through the Images API when a token
// is given, else a delivery URL as found in the data (a variant, so possibly resized). Each file is checked against
// the limits Kopje applies to uploads, by its signature, never by a header, and written under <out>/originals/<image
// id> with mode 0600. <out>/images.json records, per image id, its digest, type and size, or that it is missing, and a
// secret made once for the image and kept through every later run: the converter derives each media row's file token
// from it (mediaToken), so the converted URLs stay the same for the same images.json. `convert --images <out>` then
// maps the references, and `verify-conversion --images <out>` checks them.
//
// What it prints holds counts only (DATA-13). The API token comes from the environment only (CF_IMAGES_TOKEN), is sent
// only to the Images API, and is redacted from anything printed.

import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

import { checkSizes, exportFiles } from "./export-files.js";
import { imageSize } from "./image-size.js";
import { sniffImageType } from "./kopje-runtime.js";
import { loadLegacyExport } from "./legacy-load.js";
import { ExportError } from "./sql-script.js";
import { IMAGE_MATRIX_LIMIT, IMAGE_SIZE_LIMIT, TOKEN_SHAPE } from "./upload-rules.js";

export const IMAGES_FILE = "images.json";
export const ORIGINALS_DIR = "originals";
export const IMAGES_FORMAT = 1;
export const DELIVERY_PREFIX = "https://imagedelivery.net/";

// The account hash of the images cloudflare/wildebeest ships as defaults (its default header). A profile image under
// it is a default, not the user's: the converter leaves it out, so Kopje's own default applies.
export const UPSTREAM_ACCOUNT_HASH = "NkfPDviynOyTAOI79ar_GQ";
// Legacy's default avatar, which it hotlinks from Mastodon's repository.
export const LEGACY_DEFAULT_AVATAR =
  "https://raw.githubusercontent.com/mastodon/mastodon/main/public/avatars/original/missing.png";

export const ACCOUNT_HASH = /^[A-Za-z0-9_-]{8,64}$/;
// Images ids legacy got from the Images API are UUIDs; anything that could leave the originals directory is refused.
export const IMAGE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const VARIANT = /^[A-Za-z0-9_=,.-]{1,128}$/;
const ACCOUNT_ID = /^[0-9a-f]{32}$/;

// The files are written at most this often while downloading (and always at the end or on a failure), so a run
// that is interrupted repeats at most this many downloads.
const SAVE_EVERY = 25;
const TIMEOUT_MS = 120_000;

/**
 * @typedef {{ state: 'ok', secret: string, sha256: string, type: string, width: number, height: number, bytes: number,
 *   from: 'api' | 'delivery' } | { state: 'missing', secret: string, reason: MissingReason }} ImageEntry
 * @typedef {'not-found' | 'unsupported-type' | 'too-large' | 'too-many-pixels' | 'unreadable'} MissingReason
 * @typedef {{ accountHash: string, domain: string, images: Map<string, ImageEntry> }} ImagesFile
 * @typedef {(url: string, init?: RequestInit) => Promise<Response>} Fetch
 */

/**
 * The parts of a delivery URL, or null for any other URL.
 * @param {unknown} url
 * @returns {{ hash: string, id: string | null, variant: string | null } | null}
 */
export function parseDeliveryUrl(url) {
  if (typeof url !== "string" || !url.startsWith(DELIVERY_PREFIX)) {
    return null;
  }
  const parts = url.slice(DELIVERY_PREFIX.length).split("/");
  const [hash = "", id = "", variant = ""] = parts;
  const wellFormed = parts.length === 3 && IMAGE_ID.test(id) && VARIANT.test(variant);
  return { hash, id: wellFormed ? id : null, variant: wellFormed ? variant : null };
}

/**
 * Every string in a JSON value.
 * @param {unknown} value
 * @param {(text: string) => void} visit
 * @param {number} [depth]
 */
function strings(value, visit, depth = 0) {
  if (typeof value === "string") {
    visit(value);
  } else if (typeof value === "object" && value !== null && depth < 64) {
    for (const item of Object.values(value)) {
      strings(item, visit, depth + 1);
    }
  }
}

/**
 * The image ids under one account hash in the columns the converter carries over, each with the first variant seen.
 * Malformed URLs under the hash are counted; the converter refuses them.
 * @param {import('node:sqlite').DatabaseSync} db the bridged legacy database
 * @param {string} accountHash
 */
export function collectImageIds(db, accountHash) {
  /** @type {Map<string, string>} */
  const ids = new Map();
  let malformed = 0;
  const sources = [
    "SELECT properties AS json FROM actors ORDER BY rowid",
    "SELECT properties AS json FROM objects ORDER BY rowid",
    "SELECT properties AS json FROM object_revisions ORDER BY id",
  ];
  for (const sql of sources) {
    for (const row of /** @type {{ json: unknown }[]} */ (db.prepare(sql).all())) {
      /** @type {unknown} */
      let parsed;
      try {
        parsed = /** @type {unknown} */ (JSON.parse(String(row.json)));
      } catch {
        continue;
      }
      strings(parsed, (text) => {
        const url = parseDeliveryUrl(text);
        if (url === null || url.hash !== accountHash) {
          return;
        }
        if (url.id === null || url.variant === null) {
          malformed++;
        } else if (!ids.has(url.id)) {
          ids.set(url.id, url.variant);
        }
      });
    }
  }
  return { ids, malformed };
}

/**
 * The local domain, as the converter takes it: the host of every local actor, which must be one.
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function localDomain(db) {
  const hosts = new Set(
    /** @type {{ actor_id: unknown }[]} */ (db.prepare("SELECT actor_id FROM users").all()).map(
      (u) => /^https:\/\/([^/]+)\/ap\/users\/[^/]+$/.exec(String(u.actor_id))?.[1]?.toLowerCase() ?? "",
    ),
  );
  if (hosts.size !== 1 || hosts.has("")) {
    throw new ExportError("images-domain-unclear");
  }
  return /** @type {string} */ ([...hosts][0]);
}

/**
 * Reads and checks <dir>/images.json. Throws ExportError('images-file-invalid') when it is not one this command wrote.
 * @param {string} dir
 * @returns {ImagesFile | null} null when there is none
 */
export function readImagesFile(dir) {
  let text;
  try {
    text = readFileSync(join(dir, IMAGES_FILE), "utf8");
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") {
      return null;
    }
    throw new ExportError("images-file-invalid");
  }
  /** @type {Record<string, unknown> | null} */
  let value;
  try {
    value = /** @type {Record<string, unknown> | null} */ (JSON.parse(text));
  } catch {
    throw new ExportError("images-file-invalid");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    value.format !== IMAGES_FORMAT ||
    typeof value.accountHash !== "string" ||
    !ACCOUNT_HASH.test(value.accountHash) ||
    typeof value.domain !== "string" ||
    typeof value.images !== "object" ||
    value.images === null
  ) {
    throw new ExportError("images-file-invalid");
  }
  /** @type {Map<string, ImageEntry>} */
  const images = new Map();
  for (const [id, entry] of Object.entries(/** @type {Record<string, unknown>} */ (value.images))) {
    if (!IMAGE_ID.test(id) || !validEntry(entry)) {
      throw new ExportError("images-file-invalid");
    }
    images.set(id, entry);
  }
  return { accountHash: value.accountHash, domain: value.domain, images };
}

const TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif"]);
const REASONS = new Set(["not-found", "unsupported-type", "too-large", "too-many-pixels", "unreadable"]);

/**
 * @param {unknown} value
 * @returns {value is ImageEntry}
 */
function validEntry(value) {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const entry = /** @type {Record<string, unknown>} */ (value);
  if (typeof entry.secret !== "string" || !TOKEN_SHAPE.test(entry.secret)) {
    return false;
  }
  if (entry.state === "missing") {
    return typeof entry.reason === "string" && REASONS.has(entry.reason);
  }
  const dimension = (/** @type {unknown} */ n) => Number.isInteger(n) && Number(n) > 0 && Number(n) <= 65535;
  return (
    entry.state === "ok" &&
    typeof entry.sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(entry.sha256) &&
    typeof entry.type === "string" &&
    TYPES.has(entry.type) &&
    dimension(entry.width) &&
    dimension(entry.height) &&
    Number.isInteger(entry.bytes) &&
    (entry.from === "api" || entry.from === "delivery")
  );
}

// An image's secret: 32 random bytes as base64url, as Kopje's upload path makes a file token (randomToken in
// src/security/tokens.ts, which the CLI cannot load on Node because it also uses a Workers-only API).
export function imageSecret() {
  return randomBytes(32).toString("base64url");
}

/**
 * The file token of one media row showing an image: HMAC-SHA256 under the image's secret of the row's key, as base64url
 * (43 characters, the shape of Kopje's own tokens). Keys name the reference, never an assigned id, so the token depends
 * only on images.json and the legacy data: `profile\n<actor URI>\n<avatar|header>`, `attachment\n<status URI>\n<position>`,
 * `image\n<Image object id>` for an unattached image, `edit\n<status URI>\n<image id>` for one only earlier versions show.
 * Without the secret a token cannot be derived from what is public (the URIs and the image id).
 * @param {string} secret
 * @param {string} key
 */
export function mediaToken(secret, key) {
  return createHmac("sha256", secret).update(key).digest("base64url");
}

/** @param {Uint8Array} bytes */
export function sha256Of(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * An existing directory that is not a symbolic link, or a new one (mode 0700).
 * @param {string} dir
 */
function ensureDirectory(dir) {
  let info;
  try {
    info = lstatSync(dir);
  } catch {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    info = lstatSync(dir);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new ExportError("output-not-a-directory");
  }
}

/**
 * Writes bytes under a fresh temporary name, created exclusively with mode 0600, and returns that name.
 * @param {string} dir
 * @param {string} name
 * @param {Uint8Array | string} data
 */
function writeTemporary(dir, name, data) {
  const temporary = join(dir, `.${name}.${randomBytes(8).toString("hex")}.tmp`);
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeSync(fd, typeof data === "string" ? new TextEncoder().encode(data) : data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return temporary;
}

/**
 * Publishes an original under its image id with link(2). A file already there is one an interrupted run left without
 * recording it, or one that no longer matches its digest: it is a regular file of this directory and is replaced.
 * @param {string} dir
 * @param {string} id
 * @param {Uint8Array} bytes
 */
function writeOriginal(dir, id, bytes) {
  const path = join(dir, id);
  const temporary = writeTemporary(dir, id, bytes);
  try {
    try {
      const info = lstatSync(path);
      if (!info.isFile()) {
        throw new ExportError("output-exists");
      }
      unlinkSync(path);
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") {
        throw error;
      }
    }
    linkSync(temporary, path);
  } finally {
    unlinkSync(temporary);
  }
}

/**
 * Whether the original of an entry is on disk with its recorded digest.
 * @param {string} dir
 * @param {string} id
 * @param {ImageEntry | undefined} entry
 */
function verified(dir, id, entry) {
  if (entry?.state !== "ok") {
    return false;
  }
  try {
    const path = join(dir, id);
    return lstatSync(path).isFile() && sha256Of(readFileSync(path)) === entry.sha256;
  } catch {
    return false;
  }
}

/**
 * The body, or null when it is larger than the limit (read no further than one byte past it).
 * @param {Response} response
 * @param {number} limit
 */
async function readCapped(response, limit) {
  const declared = Number(response.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel();
    return null;
  }
  if (response.body === null) {
    return new Uint8Array();
  }
  const reader = response.body.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

/**
 * Checks downloaded bytes as Kopje checks an upload: an accepted type by signature, within the size and pixel limits,
 * with readable dimensions.
 * @param {Uint8Array} bytes
 * @returns {{ ok: true, type: string, width: number, height: number } | { ok: false, reason: MissingReason }}
 */
export function checkImage(bytes) {
  if (bytes.byteLength > IMAGE_SIZE_LIMIT) {
    return { ok: false, reason: "too-large" };
  }
  const type = sniffImageType(bytes);
  if (type === null) {
    return { ok: false, reason: "unsupported-type" };
  }
  const size = imageSize(bytes, type);
  if (size === null) {
    return { ok: false, reason: "unreadable" };
  }
  if (size.width * size.height > IMAGE_MATRIX_LIMIT) {
    return { ok: false, reason: "too-many-pixels" };
  }
  return { ok: true, type, ...size };
}

/**
 * @param {{ exportPath: string, accountHash: string, outDir: string, accountId?: string | undefined,
 *   token?: string | undefined,
 *   fetch: Fetch, progress?: (text: string) => void }} options
 * @returns {Promise<{ ok: boolean, report: Record<string, unknown> }>}
 */
export async function exportImages({ exportPath, accountHash, outDir, accountId, token, fetch, progress }) {
  if (!ACCOUNT_HASH.test(accountHash) || accountHash === UPSTREAM_ACCOUNT_HASH) {
    throw new ExportError("images-account-invalid");
  }
  if ((accountId === undefined) !== (token === undefined) || (accountId !== undefined && !ACCOUNT_ID.test(accountId))) {
    throw new ExportError("images-api-incomplete");
  }
  const files = exportFiles(exportPath);
  checkSizes(files);
  const { db } = loadLegacyExport({
    texts: files.map((file) => () => readFileSync(file, "utf8")),
    acceptDeletions: true,
  });
  let domain;
  let collected;
  try {
    domain = localDomain(db);
    collected = collectImageIds(db, accountHash);
  } finally {
    db.close();
  }

  ensureDirectory(outDir);
  const originals = join(outDir, ORIGINALS_DIR);
  const previous = readImagesFile(outDir);
  // A rerun continues the same instance's images; anything else would mix two instances' files and tokens.
  if (previous !== null && (previous.accountHash !== accountHash || previous.domain !== domain)) {
    throw new ExportError("images-file-differs");
  }
  ensureDirectory(originals);
  /** @type {Map<string, ImageEntry>} */
  const images = new Map(previous?.images ?? []);
  const save = () => {
    const sorted = Object.fromEntries([...images].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    const text = `${JSON.stringify({ format: IMAGES_FORMAT, accountHash, domain, images: sorted }, null, 2)}\n`;
    renameSync(writeTemporary(outDir, IMAGES_FILE, text), join(outDir, IMAGES_FILE));
  };

  const from = token === undefined ? "delivery" : "api";
  const counts = { images: collected.ids.size, kept: 0, downloaded: 0 };
  /** @type {Record<MissingReason, number>} */
  const missing = { "not-found": 0, "unsupported-type": 0, "too-large": 0, "too-many-pixels": 0, unreadable: 0 };
  let done = 0;
  let unsaved = 0;
  try {
    for (const [id, variant] of collected.ids) {
      done++;
      const before = images.get(id);
      if (verified(originals, id, before)) {
        counts.kept++;
        continue;
      }
      progress?.(`images ${done}/${collected.ids.size}`);
      const url =
        token === undefined
          ? `${DELIVERY_PREFIX}${accountHash}/${id}/${variant}`
          : `https://api.cloudflare.com/client/v4/accounts/${accountId}/images/v1/${id}/blob`;
      const response = await fetch(url, {
        // The API token goes to the API only, and never follows a redirect elsewhere. A delivery URL is asked for
        // any type: Images converts to WebP or AVIF only for a client that names them, so the variant keeps the
        // stored format instead of being re-encoded lossily.
        headers: token === undefined ? { accept: "*/*" } : { authorization: `Bearer ${token}` },
        redirect: token === undefined ? "follow" : "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      // Made once per image and kept through every state, so a recovered image gets the URLs it had.
      const secret = before?.secret ?? imageSecret();
      /** @type {ImageEntry} */
      let entry;
      if (response.status === 404) {
        await response.body?.cancel();
        entry = { state: "missing", secret, reason: "not-found" };
      } else if (!response.ok) {
        await response.body?.cancel();
        throw new ExportError("images-fetch-failed", { status: response.status, from });
      } else {
        const bytes = await readCapped(response, IMAGE_SIZE_LIMIT);
        const checked = bytes === null ? null : checkImage(bytes);
        if (bytes === null || checked === null || !checked.ok) {
          entry = { state: "missing", secret, reason: checked?.ok === false ? checked.reason : "too-large" };
        } else {
          writeOriginal(originals, id, bytes);
          entry = {
            state: "ok",
            sha256: sha256Of(bytes),
            type: checked.type,
            width: checked.width,
            height: checked.height,
            bytes: bytes.byteLength,
            secret,
            from,
          };
          counts.downloaded++;
        }
      }
      images.set(id, entry);
      if (++unsaved >= SAVE_EVERY) {
        save();
        unsaved = 0;
      }
    }
  } finally {
    save();
  }
  for (const id of collected.ids.keys()) {
    const entry = images.get(id);
    if (entry?.state === "missing") {
      missing[entry.reason]++;
    }
  }
  const missingTotal = Object.values(missing).reduce((a, b) => a + b, 0);
  const report = {
    ...counts,
    from,
    missing: { total: missingTotal, ...missing },
    malformedUrls: collected.malformed,
  };
  return { ok: missingTotal === 0 && collected.malformed === 0, report };
}
