import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { build, drift, fingerprint, gitEnv, releaseForCheck, releasedAssets } from "../scripts/build-assets.mjs";
import { gitFixture } from "./git-fixture.js";

// The stylesheet that releases before versioned assets linked.
const LEGACY_STYLESHEET = "/assets/kopje.css";

// The asset files across development and releases (scripts/build-assets.mjs): public/assets
// keeps, of the stylesheet and of the L1 script, the current file and the one the latest completed release linked, and
// nothing else. Each case drives a real repository with kopje-v* tags, laid out as packages/kopje is.

const gitRepository = gitFixture("assets");

function repository() {
  const { repo, git, commit, release } = gitRepository();
  const root = join(repo, "packages", "kopje");
  mkdirSync(join(root, "src", "web"), { recursive: true });
  mkdirSync(join(root, "src", "client"), { recursive: true });
  mkdirSync(join(root, "public", "assets"), { recursive: true });
  // A release before versioned assets: the unversioned stylesheet, no script and no versions module.
  writeFileSync(join(root, "public", "assets", "kopje.css"), "legacy {}\n");
  writeFileSync(join(root, "src", "web", "kopje.css"), "legacy {}\n");
  writeFileSync(join(root, "src", "client", "tsconfig.json"), "{}\n");
  writeFileSync(join(root, "src", "client", "main.ts"), 'document.title = "a"\n');
  commit("legacy");
  git("tag", "kopje-v0.1.0-rc.1");
  // A stylesheet source, minified into the served file: its file name.
  const css = (text: string) => {
    writeFileSync(join(root, "src", "web", "kopje.css"), text);
    const { current } = build(root);
    commit(`css ${text}`);
    return current.stylesheet!.slice("/assets/".length);
  };
  // A script source, built into the bundle: its file name.
  const script = (text: string) => {
    writeFileSync(join(root, "src", "client", "main.ts"), text);
    const { current } = build(root);
    commit(`script ${text}`);
    return current.script!.slice("/assets/".length);
  };
  const files = (extension = "css") =>
    readdirSync(join(root, "public", "assets"))
      .filter((name) => name.startsWith("kopje") && name.endsWith(`.${extension}`))
      .toSorted();
  return { root, css, script, files, release, git };
}

