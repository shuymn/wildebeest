import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { healthReport } from "../src/app/health";
import { readConfig } from "../src/platform/config";
import { harness } from "./app-helpers";
import { fixtureKeyGen, LEGACY, LEGACY_EMPTY_KEK, seedLocalAccount, setDomain } from "./federation-helpers";
import { BUILD, migratedStore } from "./helpers";

const DOMAIN = "social.example";

async function report(store: Awaited<ReturnType<typeof migratedStore>>, kek: string | undefined) {
  const config = readConfig({ ...env, ...(kek === undefined ? {} : { USER_KEK: kek }) });
  return healthReport(BUILD, config, () => store);
}

describe("key check in healthReport", () => {
  it("passes when every local key unwraps with the KEK and matches local_accounts.pubkey", async () => {
    const store = await migratedStore();
    await seedLocalAccount(store, DOMAIN, { id: "111111111111111111", username: "alice" });
    expect(await report(store, LEGACY.kek)).toMatchObject({
      ok: true,
      checks: { keys: { ok: true, count: 1, failures: [] } },
    });
  });

  it("fails on a key the KEK cannot unwrap and on a key that does not match its public key", async () => {
    const store = await migratedStore();
    await seedLocalAccount(store, DOMAIN, { id: "111111111111111111", username: "alice" });
    await seedLocalAccount(store, DOMAIN, {
      id: "111111111111111112",
      username: "bob",
      key: { ...LEGACY, pubkey: LEGACY_EMPTY_KEK.pubkey },
    });
    expect(await report(store, "wrong")).toMatchObject({
      ok: false,
      checks: {
        keys: {
          ok: false,
          failures: [
            { owner: "alice", result: "unwrap-failed" },
            { owner: "bob", result: "unwrap-failed" },
          ],
        },
      },
    });
    expect((await report(store, LEGACY.kek)).checks.keys).toMatchObject({
      ok: false,
      failures: [{ owner: "bob", result: "pubkey-mismatch" }],
    });
  });

  it("accepts an empty KEK but warns, and treats an unset USER_KEK as empty", async () => {
    const store = await migratedStore();
    await seedLocalAccount(store, DOMAIN, { id: "111111111111111111", username: "alice", key: LEGACY_EMPTY_KEK });
    expect((await report(store, "")).checks.keys).toEqual({
      ok: true,
      count: 1,
      failures: [],
      warning: "USER_KEK is empty",
    });
    expect((await report(store, undefined)).checks.keys).toMatchObject({ ok: true, warning: "USER_KEK is empty" });
  });

  it("checks the instance actor key too", async () => {
    const store = await migratedStore();
    await setDomain(store, DOMAIN);
    const loader = { fetch: () => Promise.reject(new Error("offline")), checkHost: () => Promise.resolve() };
    await harness(store, { USER_KEK: LEGACY.kek }, BUILD, { keygen: fixtureKeyGen, loader }).request("/actor", {
      headers: { accept: "application/activity+json" },
    });
    expect((await report(store, LEGACY.kek)).checks.keys).toMatchObject({ ok: true, count: 1 });
    expect((await report(store, "wrong")).checks.keys).toMatchObject({
      ok: false,
      failures: [{ owner: "(instance actor)", result: "unwrap-failed" }],
    });
  });

  it("is not run by the public /health", async () => {
    const store = await migratedStore();
    await seedLocalAccount(store, DOMAIN, { id: "111111111111111111", username: "alice" });
    const response = await harness(store, { USER_KEK: "wrong" }).request("/health");
    expect(await response.text()).toBe("ok");
  });
});
