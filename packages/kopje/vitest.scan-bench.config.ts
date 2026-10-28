import { fileURLToPath } from "node:url";

import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// The web-page scan benchmark, apart from the migration benchmark (vitest.bench.config.ts) so it never runs with it or
// counts toward its gate; usage: test/bench/web-page-scan.bench.ts.
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: fileURLToPath(new URL("./wrangler.jsonc", import.meta.url)) } })],
  resolve: { alias: { postcss: fileURLToPath(new URL("./stubs/postcss.cjs", import.meta.url)) } },
  test: {
    name: "kopje-scan-bench",
    include: [fileURLToPath(new URL("./test/bench/web-page-scan.bench.ts", import.meta.url))],
    testTimeout: 600_000,
    fsModuleCache: false,
  },
});
