// Checks the kopje npm package the way an instance uses it:
//   1. builds the package (packages/kopje/scripts/build-package.mjs) and packs it with npm, as the release does;
//   2. checks the packed manifest and files: no runtime dependencies, the bin, exports and types exist, the notices
//      (with blurhash's license text, and without the WebP codec's) and the source map (with its sources) are present,
//      and no sources are shipped;
//   3. installs the tarball into a copy of the deploy/ template (the package has no dependencies, so installing it is
//      unpacking it into node_modules/kopje), dry-runs the template's `wrangler deploy`, and compares it with the
//      in-repo build: under 1.5 MiB gzipped, within 1% of each other, the same assets by content, and the same runtime
//      settings and bindings as packages/kopje/wrangler.jsonc; neither bundle imports or carries a wasm module (the
//      Worker decodes no image: packages/kopje/docs/threat-model.md NET-3);
//   4. runs the template in workerd (wrangler's test harness): the Store starts and applies its migrations, a fetch,
//      an asset, the scheduled and queue handlers, and the packaged version as the Store reports it;
//   5. installs the tarball with npm into an empty project: `kopje-admin --help` runs from the installed bin, and the
//      types check in a small consumer;
//   6. runs the cutover tools from that install on a synthetic legacy export: convert, verify-conversion, fingerprint
//      export and maintenance-worker (which needs the maintenance bundles in dist/).
//
//   node scripts/check-kopje-package.mjs [--out <dir>] [--version <semver>]
//     --out      keeps the tarball in <dir> (the release publishes it)
//     --version  the version to pack; packages/kopje/package.json is restored afterwards. Without it, the version in
//                package.json, or 0.0.1-check while that is the repository's 0.0.0, so the check always proves that a
//                real version reaches the bundle.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { createTestHarness, experimental_readRawConfig as readRawConfig } from "wrangler";

import { withManifestVersion } from "./kopje-release-lib.mjs";

// The gzipped bundle's budget. Kopje needs the Workers Paid plan, whose limit is 10 MiB; this budget only catches
// accidental growth (a new dependency, an inlined asset), so it is raised deliberately as features add code.
const LIMIT_KIB = 1536;
const TOLERANCE = 0.01;
const UNVERSIONED = "0.0.0";
const CHECK_VERSION = "0.0.1-check";

const repo = fileURLToPath(new URL("..", import.meta.url));
const pkg = join(repo, "packages", "kopje");
const template = join(repo, "deploy");
const bin = join(repo, "node_modules", ".bin");
const wrangler = join(bin, "wrangler");
const { values } = parseArgs({ options: { out: { type: "string" }, version: { type: "string" } } });

const manifestPath = join(pkg, "package.json");
const current = JSON.parse(readFileSync(manifestPath, "utf8")).version;
const version = values.version ?? (current === UNVERSIONED ? CHECK_VERSION : current);

