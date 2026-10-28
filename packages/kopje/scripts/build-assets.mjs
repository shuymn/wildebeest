// Publishes the web assets under fingerprinted names: the stylesheet minified from src/web/kopje.css and the L1 script
// bundle built from src/client/main.ts are written to public/assets/kopje.<hash>.css and kopje.<hash>.js, where <hash>
// is the first 10 hex characters of the SHA-256 of the bytes, and src/web/asset-versions.ts names those paths for the
// pages. public/_headers serves both as immutable.
//
// public/assets keeps, of each kind, the current file and the one the latest completed release linked, so a page
// cached before a deploy, or a rollback, still finds its files. That release is the nearest kopje-v* tag reachable
// from HEAD, leaving out the release being built (releasedAssets); its files are the paths in its tree's
// asset-versions.ts, or the kind's legacy path for a release before the kind was fingerprinted (/assets/kopje.css
// for the stylesheet; no script before the bundle). Every other file of the kinds is deleted.
//
//   node scripts/build-assets.mjs          writes the files (pnpm build runs it first)
//   node scripts/build-assets.mjs --check  writes nothing and fails when the files differ from what it would write
//                                          (prepack, test-node/stylesheet.test.ts and test-node/client-assets.test.ts)
//
// Without git history or release tags (a shallow clone), the release cannot be read: the build refuses, and --check
// trusts the PREVIOUS_* paths as recorded, with a warning, unless KOPJE_ASSETS_REQUIRE_TAGS=1 makes it refuse too (the
// CI job that packs the package and the release workflow check out the whole history).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildSync, transformSync } from "esbuild";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const ASSETS = "public/assets";
export const VERSIONS = "src/web/asset-versions.ts";
const TAGS = "kopje-v*";

// The bundle's build. Its bytes depend on the esbuild version, pinned in the workspace catalog.
export function bundle(root) {
  const result = buildSync({
    absWorkingDir: root,
    entryPoints: ["src/client/main.ts"],
    tsconfig: "src/client/tsconfig.json",
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    minify: true,
    sourcemap: false,
    legalComments: "none",
    charset: "utf8",
    write: false,
    logLevel: "silent",
  });
  return Buffer.from(result.outputFiles[0].contents);
}

// The served stylesheet: src/web/kopje.css with its comments and whitespace removed by the pinned esbuild. Only
// whitespace is minified: no syntax rewrites (esbuild's minifySyntax drops a nested selector's `&`, reorders selector
// lists and shortens values) and no target, so nothing is lowered; the browser job checks that Chromium parses the
// result to the same rules as the source. esbuild reports CSS it cannot parse as warnings, and such a source is refused
// rather than published in esbuild's recovered reading.
//
// esbuild drops a comment without leaving a separator (0.28.2: `mono/**/space` becomes `monospace`, `1/**/px`
// becomes `1px`), so a source is also refused when a comment could be the only thing between two tokens: neither the
// character before a run of comments nor the one after it is whitespace, a brace, a semicolon or the file's edge.
export function stylesheet(root) {
  const text = readFileSync(join(root, "src/web/kopje.css"), "utf8");
  const joining = joiningComment(text);
  if (joining !== null) {
    throw new Error(
      `build-assets: a comment in src/web/kopje.css is the only separator between two tokens (line ${joining}); ` +
        "put whitespace beside it",
    );
  }
  const result = transformSync(text, {
    loader: "css",
    sourcefile: "src/web/kopje.css",
    minifyWhitespace: true,
    sourcemap: false,
    legalComments: "none",
    charset: "utf8",
    logLevel: "silent",
  });
  if (result.warnings.length > 0) {
    const [first] = result.warnings;
    throw new Error(
      `build-assets: esbuild cannot read src/web/kopje.css: ${first.text} (line ${first.location?.line ?? "?"})`,
    );
  }
  return Buffer.from(result.code);
}

const SEPARATES = /[\s{};]/;

// The line of the first run of comments that may be the only separator between two tokens, or null. Strings and
// escapes are skipped, so a `/*` inside them is not a comment; an unterminated comment or string ends the scan (esbuild
// then warns).
export function joiningComment(text) {
  let at = 0;
  while (at < text.length) {
    const c = text[at];
    if (c === "\\") {
      at += 2;
    } else if (c === '"' || c === "'") {
      at++;
      while (at < text.length && text[at] !== c && text[at] !== "\n") {
        at += text[at] === "\\" ? 2 : 1;
      }
      at++;
    } else if (c === "/" && text[at + 1] === "*") {
      const start = at;
      while (text.startsWith("/*", at)) {
        const end = text.indexOf("*/", at + 2);
        if (end === -1) {
          return null;
        }
        at = end + 2;
      }
      const before = start === 0 ? " " : text[start - 1];
      const after = at >= text.length ? " " : text[at];
      if (!SEPARATES.test(before) && !SEPARATES.test(after)) {
        return text.slice(0, start).split("\n").length;
      }
    } else {
      at++;
    }
  }
  return null;
}

