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
});
