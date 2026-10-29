import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";

// Temporary git repositories for the suites that drive a real git (build-assets, released-migrations).
//
// A hermetic git for every call of a case, the fixture's and the script's under test (which inherits process.env): no
// inherited GIT_* override (GIT_DIR, GIT_INDEX_FILE, GIT_WORK_TREE, object, template and config variables, as a
// calling hook may set them) and no user or system configuration (no signing, no hooks). The global configuration is
// an empty file inside the suite's temporary directory. Call it once at a suite's top level: it registers the hooks
// that set up and restore the environment and remove every repository the suite made.
export function gitFixture(name: string) {
  let home = "";
  let saved: NodeJS.ProcessEnv = {};
  const repos: string[] = [];

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), `kopje-${name}-home-`));
    writeFileSync(join(home, "gitconfig"), "");
  });

  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
  });

  beforeEach(() => {
    saved = { ...process.env };
    for (const variable of Object.keys(process.env).filter((n) => n.startsWith("GIT_"))) {
      Reflect.deleteProperty(process.env, variable);
    }
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    process.env.GIT_CONFIG_GLOBAL = join(home, "gitconfig");
  });

  afterEach(() => {
    for (const repo of repos.splice(0)) {
      rmSync(repo, { recursive: true, force: true });
    }
    for (const variable of Object.keys(process.env).filter((n) => n.startsWith("GIT_"))) {
      Reflect.deleteProperty(process.env, variable);
    }
    Object.assign(process.env, saved);
  });

  // An empty repository on branch main, removed after the case: `git` runs in it, `commit` commits every change
  // (empty or not) and `release` tags HEAD as kopje-v<version>.
  return function repository() {
    const repo = mkdtempSync(join(tmpdir(), `kopje-${name}-`));
    repos.push(repo);
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    git("init", "-q", "-b", "main");
    const commit = (message: string) => {
      git("add", "-A");
      git("commit", "-q", "--allow-empty", "-m", message);
    };
    const release = (version: string) => git("tag", `kopje-v${version}`);
    return { repo, git, commit, release };
  };
}
