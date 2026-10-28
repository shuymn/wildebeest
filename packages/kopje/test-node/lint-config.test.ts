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
});
