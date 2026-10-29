import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { MIGRATIONS } from "../src/db/migrations";
import { StoreAdmin } from "../src/platform/store-admin";
import type { StoreStub } from "../src/platform/store-client";
import { constantTimeEqual } from "../src/security/tokens";
import { type AccessTeam, adminClaims, adminHarness, adminTeam, serviceClaims, setTeamAccess } from "./access-helpers";
import { BUILD, migratedStore, testKernel } from "./helpers";
import {
  ACCESS,
  ADMIN_EMAIL,
  dumpViaRpc,
  ensureAdmin,
  importChunks,
  importViaRpc,
  seedStore,
  setAccess,
  splitDump,
} from "./ops-helpers";

const IMPORT_TOKEN = "import-token-0123456789abcdef0123456789";
const TOKEN = { kind: "import-token" } as const;

let team: AccessTeam;

// The Access authority of this test's team (the Store checks the team it was verified with).
const teamAccess = () => ({ ...ACCESS, teamDomain: team.teamDomain });

beforeEach(async () => {
  team = await adminTeam();
});

async function authorityRows(store: StoreStub): Promise<string[]> {
  return runInDurableObject(store, (_instance, state) =>
    state.storage.sql
      .exec<{ row: string }>(
        "SELECT name || '=' || value AS row FROM instance_settings WHERE name IN ('access_team_domain', 'access_admin_aud', 'admin_email', 'access_service_token_client_id') ORDER BY name",
      )
      .toArray()
      .map((r) => r.row),
  );
}

async function dumpOf(configure: (store: StoreStub) => Promise<void> = async () => {}) {
  const source = await migratedStore();
  await seedStore(source, 0);
  await configure(source);
  return (await dumpViaRpc(source)).text;
}

const tokenHeaders = (extra: Record<string, string> = {}) => ({ "Kopje-Import-Token": IMPORT_TOKEN, ...extra });

describe("imported data never changes admin authority", () => {
  it("restores the target's Access configuration exactly after a verified import", async () => {
    const text = await dumpOf((source) =>
      setAccess(source, {
        admin_email: "mallory@evil.test",
        access_service_token_client_id: "evil.access",
        access_admin_aud: "evil-aud",
      }),
    );
    const target = await migratedStore();
    await setTeamAccess(target, team);
    await runInDurableObject(target, (_instance, state) => {
      state.storage.sql.exec("DELETE FROM instance_settings WHERE name = 'access_service_token_client_id'");
    });
    const before = await authorityRows(target);

    expect((await importViaRpc(target, text, undefined, teamAccess())).report).toMatchObject({ ok: true });
    // The target's rows exactly: the dump's values are gone, and the key the target lacked stays absent.
    expect(await authorityRows(target)).toEqual(before);
    const { as } = adminHarness(target, team);
    expect((await as(adminClaims(), "/admin/version")).status).toBe(200);
    expect((await as({ email: "mallory@evil.test" }, "/admin/version")).status).toBe(403);
    expect((await as({ ...serviceClaims(), common_name: "evil.access" }, "/admin/version")).status).toBe(403);
  });
});

