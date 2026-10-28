import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/kopje/vitest.config.ts",
      "packages/kopje/vitest.streaming.config.ts",
      "packages/kopje/vitest.node.config.ts",
    ],
  },
});