// Each case drives a real git through a series of commands: 0.15 to 0.4 s on an idle machine, but past Vitest’s 5 s
// default under a full parallel run on a loaded one. 30 s holds that with room.
describe("build-assets", { timeout: 30_000 }, () => {
  it("keeps the legacy stylesheet while development edits replace each other", () => {
    const { root, css, files } = repository();
    css("a {}\n");
    const b = css("b {}\n");
    const c = css("c {}\n");
    expect(files()).toEqual([c, "kopje.css"].toSorted());
    expect(b).not.toBe(c);
    expect(releasedAssets(root)?.assets).toEqual({ stylesheet: LEGACY_STYLESHEET, script: null });
  });

  it("keeps the released stylesheet when a fix follows the release preparation, until the next tag", () => {
    const { root, css, files, release } = repository();
    const a = css("a {}\n");
    release("0.1.0-rc.2");
    // Successive unreleased CSS edits keep the latest tagged release's stylesheet.
    const b = css("b {}\n");
    const c = css("c {}\n");
    expect(files()).toEqual([a, c].toSorted());
    expect(b).not.toBe(a);
    // The tag of the release being built does not count: its check still compares with rc.2.
    release("0.1.0-rc.3");
    expect(releasedAssets(root)?.tag).toBe("kopje-v0.1.0-rc.2");
    expect(drift(root, releaseForCheck(root).released)).toEqual([]);
  });

  it("counts a tag on HEAD as complete once other CSS is built on top of it", () => {
    const { root, css, files, release } = repository();
    css("a {}\n");
    const b = css("b {}\n");
    release("0.1.0-rc.2");
    // A branch started at the tagged commit edits the CSS: rc.2's stylesheet is the one to keep.
    const c = css("c {}\n");
    expect(files()).toEqual([b, c].toSorted());
    expect(releasedAssets(root)?.tag).toBe("kopje-v0.1.0-rc.2");
  });

  it("drops the older stylesheet when a release keeps the CSS unchanged", () => {
    const { root, css, files, release, git } = repository();
    const a = css("a {}\n");
    release("0.1.0-rc.2");
    git("commit", "-q", "--allow-empty", "-m", "no css change");
    release("0.1.0-rc.3");
    git("commit", "-q", "--allow-empty", "-m", "after rc.3");
    build(root);
    expect(files()).toEqual([a]);
  });

  it("goes A → B → A without keeping B", () => {
    const { css, files, release } = repository();
    const a = css("a {}\n");
    release("0.1.0-rc.2");
    const b = css("b {}\n");
    expect(files()).toEqual([a, b].toSorted());
    expect(css("a {}\n")).toBe(a);
    expect(files()).toEqual([a]);
  });

  it("restores the released file from the release when it was deleted", () => {
    const { root, css, files, release } = repository();
    const a = css("a {}\n");
    release("0.1.0-rc.2");
    const b = css("b {}\n");
    rmSync(join(root, "public", "assets", a));
    expect(drift(root, releaseForCheck(root).released)).toContain(
      `public/assets/${a} does not hold the bytes it is named for`,
    );
    build(root);
    expect(files()).toEqual([a, b].toSorted());
    expect(readFileSync(join(root, "public", "assets", a), "utf8")).toBe("a{}\n");
  });

  it("takes the retained stylesheet’s bytes from its release: an edited copy fails the check and the build repairs it", () => {
    const { root, css, files, release } = repository();
    const a = css("a {}\n");
    release("0.1.0-rc.2");
    const b = css("b {}\n");
    writeFileSync(join(root, "public", "assets", a), "edited {}\n");
    expect(drift(root, releaseForCheck(root).released)).toEqual([
      `public/assets/${a} does not hold the bytes it is named for`,
    ]);
    build(root);
    expect(files()).toEqual([a, b].toSorted());
    expect(readFileSync(join(root, "public", "assets", a), "utf8")).toBe("a{}\n");
    expect(drift(root, releaseForCheck(root).released)).toEqual([]);
  });

  it("locates the repository by its directory when a git hook exports GIT_DIR and GIT_WORK_TREE", () => {
    const { root, css, release } = repository();
    const a = css("a {}\n");
    release("0.1.0-rc.2");
    css("b {}\n");
    const expected = releaseForCheck(root).released;
    expect(drift(root, expected)).toEqual([]);
    // As a pre-push hook runs: the repository's own git directory and work tree in the environment.
    const repo = join(root, "..", "..");
    // GIT_DIR alone makes git take the working directory as the top level; with GIT_WORK_TREE it does not.
    process.env.GIT_DIR = join(repo, ".git");
    process.env.GIT_INDEX_FILE = join(repo, ".git", "index");
    for (const workTree of [undefined, repo]) {
      if (workTree !== undefined) {
        process.env.GIT_WORK_TREE = workTree;
      }
      expect(gitEnv()).not.toHaveProperty("GIT_DIR");
      expect(gitEnv()).toHaveProperty("GIT_CONFIG_GLOBAL");
      const hooked = releaseForCheck(root).released;
      expect(hooked, workTree).toEqual(expected);
      expect(hooked.assets.stylesheet).toBe(`/assets/${a}`);
      expect(drift(root, hooked), workTree).toEqual([]);
    }
  });

  it("runs every git call without the caller’s GIT_* overrides", () => {
    expect(
      Object.keys(process.env)
        .filter((n) => n.startsWith("GIT_"))
        .toSorted(),
    ).toEqual(["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"]);
    const { root, css } = repository();
    css("a {}\n");
    expect(releasedAssets(root)?.tag).toBe("kopje-v0.1.0-rc.1");
  });

  it("flags a stray stylesheet and a stale versions module", () => {
    const { root, css } = repository();
    css("a {}\n");
    writeFileSync(join(root, "public", "assets", "kopje.0123456789.css"), "stray");
    writeFileSync(join(root, "src", "web", "kopje.css"), "edited {}\n");
    const problems = drift(root, releaseForCheck(root).released);
    expect(problems).toContain("src/web/asset-versions.ts is not what the build writes");
    expect(problems).toContain(
      `public/assets/kopje.0123456789.css is neither a current asset nor the latest release's`,
    );
    expect(problems.filter((p) => p.endsWith("does not hold the bytes it is named for"))).toHaveLength(1);
  });

  it("without tags: the build refuses, and the check trusts the recorded file unless tags are required", () => {
    const { root, css, git } = repository();
    css("a {}\n");
    git("tag", "-d", "kopje-v0.1.0-rc.1");
    expect(releasedAssets(root)).toBeNull();
    expect(() => build(root)).toThrow(/no release tag/);
    const { released, warning } = releaseForCheck(root, {});
    expect(released.assets).toEqual({ stylesheet: LEGACY_STYLESHEET, script: null });
    expect(warning).toMatch(/trusting the recorded PREVIOUS_STYLESHEET \/assets\/kopje\.css, PREVIOUS_L1_SCRIPT null$/);
    expect(drift(root, released)).toEqual([]);
    expect(() => releaseForCheck(root, { KOPJE_ASSETS_REQUIRE_TAGS: "1" })).toThrow(/no release tag/);
  });

  it("keeps no script for a release before the bundle, whose versions module has no L1_SCRIPT", () => {
    const { root, css, script, files, release, git } = repository();
    const a = css("a {}\n");
    // A release with versioned assets and before the bundle: its versions module names only the stylesheets.
    const first = files("js");
    expect(first).toHaveLength(1);
    rmSync(join(root, "public", "assets", first[0]!));
    writeFileSync(
      join(root, "src", "web", "asset-versions.ts"),
      `export const STYLESHEET = '/assets/${a}'\nexport const PREVIOUS_STYLESHEET = '/assets/kopje.css'\n`,
    );
    git("add", "-A");
    git("commit", "-q", "-m", "before the bundle");
    release("0.1.0-rc.2");
    const x = script('document.title = "x"\n');
    const y = script('document.title = "y"\n');
    expect(x).not.toBe(y);
    expect(files("js")).toEqual([y]);
    expect(files()).toEqual([a]);
    expect(releasedAssets(root)?.assets).toEqual({ stylesheet: `/assets/${a}`, script: null });
    expect(drift(root, releaseForCheck(root).released)).toEqual([]);
  });

  // Whichever style the build writes the module in, a module in either style is read, a released one included.
  it.each([
    ["single quotes without semicolons", "'", ""],
    ["double quotes with semicolons", '"', ";"],
  ])("reads a versions module in %s, null included, from the tree and from a release", (_style, quote, end) => {
    const { root, css, script, files, release, git } = repository();
    const a = css("a {}\n");
    const x = script('document.title = "x"\n');
    const versions = join(root, "src", "web", "asset-versions.ts");
    const styled = readFileSync(versions, "utf8").replace(
      /^(export const \w+ = )(?:'([^']*)'|"([^"]*)"|null);?$/gm,
      (_match, head: string, single?: string, double?: string) => {
        const path = single ?? double;
        return `${head}${path === undefined ? "null" : `${quote}${path}${quote}`}${end}`;
      },
    );
    expect(styled).toMatch(new RegExp(`^export const PREVIOUS_L1_SCRIPT = null${end}$`, "m"));
    expect(styled).toMatch(new RegExp(`^export const STYLESHEET = ${quote}/assets/${a}${quote}${end}$`, "m"));
    writeFileSync(versions, styled);
    git("add", "-A");
    git("commit", "-q", "--allow-empty", "-m", "restyled");
    // Without tags the check trusts the recorded module.
    git("tag", "-d", "kopje-v0.1.0-rc.1");
    expect(releaseForCheck(root, {}).released.assets).toEqual({ stylesheet: LEGACY_STYLESHEET, script: null });
    // A release whose module is in that style is read for the files it linked.
    release("0.1.0-rc.2");
    const b = css("b {}\n");
    expect(releasedAssets(root)?.assets).toEqual({ stylesheet: `/assets/${a}`, script: `/assets/${x}` });
    expect(files()).toEqual([a, b].toSorted());
    expect(files("js")).toEqual([x]);
    expect(drift(root, releaseForCheck(root).released)).toEqual([]);
  });

  it("keeps the released script while the script changes, and goes A → B → A without keeping B", () => {
    const { root, script, files, release } = repository();
    const x = script('document.title = "x"\n');
    release("0.1.0-rc.2");
    const y = script('document.title = "y"\n');
    expect(files("js")).toEqual([x, y].toSorted());
    expect(readFileSync(join(root, "public", "assets", x), "utf8")).toMatch(/"x"/);
    expect(script('document.title = "x"\n')).toBe(x);
    expect(files("js")).toEqual([x]);
  });

  it("treats a tag on HEAD as the release being built only when it links every current file", () => {
    const { root, css, script, files, release } = repository();
    const a = css("a {}\n");
    const x = script('document.title = "x"\n');
    release("0.1.0-rc.2");
    const b = css("b {}\n");
    release("0.1.0-rc.3");
    // HEAD is rc.3, which links b and x: the release being built, so rc.2 is the latest completed.
    expect(releasedAssets(root)?.tag).toBe("kopje-v0.1.0-rc.2");
    // A branch from rc.3 edits only the script: rc.3 is complete for both kinds, so its stylesheet b is current and
    // kept once, and its script x is the one retained.
    const y = script('document.title = "y"\n');
    expect(releasedAssets(root)?.tag).toBe("kopje-v0.1.0-rc.3");
    expect(files()).toEqual([b]);
    expect(files("js")).toEqual([x, y].toSorted());
    expect(a).not.toBe(b);
  });

  it("publishes the stylesheet with its comments and whitespace removed, named by the served bytes", () => {
    const { root, css } = repository();
    const source = "/* A note. */\n.a {\n\tcolor: red;\n\n\t& .b {\n\t\tmargin: 0 0.5rem;\n\t}\n}\n";
    const a = css(source);
    const served = readFileSync(join(root, "public", "assets", a));
    expect(served.toString("utf8")).toBe(".a{color:red;& .b{margin:0 0.5rem}}\n");
    expect(a).toBe(`kopje.${fingerprint(served)}.css`);
    expect(readFileSync(join(root, "src", "web", "kopje.css"), "utf8")).toBe(source);
  });

  it("refuses a stylesheet esbuild cannot parse, and writes nothing", () => {
    const { root, css, files } = repository();
    const a = css("a {}\n");
    const versions = readFileSync(join(root, "src", "web", "asset-versions.ts"), "utf8");
    writeFileSync(join(root, "src", "web", "kopje.css"), "a { color: red;\n");
    expect(() => build(root)).toThrow(/esbuild cannot read src\/web\/kopje\.css: Expected "}" to go with "{"/);
    expect(() => drift(root, releaseForCheck(root).released)).toThrow(/esbuild cannot read/);
    expect(files()).toEqual([a, "kopje.css"].toSorted());
    expect(readFileSync(join(root, "src", "web", "asset-versions.ts"), "utf8")).toBe(versions);
  });

  it("refuses a comment that may be the only separator between two tokens, and keeps one beside a separator", () => {
    const { root, css, files } = repository();
    const a = css("a {}\n");
    const versions = readFileSync(join(root, "src", "web", "asset-versions.ts"), "utf8");
    // esbuild 0.28.2 joins the tokens around such a comment: `monospace` and `1px`.
    for (const [source, line] of [
      ["a {\n\tfont-family: mono/**/space;\n}\n", 2],
      ["a {\n\t--x: 1/**/px;\n}\n", 2],
      ['a { content: "/*"; }\nb/* x *//* y */c {}\n', 2],
    ] as const) {
      writeFileSync(join(root, "src", "web", "kopje.css"), source);
      const refusal = new RegExp(`only separator between two tokens \\(line ${line}\\)`);
      expect(() => build(root), source).toThrow(refusal);
      expect(() => drift(root, releaseForCheck(root).released), source).toThrow(refusal);
    }
    expect(files()).toEqual([a, "kopje.css"].toSorted());
    expect(readFileSync(join(root, "src", "web", "asset-versions.ts"), "utf8")).toBe(versions);
    // A comment with whitespace, a brace or a semicolon on one side is dropped with nothing joined.
    const b = css("/* a */a {\n\tcolor: red/* b */;\n\tfont-family: mono /* c */space;\n}/* d */\n");
    expect(readFileSync(join(root, "public", "assets", b), "utf8")).toBe("a{color:red;font-family:mono space}\n");
  });

  it("flags a stray script", () => {
    const { root, script } = repository();
    script('document.title = "x"\n');
    writeFileSync(join(root, "public", "assets", "kopje.0123456789.js"), "stray");
    expect(drift(root, releaseForCheck(root).released)).toEqual([
      `public/assets/kopje.0123456789.js is neither a current asset nor the latest release's`,
    ]);
  });
});