describe("config", () => {
  it("sets instance and Access values as an explicit Access admin operation", async () => {
    const store = await migratedStore();
    await setTeamAccess(store, team);
    const { post, as } = adminHarness(store, team);
    const set = await post(adminClaims(), "/admin/config", {
      values: { domain: "kopje.example", access_aud: "login-aud", access_service_token_client_id: null },
    });
    expect(set.status).toBe(200);
    expect(await (await as(adminClaims(), "/admin/config")).json()).toMatchObject({
      values: { domain: "kopje.example", access_aud: "login-aud", admin_email: ADMIN_EMAIL },
    });
    expect(await authorityRows(store)).not.toContainEqual(expect.stringMatching(/^access_service_token_client_id=/));
    expect((await post(adminClaims(), "/admin/config", { values: { title: "x" } })).status).toBe(400);
  });

  it("stores the domain as setup does, lowercase and IDNA to ASCII, and refuses a value that is not a domain", async () => {
    const store = await migratedStore();
    await setTeamAccess(store, team);
    const { post, as } = adminHarness(store, team);
    const domain = async () =>
      (await (await as(adminClaims(), "/admin/config")).json<{ values: Record<string, string> }>()).values.domain;
    for (const [given, stored] of [
      [" Kopje.EXAMPLE ", "kopje.example"],
      ["köpje.example", "xn--kpje-5qa.example"],
    ] as const) {
      expect((await post(adminClaims(), "/admin/config", { values: { domain: given } })).status, given).toBe(200);
      expect(await domain(), given).toBe(stored);
    }
    for (const given of [
      "192.0.2.1",
      "kopje.example:8443",
      "kopje.example/",
      "kopje.example.",
      "kopje",
      "a b.example",
    ]) {
      const refused = await post(adminClaims(), "/admin/config", { values: { domain: given } });
      expect(refused.status, given).toBe(400);
      expect(await refused.text(), given).toContain("domain must be a domain name");
      expect(await domain(), given).toBe("xn--kpje-5qa.example");
    }
  });

  it("accepts IMPORT_TOKEN only while admin access is not usable, checked inside the Store", async () => {
    const store = await migratedStore();
    const { request } = adminHarness(store, team, { IMPORT_TOKEN });
    const values = {
      access_team_domain: team.teamDomain,
      access_admin_aud: "aud-admin-0123456789",
      admin_email: ADMIN_EMAIL,
    };
    const first = await request("/admin/config", {
      method: "POST",
      headers: tokenHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ values }),
    });
    expect(first.status).toBe(200);
    // Admin access is usable now: the token no longer configures anything, even when called on the Store directly.
    const second = await request("/admin/config", {
      method: "POST",
      headers: tokenHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ values: { admin_email: "mallory@evil.test" } }),
    });
    expect(second.status).toBe(403);
    expect(await store.setConfig(BUILD, TOKEN, { admin_email: "mallory@evil.test" })).toMatchObject({
      ok: false,
      code: "not-bootstrap",
    });
  });

  it("is refused while an import is in progress", async () => {
    const target = await migratedStore();
    await setTeamAccess(target, team);
    const begun = await target.importBegin(BUILD, teamAccess(), splitDump(await dumpOf()).header);
    expect(begun).toMatchObject({ ok: true });
    expect(await target.setConfig(BUILD, teamAccess(), { domain: "x.test" })).toMatchObject({
      ok: false,
      code: "import-in-progress",
    });
  });
});

describe("import authority", () => {
  it("authorizes a token-mode import by its own session, never by IMPORT_TOKEN after begin", async () => {
    const text = await dumpOf();
    const store = await migratedStore();
    const { request } = adminHarness(store, team, { IMPORT_TOKEN });
    const begin = await request("/admin/import/begin", {
      method: "POST",
      headers: tokenHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ header: splitDump(text).header }),
    });
    expect(begin.status).toBe(200);
    const { progress, session } = await begin.json<{ progress: { id: string }; session: string }>();
    expect(session).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const chunk = (await importChunks(text, 1 << 20))[0]!;
    const send = (headers: Record<string, string>) =>
      request(`/admin/import/chunk?id=${progress.id}&seq=1`, { method: "POST", headers, body: chunk });

    expect((await send(tokenHeaders())).status).toBe(403);
    expect((await send({ "Kopje-Import-Session": "x".repeat(43) })).status).toBe(403);
    expect((await send({ "Kopje-Import-Session": session })).status).toBe(200);

    const reset = (headers: Record<string, string>) =>
      request("/admin/import/reset", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ confirm: true, id: progress.id }),
      });
    expect((await reset(tokenHeaders())).status).toBe(403);
    expect((await reset({ "Kopje-Import-Session": session })).status).toBe(200);
  });

  it("checks IMPORT_TOKEN eligibility inside the Store, not only in the Worker", async () => {
    const header = splitDump(await dumpOf()).header;
    const configured = await migratedStore();
    await setTeamAccess(configured, team);
    expect(await configured.importBegin(BUILD, TOKEN, header)).toMatchObject({ ok: false, code: "not-bootstrap" });
  });

  it("keeps Access and token imports apart", async () => {
    const text = await dumpOf();
    const store = await migratedStore();
    const begun = await store.importBegin(BUILD, TOKEN, splitDump(text).header);
    if (!begun.ok) throw new Error(begun.message);
    const chunk = (await importChunks(text, 1 << 20))[0]!;
    expect(await store.importChunk(BUILD, ACCESS, begun.progress.id, 1, chunk)).toMatchObject({
      ok: false,
      code: "wrong-authority",
    });
    expect(
      await store.importChunk(BUILD, { kind: "import-session", secret: "y".repeat(43) }, begun.progress.id, 1, chunk),
    ).toMatchObject({ ok: false, code: "wrong-authority" });
    expect(
      await store.importChunk(BUILD, { kind: "import-session", secret: begun.session! }, begun.progress.id, 1, chunk),
    ).toMatchObject({ ok: true });
  });
});

