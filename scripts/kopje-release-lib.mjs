// The steps of a kopje release that decide what happens to npm, GitHub and the repository, kept apart from the
// commands they run so that scripts/kopje-release-lib.test.mjs can check them offline with stubbed npm and gh.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, resolve } from "node:path";

export const REGISTRY = "https://registry.npmjs.org/";

/**
 * @typedef {{ code: number, stdout: string, stderr: string }} Ran
 * @typedef {(args: string[]) => Ran} Run
 */

// Runs a command and returns its exit code and output, never throwing on a non-zero exit. With a timeout (ms), a
// command still running then is killed and throws.
/**
 * @param {string} command
 * @param {{ timeout?: number }} [options]
 * @returns {Run}
 */
export function runCommand(command, { timeout } = {}) {
  return (args) => {
    const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout });
    if (result.error !== undefined) {
      throw result.error;
    }
    return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
  };
}

// How `npm publish <argument>` reads its argument, by npm's own spec parser (npm-package-arg, shipped inside npm).
/**
 * @param {string} argument
 * @returns {string}
 */
export function npmSpecType(argument) {
  const npmRoot = execFileSync("npm", ["root", "--global"], { encoding: "utf8" }).trim();
  const npa = /** @type {(spec: string) => { type: string }} */ (
    createRequire(join(npmRoot, "npm", "package.json"))("npm-package-arg")
  );
  return npa(argument).type;
}

// Runs fn with packages/kopje/package.json (or any manifest) set to the version, and restores the file byte for byte
// afterwards, whether fn returns or throws.
/**
 * @template T
 * @param {string} manifestPath
 * @param {string} version
 * @param {() => T} fn
 * @returns {T}
 */
export function withManifestVersion(manifestPath, version, fn) {
  const original = readFileSync(manifestPath, "utf8");
  try {
    const manifest = /** @type {Record<string, unknown>} */ (JSON.parse(original));
    if (manifest.version !== version) {
      writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, version }, null, "\t")}\n`);
    }
    return fn();
  } finally {
    writeFileSync(manifestPath, original);
  }
}

// Publishes a checked tarball once, and is safe to run again:
//   - the tarball goes to npm as an absolute path that npm's parser reads as a local file (a bare relative path such as
//     package/kopje-1.0.0.tgz would be read as a GitHub repository);
//   - a version not on npm is published;
//   - a version on npm with the tarball's integrity is not published again ('skipped'), so a run that published and
//     then failed can be rerun;
//   - a version on npm with another integrity, or a lookup that fails for another reason, publishes nothing and throws.
/**
 * @param {{
 *   tarball: string, tag: string, dryRun?: boolean, npm?: Run, specType?: (argument: string) => string,
 *   log?: (message: string) => void,
 * }} options
 */
export function publish({
  tarball: given,
  tag,
  dryRun = false,
  npm = runCommand("npm"),
  specType = npmSpecType,
  log = console.log,
}) {
  const tarball = resolve(given);
  if (!existsSync(tarball)) {
    throw new Error(`${tarball} does not exist`);
  }
  const type = specType(tarball);
  if (!isAbsolute(tarball) || type !== "file") {
    throw new Error(`npm reads ${tarball} as a ${type} spec, not a local file`);
  }
  const manifest = /** @type {{ name: string, version: string }} */ (
    JSON.parse(execFileSync("tar", ["-xzOf", tarball, "package/package.json"], { encoding: "utf8" }))
  );
  const id = `${manifest.name}@${manifest.version}`;
  const integrity = `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`;

  const published = publishedIntegrity(npm, id);
  if (published === integrity) {
    log(`${id} is already on npm with this tarball's integrity; nothing to publish`);
    return "skipped";
  }
  if (published !== null) {
    throw new Error(
      `${id} is already on npm with another tarball (${published}, this one ${integrity}). npm never replaces a ` +
        "published version: release a new version instead.",
    );
  }
  const args = ["publish", tarball, "--access", "public", "--provenance", "--tag", tag, "--registry", REGISTRY];
  if (dryRun) {
    log(`dry run: would publish ${id} (${integrity}): npm ${args.join(" ")}`);
    return "dry-run";
  }
  const result = npm(args);
  process.stderr.write(result.stderr);
  if (result.code !== 0) {
    throw new Error(`npm publish ${id} failed (exit ${result.code})`);
  }
  log(`published ${id} (${integrity})`);
  return "published";
}

// The integrity npm has for the version, or null when npm has no such version.
/**
 * @param {Run} npm
 * @param {string} id
 * @returns {string | null}
 */
function publishedIntegrity(npm, id) {
  const { code, stdout, stderr } = npm(["view", id, "dist.integrity", "--json", "--registry", REGISTRY]);
  const output = stdout.trim();
  /** @type {unknown} */
  let parsed;
  try {
    parsed = output === "" ? null : JSON.parse(output);
  } catch {
    throw new Error(`npm view ${id} printed something unexpected; publishing nothing: ${output.slice(0, 200)}`);
  }
  if (code !== 0) {
    if (/** @type {{ error?: { code?: unknown } } | null} */ (parsed)?.error?.code === "E404") {
      return null;
    }
    throw new Error(`npm view ${id} failed (exit ${code}); publishing nothing: ${stderr.slice(0, 500)}`);
  }
  // Some npm versions answer a missing version with nothing at all.
  if (parsed === null) {
    return null;
  }
  if (typeof parsed !== "string" || !parsed.startsWith("sha512-")) {
    throw new Error(`npm view ${id} returned no sha512 integrity: ${output.slice(0, 200)}`);
  }
  return parsed;
}