// The kinds of asset the build publishes. `constant` and `previous` name the versions module's exports, and `comment`
// is the current export's comment there; `legacy` is the path a release linked before the kind had a fingerprinted
// name (null: it had no such file); `owned` matches every file name of the kind the build manages.
export const KINDS = [
  {
    kind: "stylesheet",
    constant: "STYLESHEET",
    previous: "PREVIOUS_STYLESHEET",
    comment: ["// The stylesheet the pages link: its fingerprinted path, immutable (public/_headers)."],
    extension: "css",
    legacy: "/assets/kopje.css",
    owned: /^kopje(?:\.[0-9a-f]{10})?\.css$/,
    bytes: stylesheet,
  },
  {
    kind: "script",
    constant: "L1_SCRIPT",
    previous: "PREVIOUS_L1_SCRIPT",
    comment: [
      "// The L1 script bundle (docs/web-pages.md), which the pages that load it name in their CSP: its fingerprinted",
      "// path, immutable (public/_headers).",
    ],
    extension: "js",
    legacy: null,
    owned: /^kopje\.[0-9a-f]{10}\.js$/,
    bytes: bundle,
  },
];

export function fingerprint(bytes) {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 10);
}

// An export of the versions module: its quoted path, null, or undefined when the module has no such export. Either
// quote and an optional semicolon are read, so a module written in any formatter style parses, released tags included.
function field(text, name) {
  const match = new RegExp(`^export const ${name} = (?:'([^']*)'|"([^"]*)"|null);?$`, "m").exec(text);
  return match === null ? undefined : (match[1] ?? match[2] ?? null);
}

// The paths a versions module records, by kind: { current: { stylesheet, script }, previous: { … } }.
export function readVersions(text) {
  const read = (name) => {
    const value = field(text, name);
    if (value === undefined) {
      throw new Error(`${VERSIONS} has no ${name}`);
    }
    return value;
  };
  return {
    current: Object.fromEntries(KINDS.map((k) => [k.kind, read(k.constant)])),
    previous: Object.fromEntries(KINDS.map((k) => [k.kind, read(k.previous)])),
  };
}

const literal = (path) => (path === null ? "null" : `"${path}"`);

export function renderVersions({ current, previous }) {
  return [
    "// Written by scripts/build-assets.mjs from src/web/kopje.css and src/client/; never edited by hand.",
    ...KINDS.flatMap((k) => ["", ...k.comment, `export const ${k.constant} = ${literal(current[k.kind])};`]),
    "",
    "// The latest completed release's files, kept in public/assets for one release (null: that release had none).",
    ...KINDS.map((k) => `export const ${k.previous} = ${literal(previous[k.kind])};`),
    "",
  ].join("\n");
}

const basename = (path) => path.slice(path.lastIndexOf("/") + 1);

// The repository is located by `-C root` alone: variables that locate another one (a git hook exports GIT_DIR and
// GIT_INDEX_FILE; with GIT_DIR set, git takes the working directory as the top level and --show-prefix is wrong) are
// dropped. Configuration variables are kept.
const LOCATING = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_PREFIX",
];

export function gitEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !LOCATING.includes(name)));
}

function git(root, args, encoding = "utf8") {
  return execFileSync("git", ["-C", root, ...args], {
    encoding,
    env: gitEnv(),
    stdio: ["ignore", "pipe", "ignore"],
  });
}

// The files a release linked, by kind: the paths in its tree's versions module, or a kind's legacy path when the
// module or the kind's export is missing (a release before the kinds were fingerprinted, or before the kind).
function assetsAt(root, prefix, tag) {
  let text = "";
  try {
    text = git(root, ["show", `${tag}:${prefix}${VERSIONS}`]);
  } catch {
    // No versions module: every kind is legacy.
  }
  return Object.fromEntries(KINDS.map((k) => [k.kind, field(text, k.constant) ?? k.legacy]));
}

const samePaths = (a, b) => KINDS.every((k) => a[k.kind] === b[k.kind]);

// The latest completed release and its files, or null when git or the tags cannot tell (no repository, a shallow
// clone, no tag reachable). `current` holds the paths being built: a tag on HEAD whose release links exactly them is
// the release being built, and the one before it is the latest completed; a tag on HEAD with other assets on top is
// complete.
export function releasedAssets(root = ROOT, current = currentPaths(root)) {
  try {
    const prefix = git(root, ["rev-parse", "--show-prefix"]).trim();
    const describe = (exclude) =>
      git(root, [
        "describe",
        "--tags",
        "--abbrev=0",
        "--match",
        TAGS,
        ...exclude.flatMap((t) => ["--exclude", t]),
        "HEAD",
      ]).trim();
    let tag = describe([]);
    const building = git(root, ["tag", "--points-at", "HEAD", "--list", TAGS]).split("\n").filter(Boolean);
    if (building.includes(tag) && samePaths(assetsAt(root, prefix, tag), current)) {
      tag = describe(building);
    }
    return { tag, prefix, assets: assetsAt(root, prefix, tag) };
  } catch {
    return null;
  }
}

