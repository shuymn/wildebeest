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
    // `--coverage` (CI's coverage-test shards) writes coverage/lcov.info, with paths from the repository root, for
    // octocov (.octocov.yml), also when a test failed. V8 coverage reaches workerd through @cloudflare/vitest-plugin's
    // inspector session and counts blocks in every module the isolate runs: the globs choose what is reported, not
    // what is slowed. Every file they match is reported, one no test loads as uncovered.
    coverage: {
      provider: "v8",
      reporter: ["lcovonly"],
      reportOnFailure: true,
      include: [...covered, ...covered.map((glob) => `packages/kopje/${glob}`)],
      exclude: ["**/*.d.ts"],
    },
  },
});