// Leads every release's notes. Dependabot shows a release's notes in the body of the pull request that updates an
// instance to it (the template's .github/dependabot.yml), and has no setting of its own for such a warning.
export const UPGRADE_NOTE =
  "Updating an instance to this version deploys it when the update is merged, and the Store may upgrade its schema. " +
  "Before merging, read these notes and " +
  "[upgrade.md](https://github.com/shuymn/kopje/blob/main/packages/kopje/docs/upgrade.md).";

// Creates the GitHub release for the tag, unless it exists: a rerun after the release was made leaves it as it is.
// Any answer from `gh release view` other than "found" or "not found" throws without creating anything. The notes are
// UPGRADE_NOTE followed by the notes file.
/**
 * @param {{
 *   repo: string, tag: string, version: string, prerelease: boolean, notesFile: string, tarball: string,
 *   gh?: Run, log?: (message: string) => void,
 * }} options
 */
export function createRelease({
  repo,
  tag,
  version,
  prerelease,
  notesFile,
  tarball,
  gh = runCommand("gh"),
  log = console.log,
}) {
  const view = gh(["release", "view", tag, "--repo", repo, "--json", "tagName"]);
  if (view.code === 0) {
    log(`the release ${tag} exists already; leaving it as it is`);
    return "exists";
  }
  if (!/release not found/i.test(view.stderr)) {
    throw new Error(`gh release view ${tag} failed (exit ${view.code}): ${view.stderr.slice(0, 500)}`);
  }
  const args = ["release", "create", tag, "--repo", repo, "--verify-tag", "--title", `Kopje ${version}`];
  args.push("--notes", `${UPGRADE_NOTE}\n\n${readFileSync(notesFile, "utf8")}`);
  if (prerelease) {
    args.push("--prerelease");
  }
  args.push(tarball);
  const created = gh(args);
  process.stderr.write(created.stderr);
  if (created.code !== 0) {
    throw new Error(`gh release create ${tag} failed (exit ${created.code})`);
  }
  log(`created the release ${tag}`);
  return "created";
}

const MINUTE = 60_000;

// Whether CI (ci.yml) passed on the commit as a push to main. Such a run compares the commit
// with the last main run that passed and runs the lint, type and test checks the difference can affect, so its
// success means the commit's whole tree passed them, through the runs before it. While a run is queued or in progress
// it waits, up to `wait` from the start; while no run is listed, up to `appear` (a tag pushed right after the merge
// may come before the run). Every other answer, a failed or cancelled run, no run, a wait that ran out, or gh
// failing, stalling (a minute a call) or answering something else, is false: the caller then runs those checks itself.
/**
 * A run as the GitHub API lists it (only its being an object is checked).
 * @typedef {{ head_sha: string, status: string, conclusion: string | null, html_url: string }} WorkflowRun
 */
/**
 * @param {{
 *   repo: string, sha: string, gh?: Run, sleep?: (ms: number) => Promise<unknown>, now?: () => number,
 *   log?: (message: string) => void, wait?: number, appear?: number, interval?: number,
 * }} options
 */
export async function mainChecked({
  repo,
  sha,
  gh = runCommand("gh", { timeout: MINUTE }),
  sleep = (/** @type {number} */ ms) => new Promise((done) => setTimeout(done, ms)),
  now = Date.now,
  log = console.log,
  wait = 20 * MINUTE,
  appear = 2 * MINUTE,
  interval = 30_000,
}) {
  const start = now();
  const path = `repos/${repo}/actions/workflows/ci.yml/runs`;
  for (;;) {
    /** @type {WorkflowRun[]} */
    let runs;
    try {
      const answer = gh(["api", "-X", "GET", path, "-f", `head_sha=${sha}`, "-f", "event=push", "-f", "branch=main"]);
      if (answer.code !== 0) {
        throw new Error(`exit ${answer.code}: ${answer.stderr.slice(0, 500)}`);
      }
      const listed = /** @type {{ workflow_runs?: unknown }} */ (JSON.parse(answer.stdout)).workflow_runs;
      if (!Array.isArray(listed) || !listed.every((run) => typeof run === "object" && run !== null)) {
        throw new Error(`unexpected answer: ${answer.stdout.slice(0, 200)}`);
      }
      runs = /** @type {WorkflowRun[]} */ (listed);
    } catch (error) {
      log(`could not list the main runs of ${sha}: ${/** @type {Error} */ (error).message}`);
      return false;
    }
    const passed = runs.find(
      (run) => run.head_sha === sha && run.status === "completed" && run.conclusion === "success",
    );
    if (passed !== undefined) {
      log(`${passed.html_url} passed on ${sha}`);
      return true;
    }
    const pending = runs.filter((run) => run.status !== "completed");
    const elapsed = now() - start;
    if (runs.length > 0 && pending.length === 0) {
      log(`no main run passed on ${sha}: ${runs.map((run) => `${run.html_url} ${run.conclusion}`).join(", ")}`);
      return false;
    }
    if (runs.length === 0 && elapsed >= appear) {
      log(`no main run of ci.yml is listed for ${sha}`);
      return false;
    }
    if (elapsed >= wait) {
      log(`the main run on ${sha} did not finish in ${wait / MINUTE} minutes`);
      return false;
    }
    log(runs.length === 0 ? `waiting for a main run on ${sha}` : `waiting for ${pending[0]?.html_url}`);
    await sleep(interval);
  }
}