// The bytes of a released file: always the release's own, from its tag, so an edited or lost working copy is a drift
// that the build repairs. Only without tags (--check's fallback) are they the working copy's.
function releasedBytes(root, released, path) {
  const name = basename(path);
  if (released.tag === null) {
    return readFileSync(join(root, ASSETS, name));
  }
  return git(root, ["show", `${released.tag}:${released.prefix}${ASSETS}/${name}`], "buffer");
}

// The current bytes and fingerprinted path of each kind.
export function currentAssets(root = ROOT) {
  return Object.fromEntries(
    KINDS.map((k) => {
      const bytes = k.bytes(root);
      return [k.kind, { bytes, path: `/assets/kopje.${fingerprint(bytes)}.${k.extension}` }];
    }),
  );
}

const pathsOf = (assets) => Object.fromEntries(KINDS.map((k) => [k.kind, assets[k.kind].path]));

export function currentPaths(root = ROOT) {
  return pathsOf(currentAssets(root));
}

// What the build leaves on disk: the versions module's text and the asset files by name. `released` is
// releasedAssets()'s answer, or { tag: null, assets } as recorded when the tags are not available.
export function plan(root, released) {
  const assets = currentAssets(root);
  const current = pathsOf(assets);
  const files = new Map();
  for (const k of KINDS) {
    files.set(basename(current[k.kind]), assets[k.kind].bytes);
    const previous = released.assets[k.kind];
    if (previous !== null && previous !== current[k.kind]) {
      files.set(basename(previous), releasedBytes(root, released, previous));
    }
  }
  return { versions: renderVersions({ current, previous: released.assets }), files };
}

const owned = (name) => KINDS.some((k) => k.owned.test(name));

// The differences between the disk and the plan, as messages; empty when the build would change nothing.
export function drift(root, released) {
  const { versions, files } = plan(root, released);
  const problems = [];
  if (readFileSync(join(root, VERSIONS), "utf8") !== versions) {
    problems.push(`${VERSIONS} is not what the build writes`);
  }
  for (const name of readdirSync(join(root, ASSETS)).filter(owned)) {
    if (!files.has(name)) {
      problems.push(`${ASSETS}/${name} is neither a current asset nor the latest release's`);
    }
  }
  for (const [name, bytes] of files) {
    const path = join(root, ASSETS, name);
    if (!existsSync(path) || !readFileSync(path).equals(bytes)) {
      problems.push(`${ASSETS}/${name} does not hold the bytes it is named for`);
    }
  }
  return problems;
}

// The release --check compares with: from the tags, or as recorded when they are unavailable and not required.
export function releaseForCheck(root = ROOT, env = process.env) {
  const released = releasedAssets(root);
  if (released !== null) {
    return { released, warning: null };
  }
  if (env.KOPJE_ASSETS_REQUIRE_TAGS === "1") {
    throw new Error("build-assets: no release tag is reachable from HEAD (a shallow clone?)");
  }
  const recorded = readVersions(readFileSync(join(root, VERSIONS), "utf8")).previous;
  const shown = KINDS.map((k) => `${k.previous} ${recorded[k.kind]}`).join(", ");
  return {
    released: { tag: null, prefix: "", assets: recorded },
    warning: `build-assets: no release tag is reachable from HEAD; trusting the recorded ${shown}`,
  };
}

export function build(root = ROOT) {
  const released = releasedAssets(root);
  if (released === null) {
    throw new Error("build-assets: no release tag is reachable from HEAD; fetch the history and the tags");
  }
  const { versions, files } = plan(root, released);
  for (const name of readdirSync(join(root, ASSETS))) {
    if (owned(name) && !files.has(name)) {
      rmSync(join(root, ASSETS, name));
    }
  }
  for (const [name, bytes] of files) {
    const path = join(root, ASSETS, name);
    if (!existsSync(path) || !readFileSync(path).equals(bytes)) {
      writeFileSync(path, bytes);
    }
  }
  writeFileSync(join(root, VERSIONS), versions);
  return readVersions(versions);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.includes("--check")) {
      const { released, warning } = releaseForCheck();
      if (warning !== null) {
        console.warn(warning);
      }
      const problems = drift(ROOT, released);
      if (problems.length > 0) {
        console.error(`build-assets: ${problems.join("; ")}. Run node scripts/build-assets.mjs.`);
        process.exit(1);
      }
    } else {
      const { current, previous } = build();
      const shown = (paths) => KINDS.map((k) => paths[k.kind] ?? `no ${k.kind}`).join(", ");
      console.log(`build-assets: ${shown(current)}, keeping ${shown(previous)}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
