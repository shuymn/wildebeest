import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/kopje/vitest.config.ts",
      "packages/kopje/vitest.streaming.config.ts",
      "packages/kopje/vitest.node.config.ts",
    ],
    // `--coverage` (CI's test shards) writes coverage/lcov.info, with paths from the repository root, for octocov
    // (.octocov.yml). V8 coverage reaches workerd through @cloudflare/vitest-plugin's inspector session and adds a
    // few percent to a shard's CPU time; istanbul instruments every module in Vite's transform, which slowed a shard
    // more. The globs match from each project's root, packages/kopje; every file they match is reported, one no test
    // loads as uncovered.
    coverage: {
      provider: "v8",
      reporter: ["lcovonly"],
      include: ["src/**/*.ts", "cli/**/*.js"],
      exclude: ["**/*.d.ts"],
    },
  },
});
