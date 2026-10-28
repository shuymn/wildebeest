import { fileURLToPath } from "node:url";

import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

import { sqlDepthService } from "./test-node/sql-depth";

// The streaming API's suites (test/streaming): Durable Object WebSockets are not supported with per-file storage
// isolation, so these run in one worker without isolation, as Cloudflare documents (`--max-workers=1 --no-isolate`).
// Each test opens its sockets on a Store of its own name (test/streaming/stream-helpers.ts). Otherwise as
// vitest.config.ts.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: fileURLToPath(new URL("./wrangler.jsonc", import.meta.url)) },
      miniflare: {
        ratelimits: {
          APP_REGISTRATION_LIMIT: { namespace_id: "4201", simple: { limit: 1_000_000, period: 60 } },
          LOGIN_LIMIT: { namespace_id: "4202", simple: { limit: 1_000_000, period: 60 } },
        },
        serviceBindings: { SQL_DEPTH: sqlDepthService },
      },
    }),
  ],
  resolve: { alias: { postcss: fileURLToPath(new URL("./stubs/postcss.cjs", import.meta.url)) } },
  test: {
    name: "kopje-streaming",
    include: [fileURLToPath(new URL("./test/streaming/**/*.test.ts", import.meta.url))],
    setupFiles: [fileURLToPath(new URL("./test/sql-depth-setup.ts", import.meta.url))],
    isolate: false,
    maxWorkers: 1,
    fileParallelism: false,
    // In a run of several projects (the root config), a project with its own maxWorkers runs in a group of its own.
    sequence: { groupOrder: 1 },
    // Tests wait for what arrives on their sockets and for the drain barrier, never a fixed time; this guards them.
    testTimeout: 20_000,
    fsModuleCache: false,
  },
});
