import { fileURLToPath } from "node:url";

import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

import { imageFacts } from "./test-node/image-facts";
import { sqlDepthService } from "./test-node/sql-depth";
import { webPageFixtures } from "./test-node/web-page-fixtures";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: fileURLToPath(new URL("./wrangler.jsonc", import.meta.url)) },
      // The suites run on wrangler.jsonc's production compatibility date: workerd accepts any date up to today.
      // The app registration limit (5 per minute per IP in wrangler.jsonc) would throttle the suites, which register
      // apps from one address; test/apps-budget.test.ts injects a limiter of its own. The same for sign-ins.
      miniflare: {
        ratelimits: {
          APP_REGISTRATION_LIMIT: { namespace_id: "4201", simple: { limit: 1_000_000, period: 60 } },
          LOGIN_LIMIT: { namespace_id: "4202", simple: { limit: 1_000_000, period: 60 } },
        },
        // Measures the expression depth of the statements a suite ran, on Node (test/sql-depth-setup.ts).
        // Compressed web pages with exact bytes, fetched through workerd (test-node/web-page-fixtures.ts).
        // An independent image reader and fixture maker for the remote media suites (test-node/image-facts.ts).
        serviceBindings: {
          SQL_DEPTH: sqlDepthService,
          WEB_PAGE_FIXTURES: { node: webPageFixtures },
          IMAGE_FACTS: { node: imageFacts },
        },
      },
    }),
  ],
  // As wrangler.jsonc's alias: sanitize-html never reaches postcss (stubs/postcss.cjs).
  resolve: { alias: { postcss: fileURLToPath(new URL("./stubs/postcss.cjs", import.meta.url)) } },
  test: {
    name: "kopje",
    // Converts a synthetic legacy export on Node for test/cutover-import.test.ts (node:sqlite is not in workerd).
    globalSetup: [fileURLToPath(new URL("./test-node/cutover-global-setup.ts", import.meta.url))],
    include: [fileURLToPath(new URL("./test/**/*.test.ts", import.meta.url))],
    // The streaming suites run in a project of their own, in one worker (vitest.streaming.config.ts).
    exclude: [fileURLToPath(new URL("./test/streaming/**", import.meta.url))],
    setupFiles: [
      fileURLToPath(new URL("./test/sql-depth-setup.ts", import.meta.url)),
      fileURLToPath(new URL("./test/storage-setup.ts", import.meta.url)),
    ],
    // The suites run without isolation: a worker loads the Worker's modules once instead of once a suite, which took
    // about half of each suite's time, and runs its suites in turn on one runtime. Each test works on a Store of its
    // own name (test/helpers.ts) and each suite starts on an empty media bucket (test/storage-setup.ts); a message a
    // harness leaves on the real queue reaches the Store of the default name, which no test reads. What stays in
    // module scope across suites is keyed per test (an Access team's key set, by its random domain), settles within
    // its test (a card image call given up, which its test waits out), or is the same for every test (the migrated
    // schema that migratedStore replays, test/helpers.ts).
    isolate: false,
    // The suites drive the real Store through workerd; on a loaded CI runner a heavy test can pass 5 s.
    testTimeout: 20_000,
    // Vitest 5.0.4 caches transformed modules on disk by default; workerd cannot read that cache back, so every file
    // failed to load. The Node suite (vitest.node.config.ts) keeps it.
    fsModuleCache: false,
    // FC_SEED replays a property test's run (test/policy-world.ts).
    provide: { fcSeed: process.env.FC_SEED ?? "" },
  },
});