describe("upgrades during an import", () => {
  it("defers an upgrade while an import exists and schedules it when the import ends", async () => {
    const text = await dumpOf();
    const target = await migratedStore();
    await ensureAdmin(target);
    const begun = await target.importBegin(BUILD, ACCESS, splitDump(text).header);
    if (!begun.ok) throw new Error(begun.message);
    const next = [...MIGRATIONS, { name: "9999_probe", sql: "CREATE TABLE probe (a INTEGER)" }];
    await runInDurableObject(target, async (_instance, state) => {
      const kernel = testKernel(state, next);
      expect(await kernel.upgrade()).toMatchObject({ ok: false, reason: "import-in-progress" });
      expect(state.storage.sql.exec("SELECT count(*) AS n FROM sqlite_master WHERE name = 'probe'").one().n).toBe(0);
      await state.storage.deleteAlarm();

      // Verifying the import ends it and schedules the deferred upgrade right away.
      const admin = new StoreAdmin(state, kernel, { source: { build: BUILD, version: "t" }, log: () => {} });
      const id = begun.progress.id;
      for (const [i, chunk] of (await importChunks(text, 1 << 20)).entries()) {
        expect(await admin.importChunk(BUILD, ACCESS, id, i + 1, chunk)).toMatchObject({ ok: true });
      }
      expect(await admin.importFinish(BUILD, ACCESS, id, splitDump(text).trailer)).toMatchObject({ ok: true });
      expect(await admin.importVerify(BUILD, ACCESS, id)).toMatchObject({ done: true, report: { ok: true } });
      expect(await state.storage.getAlarm()).toBeLessThanOrEqual(Date.now() + 1000);
      expect(await kernel.upgrade()).toMatchObject({ ok: true, applied: ["9999_probe"] });
    });
  });
});

describe("import completion receipt", () => {
  it("keeps the report of a verified import for a lost response, without freezing the Store", async () => {
    const target = await migratedStore();
    await ensureAdmin(target);
    await target.setConfig(BUILD, ACCESS, { domain: "kopje.test" });
    const { id, report } = await importViaRpc(target, await dumpOf());
    expect(report).toMatchObject({ ok: true });
    expect(await target.importProgress(BUILD, ACCESS, id)).toMatchObject({
      progress: { id, state: "verified", report: { ok: true } },
    });
    expect(await target.setupState(BUILD)).toEqual({ complete: true });
  });
});

describe("service tokens", () => {
  it("requires the empty subject of a service token, not only a matching common_name", async () => {
    const store = await migratedStore();
    await setTeamAccess(store, team);
    const { as } = adminHarness(store, team);
    expect((await as(serviceClaims(), "/admin/version")).status).toBe(200);
    expect((await as({ ...serviceClaims(), sub: "mtls-certificate" }, "/admin/version")).status).toBe(403);
  });
});

describe("configuration is everything config accepts", () => {
  it("keeps the target domain and access_aud, and leaves an absent one absent", async () => {
    const text = await dumpOf((source) =>
      runInDurableObject(source, (_instance, state) => {
        state.storage.sql.exec("UPDATE instance_settings SET value = 'evil.test' WHERE name = 'domain'");
        state.storage.sql.exec("INSERT INTO instance_settings (name, value) VALUES ('access_aud', 'evil-login-aud')");
      }),
    );
    const target = await migratedStore();
    await ensureAdmin(target);
    // Configuration does not make the Store non-empty: it can be set before the import.
    expect(await target.setConfig(BUILD, ACCESS, { domain: "kopje.test" })).toMatchObject({ ok: true });
    const before = await target.config(BUILD);
    expect(before.values).toMatchObject({ domain: "kopje.test" });
    expect(before.values.access_aud).toBeUndefined();
    expect((await importViaRpc(target, text)).report).toMatchObject({ ok: true });
    expect(await target.config(BUILD)).toEqual(before);
    // The rest of instance_settings is data and came with the dump.
    const title = await runInDurableObject(target, (_instance, state) =>
      state.storage.sql.exec<{ value: string }>("SELECT value FROM instance_settings WHERE name = 'title'").one(),
    );
    expect(title.value).toBe("Kopje");
  });
});