const work = mkdtempSync(join(tmpdir(), "kopje-package-"));
const failures = [];
const fail = (message) => failures.push(message);
try {
  // 1. Build and pack, with the version set for this check only. The published stylesheets must be what the asset
  // build writes (packages/kopje/scripts/build-assets.mjs); packing skips prepack, so the check runs here.
  run("node", [join(pkg, "scripts", "build-assets.mjs"), "--check"], pkg);
  const out = resolve(values.out ?? join(work, "pack"));
  const { repoKiB, packed } = withManifestVersion(manifestPath, version, () => {
    const kib = gzipKiB(
      run("node", [join(pkg, "scripts", "build-package.mjs")], pkg, {
        env: { PATH: `${bin}${delimiter}${process.env.PATH}` },
      }),
    );
    mkdirSync(out, { recursive: true });
    // dist/ was just built; --ignore-scripts keeps npm from building it a second time (prepack).
    const [result] = JSON.parse(
      run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", out, "--loglevel", "warn"], pkg, {
        quiet: true,
      }),
    );
    return { repoKiB: kib, packed: result };
  });
  const tarball = join(out, packed.filename);
  console.log(`packed ${packed.filename}: ${packed.entryCount} files, ${(packed.size / 1024).toFixed(1)} KiB`);

  // 2. The packed package.
  const unpacked = join(work, "unpacked");
  extract(tarball, unpacked);
  checkPackage(unpacked);

  // 3. The template, against the tarball.
  const app = join(work, "template");
  cpSync(template, app, {
    recursive: true,
    filter: (path) => !/[\\/](node_modules|public|\.wrangler)$/.test(path),
  });
  extract(tarball, join(app, "node_modules", "kopje"));
  const templateDist = join(work, "template-dist");
  const templateKiB = gzipKiB(run(wrangler, ["deploy", "--dry-run", "--outdir", templateDist], app));
  console.log(`gzip: in-repo ${repoKiB} KiB, template ${templateKiB} KiB`);
  for (const [what, kib] of [
    ["in-repo", repoKiB],
    ["template", templateKiB],
  ]) {
    if (kib > LIMIT_KIB) {
      fail(`the ${what} bundle is ${kib} KiB gzipped, over ${LIMIT_KIB} KiB`);
    }
  }
  if (Math.abs(templateKiB - repoKiB) > repoKiB * TOLERANCE) {
    fail(`the template's bundle (${templateKiB} KiB) differs from the in-repo build (${repoKiB} KiB)`);
  }
  checkSourceMap(join(templateDist, "index.js"), "the template bundle");
  checkNoWasm(templateDist, "index.js", "the template bundle");
  const assets = hashes(join(app, "public"));
  const shipped = hashes(join(pkg, "public"));
  if (JSON.stringify(assets) !== JSON.stringify(shipped)) {
    fail(`the template's public/ is not the package's: ${JSON.stringify(assets)} vs ${JSON.stringify(shipped)}`);
  }
  compareConfigs();
  const ours = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).devDependencies.wrangler;
  const theirs = JSON.parse(readFileSync(join(template, "package.json"), "utf8")).devDependencies.wrangler;
  if (ours !== theirs) {
    fail(`deploy/package.json pins wrangler ${theirs}, the repository ${ours}: update them together`);
  }

  // 4. The template, running.
  await smoke(app, shipped);

  // 5. An npm install of the tarball.
  checkInstall(tarball, join(work, "consumer"));
  checkAdminScript(app, join(work, "without-install"));

  // 6. The cutover tools, from the install.
  await checkCutover(join(work, "consumer"), join(work, "cutover"));
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `check-kopje-package: ${failure}`).join("\n"));
  process.exit(1);
}
console.log(`check-kopje-package: ok (kopje ${version})`);

function checkPackage(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  if (manifest.version !== version) {
    fail(`the packed version is ${manifest.version}, expected ${version}`);
  }
  if (version === UNVERSIONED) {
    fail(`a package is never packed as ${UNVERSIONED}, the repository's placeholder`);
  }
  for (const field of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "bundleDependencies",
    "bundledDependencies",
  ]) {
    if (manifest[field] !== undefined && Object.keys(manifest[field]).length > 0) {
      fail(`the packed manifest has ${field}; the bundle must carry everything it needs`);
    }
  }
  if (manifest.scripts?.install !== undefined || manifest.scripts?.postinstall !== undefined) {
    fail("the packed manifest has install scripts");
  }
  const targets = [
    ...Object.values(manifest.bin ?? {}),
    manifest.types,
    ...Object.values(manifest.exports).flatMap((target) =>
      typeof target === "string" ? [target] : Object.values(target),
    ),
  ].filter((target) => !target.includes("*"));
  for (const target of targets) {
    if (!existsSync(join(dir, target))) {
      fail(`the packed manifest names ${target}, which is not in the package`);
    }
  }
  const files = readdirSync(dir, { recursive: true }).map((file) => file.split("\\").join("/"));
  const shippedSources = files.filter((file) => /^(src|test|test-node|stubs|scripts)\//.test(file));
  if (shippedSources.length > 0) {
    fail(`the package ships sources: ${shippedSources}`);
  }
  for (const required of [
    "LICENSE",
    "NOTICE",
    "README.md",
    "CHANGELOG.md",
    "docs/observability.md",
    "dist/worker.js.map",
    "types/index.d.ts",
  ]) {
    if (!files.includes(required)) {
      fail(`the package lacks ${required}`);
    }
  }
  // The full Apache-2.0 terms, and the attribution Apache-2.0 §4 keeps for Wildebeest's material.
  const license = files.includes("LICENSE") ? readFileSync(join(dir, "LICENSE"), "utf8") : "";
  if (
    !license.includes("TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION") ||
    !license.includes("9. Accepting Warranty or Additional Liability.")
  ) {
    fail("the package LICENSE is not the full Apache-2.0 text");
  }
  const notice = files.includes("NOTICE") ? readFileSync(join(dir, "NOTICE"), "utf8") : "";
  if (!notice.includes("Copyright (c) Kopje contributors") || !notice.includes("Copyright (c) 2023 Cloudflare, Inc.")) {
    fail("the package NOTICE lacks the Kopje contributors or the Wildebeest attribution");
  }
  const notices = join(dir, "dist", "THIRD_PARTY_NOTICES.md");
  if (!existsSync(notices) || !readFileSync(notices, "utf8").includes("\n## ")) {
    fail("the package lacks dist/THIRD_PARTY_NOTICES.md or it lists no package");
  } else {
    // blurhash's license text, which its package does not ship (packages/kopje/scripts/build-package.mjs); no WebP
    // codec's, as nothing of @jsquash/webp (a devDependency for test fixtures) is bundled.
    const text = readFileSync(notices, "utf8");
    if (!text.includes("Copyright (c) 2018 Wolt Enterprises")) {
      fail("dist/THIRD_PARTY_NOTICES.md lacks the license text of blurhash");
    }
    if (text.includes("Copyright (c) 2010, Google Inc. All rights reserved.") || text.includes("@jsquash/webp")) {
      fail("dist/THIRD_PARTY_NOTICES.md carries the WebP codec, which the Worker must not bundle");
    }
  }
  checkSourceMap(join(dir, "dist", "worker.js"), "the packed bundle");
  checkNoWasm(join(dir, "dist"), "worker.js", "the packed bundle");
}

