import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// The admin CLI runs on Node: its filesystem code is tested here, on a real filesystem, outside the Workers pool.
export default defineConfig({
  test: {
    name: "kopje-cli",
    environment: "node",
    include: [fileURLToPath(new URL("./test-node/**/*.test.ts", import.meta.url))],
  },
});
