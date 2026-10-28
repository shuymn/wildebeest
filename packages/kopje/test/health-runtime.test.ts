import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { healthReport } from "../src/app/health";
import { readConfig } from "../src/platform/config";
import { BUILD, migratedStore } from "./helpers";

describe("runtime check in healthReport", () => {
  it("passes on the runtime the tests share with wrangler.jsonc (NET-1)", async () => {
    const store = await migratedStore();
    expect(Cloudflare.compatibilityFlags.global_fetch_strictly_public).toBe(true);
    expect((await healthReport(BUILD, readConfig(env), () => store)).checks.runtime).toEqual({ ok: true });
  });

  it("fails with the fix when global_fetch_strictly_public is off", async () => {
    const store = await migratedStore();
    const report = await healthReport(BUILD, readConfig(env), () => store, {
      compatibilityFlags: { ...Cloudflare.compatibilityFlags, global_fetch_strictly_public: false },
    });
    expect(report.ok).toBe(false);
    expect(report.checks.runtime).toEqual({
      ok: false,
      missing: ["global_fetch_strictly_public"],
      fix: "add global_fetch_strictly_public to compatibility_flags in wrangler.jsonc and redeploy (docs/upgrade.md)",
    });
  });
});