// The bundle imports no wasm module and none sits beside the script: wrangler would emit a CompiledWasm import as a
// file of its own.
function checkNoWasm(dir, script, what) {
  const modules = readdirSync(dir).filter((file) => file.endsWith(".wasm"));
  const imported = [...readFileSync(join(dir, script), "utf8").matchAll(/["']([^"'\n]*\.wasm)["']/g)].map(
    ([, file]) => file,
  );
  if (modules.length > 0 || imported.length > 0) {
    fail(`${what} must carry no wasm module: files ${modules}, imports ${imported}`);
  }
}

// The bundle links its map, and the map carries the original sources, so stack traces in Workers Logs point at them.
function checkSourceMap(script, what) {
  const name = `${script.split(/[\\/]/).at(-1)}.map`;
  if (!readFileSync(script, "utf8").trimEnd().endsWith(`//# sourceMappingURL=${name}`)) {
    fail(`${what} does not link ${name}`);
    return;
  }
  const map = JSON.parse(readFileSync(`${script}.map`, "utf8"));
  const entry = map.sources?.findIndex((source) => source.endsWith("src/worker.ts")) ?? -1;
  if (entry === -1 || typeof map.sourcesContent?.[entry] !== "string" || map.sourcesContent[entry] === "") {
    fail(`${what}'s source map lacks src/worker.ts with its content`);
  }
}

async function smoke(app, assets) {
  // wrangler runs the template's build command (the asset copy) in the current directory.
  const cwd = process.cwd();
  process.chdir(app);
  const server = createTestHarness({ root: app, workers: [{ configPath: "./wrangler.jsonc" }] });
  try {
    await server.listen();
    const worker = server.getWorker();
    const env = await worker.getEnv();

    // The first call schedules the upgrade in the Store's alarm; it applies the migrations right after.
    const store = env.STORE.getByName("store");
    const readHealth = async () => JSON.parse(JSON.stringify(await store.health("smoke")));
    let health = await readHealth();
    for (const until = Date.now() + 15_000; health.schema?.status === "pending" && Date.now() < until;) {
      await sleep(200);
      health = await readHealth();
    }
    const applied = health.schema?.applied ?? [];
    if (health.schema?.status !== "current" || applied.length === 0 || !applied.includes("0000_initial")) {
      fail(`the Store did not apply its migrations: ${JSON.stringify(health.schema)}`);
    }
    const reported = JSON.parse(JSON.stringify(await store.version("smoke")));
    if (reported.version !== version) {
      fail(`the running Store reports version ${reported.version}, expected ${version}`);
    }

    const instance = await server.fetch("/api/v1/instance");
    const body = await instance.text();
    if (instance.status !== 200 || typeof JSON.parse(body).title !== "string") {
      fail(`GET /api/v1/instance answered ${instance.status}: ${body.slice(0, 200)}`);
    }

    const [asset, digest] = Object.entries(assets).find(([path]) => path.endsWith(".css")) ?? [];
    const served = await server.fetch(`/${asset}`);
    const bytes = Buffer.from(await served.arrayBuffer());
    if (served.status !== 200 || sha256(bytes) !== digest) {
      fail(`GET /${asset} answered ${served.status} with other bytes than the package's`);
    }

    const scheduled = await worker.scheduled({ cron: "*/5 * * * *", scheduledTime: new Date() });
    if (scheduled.outcome !== "ok") {
      fail(`the scheduled handler ended ${scheduled.outcome}`);
    }

    // The queue handler logs a message it does not know; seeing that log proves the bundle's handler consumed it.
    await env.QUEUE.send({ kind: "kopje-package-smoke" });
    const deadline = Date.now() + 15_000;
    const consumed = () => server.getLogs().some((log) => JSON.stringify(log).includes("kopje.queue.unknown"));
    while (!consumed() && Date.now() < deadline) {
      await sleep(200);
    }
    if (!consumed()) {
      fail("the queue handler did not consume a message within 15 s");
    }
    console.log(`smoke: Store migrated (${applied}), version ${reported.version}, fetch, asset, scheduled, queue`);
  } finally {
    await server.close();
    process.chdir(cwd);
  }
}

