import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildMaintenance } from "../scripts/build-maintenance.mjs";

// The npm package ships no sources: there the cutover loads its runtime from dist/maintenance-render.js
// (cli/lib/cutover/kopje-runtime.js), built from src/maintenance-render.ts. A package laid out as npm ships it,
// kopje-runtime.js and the built bundle with no src/, must give the cutover every name the sources give it, working.

const root = fileURLToPath(new URL("..", import.meta.url));
// Under the package's node_modules, as the other bundle caches: the build's scratch files stay there too.
const cache = join(root, "node_modules", ".cache", "kopje-runtime");
const packaged = join(cache, "package");
const runtimePath = join(packaged, "cli", "lib", "cutover", "kopje-runtime.js");

beforeAll(async () => {
  await rm(cache, { recursive: true, force: true });
  await mkdir(dirname(runtimePath), { recursive: true });
  await copyFile(join(root, "cli", "lib", "cutover", "kopje-runtime.js"), runtimePath);
  const tmp = process.env.TMPDIR;
  process.env.TMPDIR = join(cache, "tmp");
  await mkdir(process.env.TMPDIR, { recursive: true });
  try {
    buildMaintenance(join(packaged, "dist"));
  } finally {
    process.env.TMPDIR = tmp;
  }
}, 300_000);

afterAll(async () => {
  await rm(cache, { recursive: true, force: true });
});

describe("the packaged cutover runtime", () => {
  it("loads every name from the built bundle when the package has no sources, and the writers work", async () => {
    const source = await readFile(runtimePath, "utf8");
    const names = /export const \{([^}]*)\} = runtime/.exec(source)?.[1]?.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
    expect(names).toEqual(expect.arrayContaining(["storedInstanceSetting", "isBlank", "INSTANCE_DOCUMENTS"]));
    const packagedRuntime = (await import(runtimePath)) as Record<string, unknown>;
    const fromSources = (await import("../cli/lib/cutover/kopje-runtime.js")) as Record<string, unknown>;
    expect(names.filter((name) => packagedRuntime[name] === undefined)).toEqual([]);
    for (const name of names) {
      expect(typeof packagedRuntime[name], name).toBe(typeof fromSources[name]);
    }
    const stored = packagedRuntime.storedInstanceSetting as (name: string, value: string) => string | null;
    expect(stored("title", "T".repeat(1025))).toBe("T".repeat(1024));
    expect(stored("privacy_policy", " \v ")).toBeNull();
    expect((packagedRuntime.isBlank as (text: string) => boolean)("　")).toBe(false);
    expect(packagedRuntime.INSTANCE_DOCUMENTS).toEqual(fromSources.INSTANCE_DOCUMENTS);
    expect((packagedRuntime.sanitizeRemoteHtml as (html: string) => string)("<p>a<script>x</script></p>")).toBe(
      "<p>a</p>",
    );
  });
});
