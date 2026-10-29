import { spawnSync } from "node:child_process";
import { mkdirSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { releasedMigrations } from "../scripts/released-migrations.mjs";
import { gitFixture } from "./git-fixture.js";

// A released migration is never changed (scripts/released-migrations.mjs): every .sql file under
// packages/kopje/migrations/ in any kopje-v* tag stays in the working tree with the same bytes. Each case drives a real
// repository with kopje-v* tags, laid out as the repository is.

const CLI = fileURLToPath(new URL("../scripts/released-migrations.mjs", import.meta.url));

const gitRepository = gitFixture("migrations");

// A repository whose first commit holds two migrations, 0000 and 0001.
function repository() {
  const { repo, git, commit, release } = gitRepository();
  const migrations = join(repo, "packages", "kopje", "migrations");
  mkdirSync(migrations, { recursive: true });
  const write = (name: string, text: string) => writeFileSync(join(migrations, name), text);
  write("0000_initial.sql", "CREATE TABLE a (id INTEGER);\n");
  write("0001_b.sql", "CREATE TABLE b (id INTEGER);\n");
  commit("initial");
  return { repo, migrations, git, write, commit, release };
}

const path = (name: string) => `packages/kopje/migrations/${name}`;

describe("released-migrations", { timeout: 30_000 }, () => {
  it("passes unchanged released files and a new unreleased file", () => {
    const { repo, write, commit, release } = repository();
    release("0.1.0");
    write("0002_c.sql", "CREATE TABLE c (id INTEGER);\n");
    commit("unreleased");
    expect(releasedMigrations(repo)).toEqual({ problems: [], tags: 1, files: 2 });
  });

  it("flags a released file edited by one byte", () => {
    const { repo, write, release } = repository();
    release("0.1.0");
    write("0001_b.sql", "CREATE TABLE b (id INTEGEr);\n");
    expect(releasedMigrations(repo).problems).toEqual([`${path("0001_b.sql")} differs from kopje-v0.1.0`]);
  });

  it("flags LF turned into CRLF, also under a text attribute and core.autocrlf", () => {
    const { repo, git, write, commit, release } = repository();
    release("0.1.0");
    write("0001_b.sql", "CREATE TABLE b (id INTEGER);\r\n");
    expect(releasedMigrations(repo).problems).toEqual([`${path("0001_b.sql")} differs from kopje-v0.1.0`]);
    // With the attribute and autocrlf, git itself takes the CRLF file as unchanged; the check does not.
    writeFileSync(join(repo, ".gitattributes"), "*.sql text\n");
    commit("attributes");
    git("config", "core.autocrlf", "true");
    expect(git("status", "--porcelain").toString()).toBe("");
    expect(releasedMigrations(repo).problems).toEqual([`${path("0001_b.sql")} differs from kopje-v0.1.0`]);
  });

  it("flags a released file deleted", () => {
    const { repo, migrations, release } = repository();
    release("0.1.0");
    unlinkSync(join(migrations, "0001_b.sql"));
    expect(releasedMigrations(repo).problems).toEqual([
      `${path("0001_b.sql")} was released in kopje-v0.1.0 and is missing`,
    ]);
  });

  it("flags a released file renamed", () => {
    const { repo, migrations, release } = repository();
    release("0.1.0");
    renameSync(join(migrations, "0001_b.sql"), join(migrations, "0001_renamed.sql"));
    expect(releasedMigrations(repo).problems).toEqual([
      `${path("0001_b.sql")} was released in kopje-v0.1.0 and is missing`,
    ]);
  });

  it("flags a released file replaced by a symlink to identical bytes", () => {
    const { repo, migrations, release } = repository();
    release("0.1.0");
    renameSync(join(migrations, "0001_b.sql"), join(repo, "elsewhere.sql"));
    symlinkSync(join(repo, "elsewhere.sql"), join(migrations, "0001_b.sql"));
    expect(releasedMigrations(repo).problems).toEqual([`${path("0001_b.sql")} is not a regular file`]);
  });

  it("flags released files in a migrations directory that is a symlink to identical files", () => {
    const { repo, migrations, release } = repository();
    release("0.1.0");
    renameSync(migrations, join(repo, "copy"));
    symlinkSync(join(repo, "copy"), migrations);
    expect(releasedMigrations(repo).problems).toEqual([
      `${path("0000_initial.sql")} is not a regular file`,
      `${path("0001_b.sql")} is not a regular file`,
    ]);
  });

  it("flags a file present only in a release candidate, then edited", () => {
    const { repo, write, commit, release } = repository();
    release("0.1.0");
    write("0002_c.sql", "CREATE TABLE c (id INTEGER);\n");
    commit("c");
    release("0.2.0-rc.1");
    write("0002_c.sql", "CREATE TABLE c (id TEXT);\n");
    commit("c edited");
    expect(releasedMigrations(repo).problems).toEqual([`${path("0002_c.sql")} differs from kopje-v0.2.0-rc.1`]);
  });

  it("flags a file changed after the first of two tags that both hold it", () => {
    const { repo, write, commit, release } = repository();
    release("0.1.0");
    write("0001_b.sql", "CREATE TABLE b (id TEXT);\n");
    commit("b changed");
    release("0.2.0");
    // The latest tag matches the working tree; only the first one shows the change.
    expect(releasedMigrations(repo).problems).toEqual([`${path("0001_b.sql")} differs from kopje-v0.1.0`]);
  });

  it("reads a release tag on a commit not reachable from HEAD", () => {
    const { repo, git, write, commit, release } = repository();
    release("0.1.0");
    git("switch", "-q", "-c", "side");
    write("0002_c.sql", "CREATE TABLE c (id INTEGER);\n");
    commit("side");
    release("0.2.0");
    git("switch", "-q", "main");
    // main gains the same file later: unchanged, so it passes, and the tag's file is counted.
    write("0002_c.sql", "CREATE TABLE c (id INTEGER);\n");
    commit("c");
    expect(releasedMigrations(repo)).toEqual({ problems: [], tags: 2, files: 3 });
    // The unreachable tag is read: an edit to its file is flagged.
    write("0002_c.sql", "CREATE TABLE c (id TEXT);\n");
    expect(releasedMigrations(repo).problems).toEqual([`${path("0002_c.sql")} differs from kopje-v0.2.0`]);
  });

  it("ignores tags outside kopje-v*", () => {
    const { repo, write, release, git } = repository();
    git("tag", "v0.1.0");
    release("0.1.0");
    write("0002_c.sql", "x\n");
    expect(releasedMigrations(repo)).toEqual({ problems: [], tags: 1, files: 2 });
  });

  it("lists the tags one per line under column.tag=always", () => {
    const { repo, git, write, commit, release } = repository();
    release("0.1.0");
    write("0002_c.sql", "CREATE TABLE c (id INTEGER);\n");
    commit("c");
    release("0.2.0");
    git("config", "column.tag", "always");
    expect(releasedMigrations(repo)).toEqual({ problems: [], tags: 2, files: 3 });
  });

  it("throws when there is no kopje-v* tag", () => {
    const { repo, git } = repository();
    git("tag", "v0.1.0");
    expect(() => releasedMigrations(repo)).toThrow("no kopje-v* tag");
  });

  it("throws when the tags hold no .sql file under the migrations directory", () => {
    const { repo, git, release } = repository();
    git("mv", "packages/kopje/migrations", "packages/kopje/other");
    git("commit", "-q", "-m", "moved");
    release("0.1.0");
    expect(() => releasedMigrations(repo)).toThrow("hold no .sql file");
  });

  it("reports the counts from the CLI and fails it on a problem", () => {
    const { repo, write, release } = repository();
    release("0.1.0");
    const run = () => spawnSync(process.execPath, [CLI, repo], { env: process.env, encoding: "utf8" });
    const passed = run();
    expect(passed.status).toBe(0);
    expect(passed.stdout).toBe("released-migrations: 2 released files from 1 tags are unchanged\n");
    write("0000_initial.sql", "");
    const failed = run();
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain(`released-migrations: ${path("0000_initial.sql")} differs from kopje-v0.1.0\n`);
  });
});