// `npm run admin` in an instance's repository runs the installed kopje's CLI, and nothing else: without the install it
// fails even when another kopje-admin is on PATH.
function checkAdminScript(app, bare) {
  const help = run("npm", ["run", "--silent", "admin", "--", "--help"], app, { quiet: true });
  if (!help.includes("Usage: kopje-admin")) {
    fail("`npm run admin -- --help` in the template did not print the CLI usage");
  }
  mkdirSync(bare, { recursive: true });
  cpSync(join(template, "package.json"), join(bare, "package.json"));
  const impostor = join(bare, "impostor-bin");
  mkdirSync(impostor);
  writeFileSync(join(impostor, "kopje-admin"), "#!/bin/sh\necho IMPOSTOR\n", { mode: 0o755 });
  let output = "";
  try {
    output = execFileSync("npm", ["run", "--silent", "admin", "--", "--help"], {
      cwd: bare,
      env: { ...process.env, PATH: `${impostor}${delimiter}${process.env.PATH}` },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return;
  }
  fail(`\`npm run admin\` without the install did not fail; it printed: ${output.slice(0, 200)}`);
}

function checkInstall(tarball, dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "consumer", private: true, type: "module" }));
  run("npm", ["install", "--no-audit", "--no-fund", "--offline", "--loglevel", "warn", tarball], dir, { quiet: true });
  // The named-package form docs/setup.md gives for anywhere outside an instance's repository (the tarball stands in
  // for kopje@<version>); the template's `npm run admin` is checked in checkAdminScript.
  const elsewhere = join(dir, "..", "elsewhere");
  mkdirSync(elsewhere, { recursive: true });
  for (const [what, command, args, cwd] of [
    ["the installed bin", join(dir, "node_modules", ".bin", "kopje-admin"), ["--help"], dir],
    [
      "npm exec --package",
      "npm",
      ["exec", "--yes", "--offline", `--package=${tarball}`, "--", "kopje-admin", "--help"],
      elsewhere,
    ],
  ]) {
    const help = run(command, args, cwd, { quiet: true });
    if (!help.includes("Usage: kopje-admin")) {
      fail(`${what} did not print the CLI usage`);
    }
  }
  writeFileSync(
    join(dir, "index.ts"),
    [
      "import worker, { Store, type KopjeWorker } from 'kopje'",
      "export { default, Store } from 'kopje'",
      "const handlers: KopjeWorker = worker",
      "export const store: Store = new Store({}, {})",
      "export const fetchHandler: (request: Request, env: unknown, ctx: unknown) => unknown = handlers.fetch",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "es2024",
        lib: ["es2024", "dom"],
        module: "es2022",
        moduleResolution: "bundler",
        types: [],
        strict: true,
        noEmit: true,
      },
      files: ["index.ts"],
    }),
  );
  run(join(bin, "tsc"), ["-p", dir], dir);
}

