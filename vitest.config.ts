import { defineConfig } from "vitest/config";

// Kopje's code, for coverage. Vitest matches coverage globs from the workspace root in a run of every project and from
// the project's root (packages/kopje) in a run of one (`--project`), and ignores absolute globs, so each is given
// from both; the root has no src/ or cli/ of its own.
const covered = ["src/**/*.{ts,tsx}", "cli/**/*.js"];

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
    // more. Every file the globs match is reported, one no test loads as uncovered.
    coverage: {
      provider: "v8",
      reporter: ["lcovonly"],
      include: [...covered, ...covered.map((glob) => `packages/kopje/${glob}`)],
      exclude: ["**/*.d.ts"],
    },
  },
});
