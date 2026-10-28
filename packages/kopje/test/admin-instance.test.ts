import { runInDurableObject } from "cloudflare:test";
import fc from "fast-check";
import { beforeEach, describe, expect, it } from "vitest";

import { INSTANCE_ADMIN_NAMES, setInstanceSettings } from "../src/domain/instance";
import type { StoreStub } from "../src/platform/store-client";
import { INSTANCE_SETTING_BOUNDS, type StoredSettingName, storedSetting } from "../src/platform/stored-bounds";
import { adminClaims, adminHarness, adminTeam, setTeamAccess, type AccessTeam } from "./access-helpers";
import { json, seedAccount, setSetting, sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { BUILD, migratedStore, rejectionOf } from "./helpers";
import { ACCESS, beginImport, dumpViaRpc, importChunks, importViaRpc, resetImport, setAccess } from "./ops-helpers";

// The Access admin's write of the instance's public settings (domain/instance.ts setInstanceSettings, POST
// /admin/instance, `kopje-admin instance`): AUTH-5, the bounds of INSTANCE_SETTING_BOUNDS in their units, the terms of
// service's pairing on the merged state, stamps, and the settings as data (dumped, imported, reset).

const ENCODER = new TextEncoder();
const astral = "\u{1F600}";
// 50,000 UTF-8 bytes exactly.
const DOCUMENT_AT = `<p>${"日".repeat(16_664)}a</p>`;

type Result = Awaited<ReturnType<StoreStub["setInstanceSettings"]>>;

async function store(): Promise<StoreStub> {
  const s = await migratedStore();
  await setAccess(s);
  return s;
}

const set = (s: StoreStub, values: Record<string, unknown>, now = NOW): Promise<Result> =>
  s.setInstanceSettings(BUILD, { authority: ACCESS, values, now });

const values = async (s: StoreStub) => s.instanceAdminSettings(BUILD);

const refusal = (message: RegExp | string) => ({
  ok: false,
  code: "invalid-instance-setting",
  message: typeof message === "string" ? message : expect.stringMatching(message),
});

const logRows = (s: StoreStub) =>
  sql<{ actor: string; action: string; target_type: string; target_id: string; detail: string }>(
    s,
    "SELECT actor, action, target_type, target_id, detail FROM admin_actions ORDER BY id",
  );

describe("POST /admin/instance", () => {
  let team: AccessTeam;

  beforeEach(async () => {
    team = await adminTeam();
  });

  it("sets and removes the settings for the Access admin, logged as Setting targets without values", async () => {
    const s = await migratedStore();
    await setTeamAccess(s, team);
    const { as, request } = adminHarness(s, team, { IMPORT_TOKEN: "import-token-0123456789abcdef0123456789" });
    const post = async (body: unknown) => {
      const response = await as(adminClaims(), "/admin/instance", json(body));
      return { status: response.status, body: await response.json<Record<string, unknown>>() };
    };
    expect(
      await post({ values: { title: "  Herd  ", privacy_policy: "<p>Policy</p>", show_domain_blocks: "users" } }),
    ).toEqual({
      status: 200,
      body: {
        values: {
          title: "Herd",
          privacy_policy: "<p>Policy</p>",
          show_domain_blocks: "users",
          privacy_policy_updated_at: new Date(NOW).toISOString(),
        },
      },
    });
    expect(await (await as(adminClaims(), "/admin/instance")).json()).toMatchObject({ values: { title: "Herd" } });
    expect(await post({ values: { title: null } })).toMatchObject({ status: 200 });
    expect(await post({ values: { bogus: "x" } })).toMatchObject({
      status: 400,
      body: { code: "invalid-instance-setting" },
    });
    expect((await logRows(s)).map((r) => [r.actor, r.action, r.target_type, r.target_id, r.detail])).toEqual([
      ["access", "update_setting", "Setting", "title", JSON.stringify({ identity: "admin@kopje.test" })],
      ["access", "update_setting", "Setting", "privacy_policy", JSON.stringify({ identity: "admin@kopje.test" })],
      ["access", "update_setting", "Setting", "show_domain_blocks", JSON.stringify({ identity: "admin@kopje.test" })],
      ["access", "remove_setting", "Setting", "title", JSON.stringify({ identity: "admin@kopje.test" })],
    ]);
    // The import token reaches neither path; the configuration does not list these names.
    const token = { headers: { "Kopje-Import-Token": "import-token-0123456789abcdef0123456789" } };
    expect((await request("/admin/instance", token)).status).toBe(403);
    expect((await request("/admin/instance", json({ values: { title: "x" } }, token))).status).toBe(403);
    const config = await (await as(adminClaims(), "/admin/config")).json<{ values: Record<string, unknown> }>();
    expect(Object.keys(config.values).filter((name) => name in INSTANCE_SETTING_BOUNDS)).toEqual([]);
  });
});

describe("setInstanceSettings", () => {
  it("is refused to every authority but the current Access admin", async () => {
    const s = await store();
    for (const authority of [
      { kind: "import-token" } as const,
      { kind: "import-session", secret: "x".repeat(43) } as const,
      { ...ACCESS, email: "intruder@example.com" },
    ]) {
      expect(await s.setInstanceSettings(BUILD, { authority, values: { title: "x" }, now: NOW })).toMatchObject({
        ok: false,
        code: "wrong-authority",
      });
    }
    // An admin whose email was changed away before the write.
    await setSetting(s, "admin_email", "someone-else@example.com");
    expect(await set(s, { title: "x" })).toMatchObject({ ok: false, code: "wrong-authority" });
    expect(await values(s)).toEqual({});
    expect(await logRows(s)).toEqual([]);
  });

  it("is refused in readonly maintenance and while an import is unpublished", async () => {
    const s = await store();
    await s.setMaintenance(BUILD, true);
    expect(String(await rejectionOf(set(s, { title: "x" })))).toContain("kopje-maintenance");
    await s.setMaintenance(BUILD, false);
    expect(await set(s, { title: "x" })).toMatchObject({ ok: true });

    const source = await store();
    const { text } = await dumpViaRpc(source);
    const target = await store();
    await importViaRpc(target, text);
    expect(String(await rejectionOf(set(target, { title: "x" })))).toContain("kopje-maintenance");
  });

  it("accepts each value at its bound in its unit, and refuses one past it", async () => {
    const s = await store();
    const email = `${"a".repeat(254 - "@example.com".length)}@example.com`;
    expect([ENCODER.encode(DOCUMENT_AT).length, ENCODER.encode(email).length]).toEqual([50_000, 254]);
    const cases: [string, string, string[]][] = [
      ["title", astral.repeat(1024), [astral.repeat(1025)]],
      ["description", astral.repeat(200), [astral.repeat(201)]],
      ["contact_email", email, [`a${email}`, "not an email", "a@b c"]],
      ["extended_description", DOCUMENT_AT, [`${DOCUMENT_AT}a`, "<script>alert(1)</script>", "<p> \v </p>"]],
      ["privacy_policy", DOCUMENT_AT, [`${DOCUMENT_AT}a`, "<p></p>"]],
      ["show_domain_blocks", "all", ["everyone", "All"]],
      ["show_domain_blocks_rationale", "disabled", [""]],
    ];
    for (const [name, at, past] of cases) {
      for (const over of past) {
        expect(await set(s, { [name]: over }), `${name} ${over.slice(0, 20)}`).toMatchObject({
          ok: false,
          code: "invalid-instance-setting",
        });
      }
      expect(await set(s, { [name]: at }), name).toMatchObject({ ok: true });
      expect((await values(s))[name]).toBe(at);
    }
    // The terms of service go with their date: at the bound and one byte past it.
    const date = { terms_of_service_effective_date: "2026-11-01" };
    expect(await set(s, { terms_of_service: `${DOCUMENT_AT}a`, ...date })).toEqual(
      refusal("terms_of_service is at most 50000 bytes of HTML"),
    );
    expect(await set(s, { terms_of_service: DOCUMENT_AT, ...date })).toMatchObject({ ok: true });
    expect(await values(s)).toMatchObject({ terms_of_service: DOCUMENT_AT, ...date });
    expect(await set(s, { terms_of_service: `${DOCUMENT_AT}a` })).toEqual(
      refusal("terms_of_service is at most 50000 bytes of HTML"),
    );
    // Blank (only space, tab, LF, VT, FF and CR) is refused; a Unicode space is text. NUL is removed.
    expect(await set(s, { title: " \t\n\v\f\r" })).toEqual(refusal("title is blank; send null to remove it"));
    expect(await set(s, { title: "　" })).toMatchObject({ ok: true });
    expect(await set(s, { title: "a\u0000b" })).toMatchObject({ ok: true, values: { title: "ab" } });
    for (const bad of [{ rules: "[]" }, { privacy_policy_updated_at: new Date(NOW).toISOString() }, { domain: "x" }]) {
      expect(await set(s, bad)).toMatchObject(refusal(/^unknown setting/));
    }
    expect(await set(s, { title: 3 })).toMatchObject(refusal(/must be a string/));
    expect(await set(s, [] as unknown as Record<string, unknown>)).toMatchObject(refusal(/expected/));
    for (const date of ["2026-02-30", "2026-1-05", "26-01-05", "2026-01-05T00:00"]) {
      expect(await set(s, { terms_of_service: "<p>T</p>", terms_of_service_effective_date: date })).toMatchObject(
        refusal(/YYYY-MM-DD/),
      );
    }
    // A refused request changes nothing, its valid values included.
    const before = await values(s);
    expect(await set(s, { title: "new", description: astral.repeat(201) })).toMatchObject({ ok: false });
    expect(await values(s)).toEqual(before);
  }, 60_000);

  // The terms of service and their date are sent with a valid partner, so either may be accepted alone.
  const PARTNER: Record<string, Record<string, string>> = {
    terms_of_service: { terms_of_service_effective_date: "2026-11-01" },
    terms_of_service_effective_date: { terms_of_service: "<p>Terms</p>" },
  };
  // One value each name accepts, trimmed as stored: the property's examples, which fast-check always runs first.
  const ACCEPTED: [name: (typeof INSTANCE_ADMIN_NAMES)[number], raw: string][] = [
    ["title", " Herd "],
    ["description", "A herd"],
    ["contact_email", " a@example.com "],
    ["contact_username", " alice "],
    ["extended_description", "<p>About</p>"],
    ["privacy_policy", "<p>Policy</p>"],
    ["terms_of_service", "<p>Terms</p>"],
    ["terms_of_service_effective_date", "2026-12-01"],
    ["show_domain_blocks", "users"],
    ["show_domain_blocks_rationale", "all"],
    ["trends", "false"],
    ["trendable_by_default", "true"],
    ["activity_api_enabled", "false"],
  ];

  // Runs one admin write inside the transaction the operation would have, and checks that every stored value is one
  // its name's writer keeps unchanged (the triggers would raise otherwise); a refusal writes nothing.
  function written(sql: SqlStorage, name: string, raw: unknown) {
    const result = setInstanceSettings.run(sql, {
      authority: ACCESS,
      values: { ...PARTNER[name], [name]: raw },
      now: NOW,
    });
    if (result.ok) {
      for (const [stored, value] of Object.entries(result.values)) {
        expect(storedSetting(stored as StoredSettingName, value), stored).toBe(value);
      }
    }
    return result;
  }

  it("accepts a value for each of the thirteen names", async () => {
    expect(ACCEPTED.map(([name]) => name).toSorted()).toEqual([...INSTANCE_ADMIN_NAMES].toSorted());
    const s = await store();
    await seedAccount(s, { username: "alice" });
    await runInDurableObject(s, (_instance, state) => {
      for (const [name, raw] of ACCEPTED) {
        state.storage.transactionSync(() => {
          const result = written(state.storage.sql, name, raw);
          expect(result, name).toMatchObject({ ok: true, values: { [name]: raw.trim() } });
        });
      }
    });
  });

  it("stores only what the stored bounds' writers keep, whatever the input", async () => {
    const s = await store();
    await seedAccount(s, { username: "alice" });
    await seedAccount(s, { username: "bob", domain: "remote.test" });
    await runInDurableObject(s, (_instance, state) => {
      fc.assert(
        fc.property(
          fc.constantFrom(...INSTANCE_ADMIN_NAMES),
          fc.oneof(
            fc.constantFrom("all", "users", "disabled", " a@example.com ", "true", "false", "TRUE", "@Bob@Remote.test"),
            fc.string({ unit: "binary", maxLength: 300 }),
            fc.date({ noInvalidDate: true }).map((d) => d.toISOString().slice(0, 10)),
          ),
          (name, raw) => {
            state.storage.transactionSync(() => {
              written(state.storage.sql, name, raw);
            });
          },
        ),
        { numRuns: 600, examples: ACCEPTED },
      );
    });
  }, 60_000);

  it("keeps the terms of service and their date together on the merged state", async () => {
    const s = await store();
    const terms = async () => {
      const v = await values(s);
      return [v.terms_of_service ?? null, v.terms_of_service_effective_date ?? null];
    };
    expect(await set(s, { terms_of_service: "<p>T1</p>" })).toEqual(
      refusal("terms_of_service needs terms_of_service_effective_date"),
    );
    expect(await set(s, { terms_of_service_effective_date: "2026-11-01" })).toEqual(
      refusal("no terms_of_service to date"),
    );
    expect(
      await set(s, { terms_of_service: "<p>T1</p>", terms_of_service_effective_date: "2026-11-01" }),
    ).toMatchObject({
      ok: true,
    });
    // Text only, with the stored date; the date only, with the stored text.
    expect(await set(s, { terms_of_service: "<p>T2</p>" })).toMatchObject({ ok: true });
    expect(await terms()).toEqual(["<p>T2</p>", "2026-11-01"]);
    expect(await set(s, { terms_of_service_effective_date: "2026-12-01" })).toMatchObject({ ok: true });
    expect(await terms()).toEqual(["<p>T2</p>", "2026-12-01"]);
    expect(await set(s, { terms_of_service_effective_date: null })).toEqual(
      refusal(/cannot be removed while terms_of_service stays/),
    );
    expect(await terms()).toEqual(["<p>T2</p>", "2026-12-01"]);
    // Removing the text removes both, with or without the date named.
    expect(await set(s, { terms_of_service: null })).toMatchObject({ ok: true });
    expect(await terms()).toEqual([null, null]);
    await set(s, { terms_of_service: "<p>T3</p>", terms_of_service_effective_date: "2026-11-01" });
    expect(await set(s, { terms_of_service: null, terms_of_service_effective_date: null })).toMatchObject({ ok: true });
    expect(await terms()).toEqual([null, null]);
  });

  it("stores contact_username as the address of the account it names, or refuses it", async () => {
    const s = await store();
    await setSetting(s, "domain", "kopje.test");
    await seedAccount(s, { username: "alice" });
    await seedAccount(s, { username: "Carol" });
    await seedAccount(s, { username: "bob", domain: "remote.test" });
    const contact = async () => (await values(s)).contact_username;
    for (const [raw, stored] of [
      ["@Alice", "alice"],
      ["alice@kopje.test", "alice"],
      ["alice", "alice"],
      ["carol", "Carol"],
      ["bob@remote.test", "bob@remote.test"],
      ["@BOB@Remote.Test", "bob@remote.test"],
    ] as const) {
      expect(await set(s, { contact_username: raw }), raw).toMatchObject({ ok: true });
      expect(await contact(), raw).toBe(stored);
    }
    const shape = refusal("contact_username must be the address of an account, username or username@domain");
    for (const [raw, refused] of [
      ["nobody", refusal("contact_username names no account")],
      ["alice@elsewhere.test", refusal("contact_username names no account")],
      ["a@b@c", shape],
      ["a b", shape],
      ["alice@", shape],
      ["@", shape],
      ["alice@remote.test:443", shape],
      ["", refusal("contact_username is blank; send null to remove it")],
    ] as const) {
      expect(await set(s, { contact_username: raw }), raw).toEqual(refused);
      expect(await contact(), raw).toBe("bob@remote.test");
    }
    expect(await set(s, { contact_username: null })).toMatchObject({ ok: true });
    expect(await values(s)).not.toHaveProperty("contact_username");
    expect((await logRows(s)).filter((r) => r.target_id === "contact_username").map((r) => r.action)).toEqual([
      "update_setting",
      "update_setting",
      "update_setting",
      "remove_setting",
    ]);
  });

  it("reads the stored username, never its projection, for a converted username past the bound", async () => {
    const s = await store();
    const long = "a".repeat(256);
    // A converted account whose username is past REMOTE_USERNAME_LIMIT, beside one holding its 255-byte prefix.
    await seedAccount(s, { username: "x", domain: "remote.test" });
    await sql(s, "UPDATE accounts SET username = ? WHERE domain = 'remote.test'", long);
    expect(await set(s, { contact_username: `${long}@remote.test` })).toEqual(
      refusal("contact_username must be the address of an account, username or username@domain"),
    );
    expect(await set(s, { contact_username: `${long.slice(1)}@remote.test` })).toEqual(
      refusal("contact_username names no account"),
    );
    await seedAccount(s, { username: long.slice(1), domain: "remote.test" });
    expect(await set(s, { contact_username: `${long}@remote.test` })).toMatchObject({ ok: false });
    expect(await values(s)).not.toHaveProperty("contact_username");
    expect(await set(s, { contact_username: `${long.slice(1)}@remote.test` })).toMatchObject({ ok: true });
    expect((await values(s)).contact_username).toBe(`${long.slice(1)}@remote.test`);
  });

  it("stamps a document when it changes, and only then", async () => {
    const s = await store();
    const later = NOW + 60_000;
    await set(s, { privacy_policy: "<p>v1</p>" });
    const stamp = new Date(NOW).toISOString();
    expect((await values(s)).privacy_policy_updated_at).toBe(stamp);
    const logged = (await logRows(s)).length;
    // Identical: no write, no stamp, no log row.
    expect(await set(s, { privacy_policy: "<p>v1</p>" }, later)).toMatchObject({ ok: true });
    expect((await values(s)).privacy_policy_updated_at).toBe(stamp);
    expect(await logRows(s)).toHaveLength(logged);
    // A converted, unstamped document resubmitted unchanged stays unstamped; an edit stamps it.
    await setSetting(s, "extended_description", "<p>converted</p>");
    await set(s, { extended_description: "<p>converted</p>" }, later);
    expect((await values(s)).extended_description_updated_at).toBeUndefined();
    await set(s, { extended_description: "<p>edited</p>" }, later);
    expect((await values(s)).extended_description_updated_at).toBe(new Date(later).toISOString());
    // Removal removes the stamp.
    await set(s, { privacy_policy: null }, later);
    expect(await values(s)).not.toHaveProperty("privacy_policy_updated_at");
    expect(await values(s)).not.toHaveProperty("privacy_policy");
  });
});

describe("instance settings are data", () => {
  it("make a Store non-empty for an import", async () => {
    const source = await store();
    const { text } = await dumpViaRpc(source);
    const target = await store();
    await setSetting(target, "title", "Already here");
    expect(String(await rejectionOf(importViaRpc(target, text)))).toContain("not-empty");
  });

  it("are dumped and imported with their stamps, the target keeping its configuration, and reset after it", async () => {
    const source = await store();
    await seedAccount(source, { username: "alice" });
    await set(source, {
      title: "Herd",
      description: "A herd",
      contact_email: "herd@example.com",
      extended_description: "<p>About</p>",
      privacy_policy: "<p>Policy</p>",
      terms_of_service: "<p>Terms</p>",
      terms_of_service_effective_date: "2026-11-01",
      show_domain_blocks: "all",
      show_domain_blocks_rationale: "users",
      contact_username: "alice",
    });
    const expected = await values(source);
    expect(Object.keys(expected)).toHaveLength(12);
    const { text } = await dumpViaRpc(source);
    const target = await store();
    await setSetting(target, "domain", "target.example");
    const { id } = await importViaRpc(target, text);
    expect(await values(target)).toEqual(expected);
    expect((await target.config(BUILD)).values).toMatchObject({ domain: "target.example" });
    // A completed, unpublished import is taken back by the cutover reset (import-reset takes back one in progress).
    expect(id).not.toBe("");
    for (;;) {
      const step = await target.cutoverReset(BUILD, ACCESS);
      expect(step, JSON.stringify(step)).toMatchObject({ ok: true });
      if (step.ok && step.done) {
        break;
      }
    }
    expect(await values(target)).toEqual({});
    expect((await target.config(BUILD)).values).toMatchObject({ domain: "target.example" });
  });

  it("are removed by an import-reset of an import in progress", async () => {
    const source = await store();
    await set(source, { title: "Herd", privacy_policy: "<p>Policy</p>" });
    const { text } = await dumpViaRpc(source);
    const target = await store();
    const id = await beginImport(target, text);
    let seq = 0;
    for (const chunk of await importChunks(text, 64 * 1024)) {
      expect(await target.importChunk(BUILD, ACCESS, id, ++seq, chunk)).toMatchObject({ ok: true });
    }
    expect(await sql(target, "SELECT name FROM instance_settings WHERE name = 'title'")).toEqual([{ name: "title" }]);
    expect(await resetImport(target, id)).toMatchObject({ ok: true, done: true });
    expect(await values(target)).toEqual({});
  });
});