// The cutover tools ship as CLI modules that run Kopje's code from dist/ (the package has no sources). A synthetic
// legacy export (packages/kopje/test-node/legacy-fixture.ts) is converted, checked, fingerprinted and turned into a
// maintenance worker by the installed CLI.
async function checkCutover(installed, dir) {
  const { buildLegacyFixture } = await import(pathToFileURL(join(pkg, "test-node", "legacy-fixture.ts")).href);
  const fixture = await buildLegacyFixture({ level: 39, notificationSequence: 12n });
  const exportDir = join(dir, "export");
  mkdirSync(exportDir, { recursive: true });
  for (const [table, text] of fixture.texts) {
    writeFileSync(join(exportDir, `${table}.sql`), text);
  }
  const cli = join(installed, "node_modules", ".bin", "kopje-admin");
  const steps = [
    ["convert", exportDir, "--out", join(dir, "out"), "--base-time", "2026-10-20T00:00:00Z"],
    ["verify-conversion", exportDir, join(dir, "out", "kopje.dump")],
    ["fingerprint", "export", exportDir],
    ["maintenance-worker", exportDir, "--domain", "kopje.test", "--out", join(dir, "pages")],
  ];
  for (const args of steps) {
    try {
      execFileSync(cli, args, { cwd: installed, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      fail(`the installed \`kopje-admin ${args[0]}\` failed: ${String(error.stderr ?? error.message).slice(0, 300)}`);
    }
  }
  if (!existsSync(join(dir, "pages", "_worker.js"))) {
    fail("the installed `kopje-admin maintenance-worker` wrote no _worker.js");
  }
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

function extract(tarball, dir) {
  mkdirSync(dir, { recursive: true });
  run("tar", ["-xzf", tarball, "-C", dir, "--strip-components", "1"], dir);
}

function hashes(dir) {
  const files = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
  return Object.fromEntries(
    files
      .map((file) => [relative(dir, file).split("\\").join("/"), sha256(readFileSync(file))])
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function run(command, args, cwd, { env = {}, quiet = false } = {}) {
  const output = execFileSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (!quiet) {
    process.stderr.write(output);
  }
  return output;
}

function gzipKiB(output) {
  const match = /gzip: ([0-9.]+) KiB/.exec(output);
  if (match === null) {
    throw new Error("no gzip size in the wrangler output");
  }
  return Number(match[1]);
}

// The template may name its Worker and resources as it likes, but everything the code depends on must be as in the
// package's own config.
function compareConfigs() {
  const read = (dir) => readRawConfig({ config: join(dir, "wrangler.jsonc") }).rawConfig;
  const source = read(pkg);
  const target = read(template);
  const queues = new Set(
    [...(target.queues?.producers ?? []), ...(target.queues?.consumers ?? [])].map((q) => q.queue),
  );
  if (queues.size !== 1) {
    fail(`deploy/wrangler.jsonc must produce to and consume one queue, not ${[...queues]}`);
  }
  if (!target.queues?.consumers?.every((consumer) => typeof consumer.dead_letter_queue === "string")) {
    fail("deploy/wrangler.jsonc must give its Queue consumer a dead_letter_queue");
  }
  if (target.keep_names !== false) {
    fail("deploy/wrangler.jsonc must set keep_names to false: the kopje bundle already keeps the names");
  }
  const shape = (config) => ({
    compatibility_date: config.compatibility_date,
    compatibility_flags: config.compatibility_flags,
    minify: config.minify,
    upload_source_maps: config.upload_source_maps,
    observability: config.observability,
    keep_vars: config.keep_vars,
    version_metadata: config.version_metadata,
    durable_objects: config.durable_objects,
    migrations: config.migrations,
    queues: {
      producers: config.queues?.producers?.map(({ queue: _, ...rest }) => rest),
      // The dead-letter queue is named per instance; that there is one is the setting.
      consumers: config.queues?.consumers?.map(({ queue: _, dead_letter_queue: dlq, ...rest }) => ({
        ...rest,
        deadLetterQueue: dlq !== undefined,
      })),
    },
    ratelimits: config.ratelimits?.map(({ namespace_id: _, ...rest }) => rest),
    r2_buckets: config.r2_buckets?.map(({ bucket_name: _, ...rest }) => rest),
    images: config.images,
    assets: config.assets,
    triggers: config.triggers,
    rules: config.rules,
  });
  const expected = shape(source);
  const actual = shape(target);
  for (const key of Object.keys(expected)) {
    if (JSON.stringify(expected[key]) !== JSON.stringify(actual[key])) {
      fail(
        `deploy/wrangler.jsonc ${key} is ${JSON.stringify(actual[key])}, packages/kopje has ${JSON.stringify(expected[key])}`,
      );
    }
  }
}
