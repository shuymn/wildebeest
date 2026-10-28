import { describe, expect, it } from "vitest";

import { lintProbe } from "./lint-probe.js";

// Settings of the root .oxlintrc.json that a narrower glob or a broader option would quietly undo.
describe("the lint config", () => {
  it("reports an unused import however it is named", () => {
    const flagged = lintProbe({
      "packages/kopje/src/probe.ts": 'import { Hono as _Hono } from "hono";\nimport { cors } from "hono/cors";\n',
    }).filter((d) => d.code === "eslint(no-unused-vars)");
    expect(flagged).toHaveLength(2);
  });

  it("refuses a nullish value in a template in src, pages included", () => {
    const code = "export const line = (name: string | undefined) => `name: ${name}`;\n";
    const flagged = lintProbe({
      "packages/kopje/src/probe.ts": code,
      "packages/kopje/src/probe-page.tsx": code,
      "packages/kopje/probe-outside.ts": code,
    })
      .filter((d) => d.code === "typescript(restrict-template-expressions)")
      .map((d) => d.filename)
      .toSorted();
    expect(flagged).toEqual(["packages/kopje/src/probe-page.tsx", "packages/kopje/src/probe.ts"]);
  });

  it("refuses an import cycle of values, and passes one closed by a type import", () => {
    const flagged = lintProbe({
      "packages/kopje/src/probe-a.ts":
        'import { b } from "./probe-b";\nexport const a = 1;\nexport const ab = a + b;\n',
      "packages/kopje/src/probe-b.ts":
        'import { a } from "./probe-a";\nexport const b = 2;\nexport const ba = a + b;\n',
      "packages/kopje/src/probe-c.ts":
        'import { d } from "./probe-d";\nexport type C = { d: number };\nexport const c = d;\n',
      "packages/kopje/src/probe-d.ts":
        'import type { C } from "./probe-c";\nexport const d = 1;\nexport const e: C = { d };\n',
    })
      .filter((d) => d.code === "import(no-cycle)")
      .map((d) => d.filename)
      .toSorted();
    expect(flagged).toEqual(["packages/kopje/src/probe-a.ts", "packages/kopje/src/probe-b.ts"]);
  });
});
