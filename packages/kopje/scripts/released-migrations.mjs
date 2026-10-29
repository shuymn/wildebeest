// Checks that no released migration has changed: every packages/kopje/migrations/*.sql file in the tree of any
// kopje-v* tag (release candidates included, reachable from HEAD or not) must be in the working tree, as a regular
// file in a real migrations/ directory, with the same bytes. The Store checksums the SQL text, so the bytes are
// compared raw: the blob from `git cat-file blob` (no attributes, no autocrlf) against the file as read.
//
//   node scripts/released-migrations.mjs [root]   root is the repository root, by default the one holding this file
//
// It assumes the tags are fetched (CI's check job fetches the whole history): a tag that is missing locally cannot be
// detected. The legacy v0.1.x tags hold a prototype from before the package was published and are not read.
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { gitEnv } from "./build-assets.mjs";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const TAGS = "kopje-v*";
export const MIGRATIONS = "packages/kopje/migrations/";
// The largest blob read, in bytes: well above the largest migration (under 100 KiB).
const MAX_BLOB_BYTES = 16 * 1024 * 1024;

/**
 * @typedef {{ problems: string[], tags: number, files: number }} Result files counts the distinct released paths
 */

/**
 * @overload
 * @param {string} root
 * @param {string[]} args
 * @returns {string}
 */
/**
 * @overload
 * @param {string} root
 * @param {string[]} args
 * @param {"buffer"} encoding
 * @returns {Buffer}
 */
/**
 * @param {string} root
 * @param {string[]} args
 * @param {"utf8" | "buffer"} encoding
 * @returns {string | Buffer}
 */
function git(root, args, encoding = "utf8") {
  return execFileSync("git", ["-C", root, ...args], {
    encoding,
    env: gitEnv(),
    maxBuffer: MAX_BLOB_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// Why the working-tree path cannot hold the released bytes, or null when it is a regular file under directories that
// are not symlinks (a symlink to identical bytes is a different blob).
/**
 * @param {string} root
 * @param {string} path
 * @returns {string | null}
 */
function notRegular(root, path) {
  const parts = path.split("/");
  for (let i = 1; i <= parts.length; i++) {
    let stat;
    try {
      stat = lstatSync(join(root, ...parts.slice(0, i)));
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") {
        return "missing";
      }
      throw error;
    }
    if (i < parts.length ? !stat.isDirectory() : !stat.isFile()) {
      return "not regular";
    }
  }
  return null;
}

/**
 * @param {string} [root] the repository root
 * @returns {Result}
 */
export function releasedMigrations(root = ROOT) {
  const tags = git(root, ["tag", "-l", "--no-column", TAGS])
    .split("\n")
    .filter((tag) => tag !== "");
  if (tags.length === 0) {
    throw new Error(`released-migrations: no ${TAGS} tag in ${root}; fetch the tags`);
  }
  // Each released path with its distinct blobs, and the first tag (in tag-name order) holding each.
  /** @type {Map<string, Map<string, string>>} */
  const released = new Map();
  for (const tag of tags) {
    const listing = git(root, ["ls-tree", "-r", "-z", "--full-tree", `refs/tags/${tag}`, "--", MIGRATIONS]);
    for (const entry of listing.split("\0")) {
      const tab = entry.indexOf("\t");
      const path = entry.slice(tab + 1);
      const [, type, id] = entry.slice(0, tab).split(" ");
      if (tab === -1 || type !== "blob" || id === undefined || !path.endsWith(".sql")) {
        continue;
      }
      const blobs = released.get(path) ?? new Map();
      if (!blobs.has(id)) {
        blobs.set(id, tag);
      }
      released.set(path, blobs);
    }
  }
  if (released.size === 0) {
    throw new Error(`released-migrations: the ${TAGS} tags hold no .sql file under ${MIGRATIONS} in ${root}`);
  }
  /** @type {string[]} */
  const problems = [];
  for (const [path, blobs] of [...released].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const [firstTag] = blobs.values();
    const state = notRegular(root, path);
    if (state === "missing") {
      problems.push(`${path} was released in ${firstTag} and is missing`);
      continue;
    }
    if (state === "not regular") {
      problems.push(`${path} is not a regular file`);
      continue;
    }
    const bytes = readFileSync(join(root, path));
    for (const [id, tag] of blobs) {
      if (!git(root, ["cat-file", "blob", id], "buffer").equals(bytes)) {
        problems.push(`${path} differs from ${tag}`);
        break;
      }
    }
  }
  return { problems, tags: tags.length, files: released.size };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { problems, tags, files } = releasedMigrations(process.argv[2] ?? ROOT);
    if (problems.length > 0) {
      for (const problem of problems) {
        console.error(`released-migrations: ${problem}`);
      }
      console.error("released-migrations: a released migration is never changed; add a new one instead");
      process.exit(1);
    }
    console.log(`released-migrations: ${files} released files from ${tags} tags are unchanged`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
