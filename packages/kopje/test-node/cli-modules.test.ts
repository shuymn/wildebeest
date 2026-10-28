import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

// Every CLI module loads on its own under Node, as the installed CLI loads it: an import cycle that reads a binding
// before its module has run (a temporal dead zone) fails only for some entry orders, which the other suites, importing
// modules in their own order, need not hit. Each module is imported first, in a fresh process.

const run = promisify(execFile);
const lib = fileURLToPath(new URL("../cli/lib/", import.meta.url));
const modules = [
  ...readdirSync(lib).filter((f) => f.endsWith(".js")),
  ...readdirSync(`${lib}cutover`)
    .filter((f) => f.endsWith(".js"))
    .map((f) => `cutover/${f}`),
];

describe("CLI modules", () => {
  it.each(modules)("%s loads first in a fresh Node process", async (module) => {
    const url = new URL(`../cli/lib/${module}`, import.meta.url).href;
    // A failed import exits non-zero, which rejects (warnings on stderr do not).
    await expect(
      run(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(url)})`]),
    ).resolves.toBeDefined();
  });
});