describe("abandoning a stranded token import", () => {
  const T0 = Date.parse("2026-10-12T00:00:00Z");
  const IDLE = 15 * 60 * 1000;

  it("lets IMPORT_TOKEN reset a token import idle for 15 minutes, and says when before that", async () => {
    const text = await dumpOf();
    const store = await migratedStore();
    await runInDurableObject(store, async (_instance, state) => {
      const at = (ms: number) =>
        new StoreAdmin(state, testKernel(state), {
          source: { build: BUILD, version: "t" },
          log: () => {},
          now: () => ms,
        });
      const begun = await at(T0).importBegin(BUILD, TOKEN, splitDump(text).header);
      if (!begun.ok || begun.session === undefined) throw new Error("no session");
      const session = { kind: "import-session", secret: begun.session } as const;
      const chunk = (await importChunks(text, 1 << 20))[0]!;
      // A successful step at T0 + 5 min restarts the idle clock.
      expect(await at(T0 + 5 * 60 * 1000).importChunk(BUILD, session, begun.progress.id, 1, chunk)).toMatchObject({
        ok: true,
      });

      const early = await at(T0 + 5 * 60 * 1000 + IDLE - 1000).importReset(BUILD, TOKEN, begun.progress.id, true);
      expect(early).toMatchObject({ ok: false, code: "import-not-idle" });
      expect(early.ok ? "" : early.message).toContain(new Date(T0 + 5 * 60 * 1000 + IDLE).toISOString());
      // Without the explicit abandon request the token never resets an import.
      expect(await at(T0 + 60 * IDLE).importReset(BUILD, TOKEN, begun.progress.id)).toMatchObject({
        ok: false,
        code: "wrong-authority",
      });

      expect(await at(T0 + 5 * 60 * 1000 + IDLE).importReset(BUILD, TOKEN, begun.progress.id, true)).toMatchObject({
        ok: true,
      });
      expect(state.storage.sql.exec("SELECT count(*) AS n FROM accounts").one().n).toBe(0);
    });
    expect(await store.adminGate(BUILD)).toMatchObject({ bootstrap: true });
    expect(await store.importProgress(BUILD, ACCESS)).toEqual({ progress: null });
  });

  it("never lets IMPORT_TOKEN reset an Access import", async () => {
    const store = await migratedStore();
    await setTeamAccess(store, team);
    const begun = await store.importBegin(BUILD, teamAccess(), splitDump(await dumpOf()).header);
    if (!begun.ok) throw new Error(begun.message);
    expect(await store.importReset(BUILD, TOKEN, begun.progress.id, true)).toMatchObject({
      ok: false,
      code: "wrong-authority",
    });
  });

  it("answers the CLI with the time the reset becomes possible", async () => {
    const store = await migratedStore();
    const { request } = adminHarness(store, team, { IMPORT_TOKEN });
    const begin = await request("/admin/import/begin", {
      method: "POST",
      headers: tokenHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ header: splitDump(await dumpOf()).header }),
    });
    const { progress } = await begin.json<{ progress: { id: string } }>();
    const reset = await request("/admin/import/reset", {
      method: "POST",
      headers: tokenHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ confirm: true, id: progress.id, abandonStale: true }),
    });
    expect(reset.status).toBe(409);
    expect(await reset.json()).toMatchObject({ code: "import-not-idle", resetAfter: expect.any(String) });
  });
});

describe("constantTimeEqual", () => {
  it("keeps its result for equal, different, prefixed and non-ASCII values", () => {
    expect(constantTimeEqual("", "")).toBe(true);
    expect(constantTimeEqual("secret", "secret")).toBe(true);
    expect(constantTimeEqual("secret", "secreT")).toBe(false);
    expect(constantTimeEqual("secret", "secret-longer")).toBe(false);
    expect(constantTimeEqual("ü", "u")).toBe(false);
    expect(constantTimeEqual("🦬", "🦬")).toBe(true);
  });
});
