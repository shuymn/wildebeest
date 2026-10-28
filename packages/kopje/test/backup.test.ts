import { Decrypter, Encrypter, generateX25519Identity, identityToRecipient } from "age-encryption";
import { AwsV4Signer } from "aws4fetch";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { run as cliRun } from "../cli/lib/main.js";
import { healthReport } from "../src/app/health";
import {
  type BackupDeps,
  type BackupFaultPoint,
  type BackupManifest,
  MAX_MEDIA_PER_RUN,
  MIN_PART_BYTES,
  runBackup,
  scheduledBackup,
  WORK_BYTES,
} from "../src/jobs/backup";
import { readBackupConfig } from "../src/platform/backup-config";
import { readConfig } from "../src/platform/config";
import type { StoreStub } from "../src/platform/store-client";
import { apiHarness, sql } from "./api-helpers";
import { harness as appHarness } from "./app-helpers";
import { BUILD, LATEST_MIGRATION, migratedStore } from "./helpers";
import { seedEmojiRow } from "./local-emoji-helpers";
import { copyConfig, importViaRpc, memoryIO, seedStore, tableSnapshot } from "./ops-helpers";
import { S3Mock } from "./s3-mock";
import { signatureOf } from "./sigv4";

// The scheduled encrypted backup (DATA-4, DATA-9, DATA-10, OPS-5), against the real Store and an in-memory S3
// that verifies SigV4 signatures.

const identity = await generateX25519Identity();
const recipient = await identityToRecipient(identity);
const otherRecipient = await identityToRecipient(await generateX25519Identity());
const SECRET = "kopje-dummy-s3-secret-0123456789";
const PREFIX = "kopje-backup/";
// 2026-10-13 03:00 UTC; the job's clock. The Store's own dump lease runs on real time.
const NOW = Date.parse("2026-10-13T03:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const ACCOUNT = "110000000000000001";

function backupEnv(overrides: Record<string, string | undefined> = {}): Env {
  return {
    ...env,
    BACKUP_AGE_RECIPIENT: recipient,
    BACKUP_S3_ENDPOINT: "https://s3.test",
    BACKUP_S3_BUCKET: "kopje-backups",
    BACKUP_S3_ACCESS_KEY_ID: "AKIDKOPJETEST",
    BACKUP_S3_SECRET_ACCESS_KEY: SECRET,
    ...overrides,
  } as unknown as Env;
}

type Harness = {
  store: StoreStub;
  s3: S3Mock;
  env: Env;
  clock: { now: number };
  logs: Record<string, unknown>[];
  faults: Map<BackupFaultPoint, number>;
  run(extra?: Partial<BackupDeps>): Promise<string>;
};

async function harness(options: { env?: Env; seed?: boolean } = {}): Promise<Harness> {
  const store = await migratedStore();
  if (options.seed !== false) {
    await seedStore(store, 20);
  }
  const s3 = new S3Mock();
  const clock = { now: NOW };
  const logs: Record<string, unknown>[] = [];
  // A fault fires once when its count reaches zero: n = 0 crashes the first time the point is reached.
  const faults = new Map<BackupFaultPoint, number>();
  const h: Harness = {
    store,
    s3,
    env: options.env ?? backupEnv(),
    clock,
    logs,
    faults,
    run: (extra = {}) =>
      runBackup(h.env, {
        build: () => BUILD,
        store: () => store,
        now: () => clock.now,
        fetch: s3.fetch,
        log: (entry) => logs.push(entry),
        partBytes: MIN_PART_BYTES,
        chunkBytes: 256 * 1024,
        sleep: async () => {},
        inject: (point) => {
          const left = faults.get(point);
          if (left === undefined) {
            return;
          }
          if (left === 0) {
            faults.delete(point);
            throw new Error(`crash at ${point}`);
          }
          faults.set(point, left - 1);
        },
        ...extra,
      }),
  };
  return h;
}

async function decrypt(bytes: Uint8Array | undefined, who = identity): Promise<Uint8Array> {
  expect(bytes).toBeDefined();
  const d = new Decrypter();
  d.addIdentity(who);
  return d.decrypt(bytes!);
}

async function encrypt(bytes: Uint8Array): Promise<Uint8Array> {
  const e = new Encrypter();
  e.addRecipient(recipient);
  return e.encrypt(bytes);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

async function backupState(store: StoreStub) {
  return store.backupState(BUILD);
}

// The manifest the Store recorded as the last success, checked against its recorded digest (DATA-10).
async function recordedManifest(h: Harness, who = identity): Promise<BackupManifest> {
  const success = (await backupState(h.store)).lastSuccess;
  expect(success).not.toBeNull();
  const bytes = h.s3.objects.get(success!.manifest)!;
  expect(await sha256Hex(bytes)).toBe(success!.manifestSha256);
  return JSON.parse(new TextDecoder().decode(await decrypt(bytes, who))) as BackupManifest;
}

type IndexEntry = {
  source: string;
  state: string;
  key?: string;
  size?: number;
  sha256?: string;
  plaintext?: { size: number; sha256: string };
  run?: string;
};

async function checked(h: Harness, object: { key: string; size: number; sha256: string }): Promise<Uint8Array> {
  const ciphertext = h.s3.objects.get(object.key);
  expect(ciphertext, object.key).toBeDefined();
  expect({ size: ciphertext!.byteLength, sha256: await sha256Hex(ciphertext!) }).toEqual({
    size: object.size,
    sha256: object.sha256,
  });
  return ciphertext!;
}

// The restore path (docs/backup.md): the recorded manifest, then the dump and the media index against it, then every
// copied original against the index. Returns the dump text and the index.
async function restore(
  h: Harness,
  who = identity,
): Promise<{ text: string; index: IndexEntry[]; manifest: BackupManifest }> {
  const manifest = await recordedManifest(h, who);
  const plaintext = await decrypt(await checked(h, manifest.dump), who);
  expect({ size: plaintext.byteLength, sha256: await sha256Hex(plaintext) }).toEqual(manifest.dump.plaintext);
  const indexBytes = await decrypt(await checked(h, manifest.mediaIndex), who);
  expect({ size: indexBytes.byteLength, sha256: await sha256Hex(indexBytes) }).toEqual(manifest.mediaIndex.plaintext);
  const index = JSON.parse(new TextDecoder().decode(indexBytes)) as { run: string; objects: IndexEntry[] };
  expect(index.run).toBe(manifest.id);
  for (const entry of index.objects.filter((e) => e.state === "copied")) {
    const original = await decrypt(await checked(h, entry as Required<IndexEntry>), who);
    expect({ size: original.byteLength, sha256: await sha256Hex(original) }).toEqual(entry.plaintext);
  }
  return { text: new TextDecoder().decode(plaintext), index: index.objects, manifest };
}

function snowflake(ms: number, n = 0): string {
  return ((BigInt(ms) << 16n) | BigInt(n)).toString();
}

// A completed local upload: its row and (unless `inR2` is false) its original in R2.
async function addMedia(store: StoreStub, id: string, bytes: Uint8Array, inR2 = true): Promise<string> {
  await runInDurableObject(store, (_instance, state) => {
    state.storage.sql.exec(
      `INSERT INTO media_attachments (id, account_id, type, url, file_token, content_type, processed)
			 VALUES (?, ?, 'image', ?, ?, 'image/jpeg', 1)`,
      id,
      ACCOUNT,
      `https://kopje.test/media/${id}`,
      `token-${id}-0123456789abcdef0123`,
    );
  });
  if (inR2) {
    await env.MEDIA.put(`originals/${id}`, bytes);
  }
  return `originals/${id}`;
}

async function clearOriginals(): Promise<void> {
  const listing = await env.MEDIA.list({ prefix: "originals/" });
  await Promise.all(listing.objects.map((o) => env.MEDIA.delete(o.key)));
}

function withoutState(snapshot: Record<string, string[]>): Record<string, string[]> {
  const { kopje_state: _state, backup_media: _media, ...rest } = snapshot;
  return rest;
}

// Rows big enough that the dump spans several 5 MiB parts.
async function addLargeRows(store: StoreStub, rows: number, bytes: number): Promise<void> {
  await runInDurableObject(store, (_instance, state) => {
    for (let i = 0; i < rows; i++) {
      state.storage.sql.exec(
        `INSERT INTO statuses (id, uri, account_id, visibility, search_text, published_at) VALUES (?, ?, ?, 'public', ?, ?)`,
        String(120_000_000_000_000_000n + BigInt(i)),
        `https://kopje.test/ap/o/large-${i}`,
        ACCOUNT,
        `large ${i} ${"kopje-plaintext-marker ".repeat(Math.ceil(bytes / 23))}`.slice(0, bytes),
        "2026-10-12T00:00:00.000Z",
      );
    }
  });
}

async function frozen(store: StoreStub): Promise<boolean> {
  return (await store.health(BUILD)).dump !== null;
}

const JOB_RPCS = [
  "backupState",
  "backupClaim",
  "backupSave",
  "backupFinishDump",
  "backupMedia",
  "backupRecord",
  "backupCoverage",
  "dumpStart",
  "dumpNext",
  "dumpFinish",
  "dumpAbort",
] as const;

// The Store RPCs the job calls, each passed through `wrap`.
function wrapStore(
  store: StoreStub,
  wrap: (name: string, call: () => Promise<unknown>) => Promise<unknown>,
): StoreStub {
  const wrapped: Record<string, unknown> = {};
  for (const name of JOB_RPCS) {
    wrapped[name] = (...args: unknown[]) =>
      wrap(name, () => (store[name] as (...a: unknown[]) => Promise<unknown>)(...args));
  }
  return wrapped as unknown as StoreStub;
}

// A Store whose named RPCs commit and then lose their answer (throw), `times` times each.
function lossy(store: StoreStub, faults: Record<string, number>): StoreStub {
  return wrapStore(store, async (name, call) => {
    const result = await call();
    if ((faults[name] ?? 0) > 0) {
      faults[name]!--;
      throw new Error(`lost answer of ${name}`);
    }
    return result;
  });
}

function keysUnder(h: Harness, prefix: string): string[] {
  return [...h.s3.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
}

beforeEach(clearOriginals);
afterEach(clearOriginals);

describe("backup configuration", () => {
  it("does no work and says so when enabled but not configured", async () => {
    const h = await harness({ env: backupEnv({ BACKUP_S3_SECRET_ACCESS_KEY: undefined, BACKUP_S3_BUCKET: "" }) });
    expect(await h.run()).toBe("not-configured");
    expect(h.s3.requests).toEqual([]);
    expect((await backupState(h.store)).run).toBeNull();

    const report = await healthReport(BUILD, readConfig(h.env), () => h.store, {
      checkKeys: false,
      backup: readBackupConfig(h.env),
    });
    expect(report.checks.backup).toEqual({
      ok: true,
      state: "not-configured",
      missing: ["BACKUP_S3_BUCKET", "BACKUP_S3_SECRET_ACCESS_KEY"],
      warning: expect.stringContaining("not configured"),
    });
  });

  it("is off only with BACKUP_ENABLED=false, and refuses invalid settings without naming their values", async () => {
    expect(readBackupConfig(backupEnv({ BACKUP_ENABLED: "false" }))).toEqual({ state: "disabled" });
    const h = await harness({ env: backupEnv({ BACKUP_ENABLED: "false" }) });
    expect(await h.run()).toBe("disabled");
    expect(h.s3.requests).toEqual([]);

    const invalid = backupEnv({
      BACKUP_AGE_RECIPIENT: "AGE-SECRET-KEY-1NOTAPUBLICKEY",
      BACKUP_S3_ENDPOINT: `http://user:${SECRET}@s3.test/path`,
      BACKUP_S3_PREFIX: "../escape/",
      BACKUP_RETENTION: "0",
    });
    const result = readBackupConfig(invalid);
    expect(result.state).toBe("invalid");
    const text = JSON.stringify(result);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("AGE-SECRET-KEY");
    expect(result).toMatchObject({
      issues: [
        expect.stringMatching(/^BACKUP_AGE_RECIPIENT/),
        expect.stringMatching(/^BACKUP_S3_ENDPOINT/),
        expect.stringMatching(/^BACKUP_S3_PREFIX/),
        expect.stringMatching(/^BACKUP_RETENTION/),
      ],
    });
  });

  it("starts nothing while a verified import is unpublished, and runs once it is published (OPS-8)", async () => {
    const h = await harness();
    const flag = (value: string | null) =>
      runInDurableObject(h.store, (_instance, state) => {
        if (value === null) {
          state.storage.sql.exec("DELETE FROM kopje_state WHERE name = 'unpublished'");
        } else {
          state.storage.sql.exec("INSERT OR REPLACE INTO kopje_state (name, value) VALUES ('unpublished', ?)", value);
        }
      });
    await flag(JSON.stringify({ at: NOW, import: "import-1" }));
    const calls: string[] = [];
    const deps = {
      build: () => BUILD,
      store: () => h.store,
      now: () => NOW,
      fetch: (request: Request) => {
        calls.push(request.url);
        return h.s3.fetch(request);
      },
    };
    expect(await scheduledBackup(h.env, deps)).toBe("unpublished");
    // No S3 call, no runner lease, no dump freeze.
    expect(calls).toEqual([]);
    expect((await backupState(h.store)).runner).toBeNull();
    expect((await h.store.health(BUILD)).dump).toBeNull();

    await flag(null);
    expect(await scheduledBackup(h.env, deps)).toBe("done");
    expect(calls.length).toBeGreaterThan(0);
  });

  it("skips under env maintenance, like the other scheduled jobs", async () => {
    const h = await harness({ env: backupEnv({ MAINTENANCE: "readonly" }) });
    const outcome = await scheduledBackup(h.env, {
      build: () => BUILD,
      store: () => h.store,
      now: () => NOW,
      fetch: h.s3.fetch,
    });
    expect(outcome).toBeNull();
    expect(h.s3.requests).toEqual([]);
  });
});

describe("backup run", () => {
  // Every custom emoji's original, enabled or disabled, is in the backup (MEDIA-5: never deleted, so always required).
  it("copies the originals of enabled and disabled custom emoji", async () => {
    const h = await harness();
    const [owner] = await sql<{ id: string }>(h.store, "SELECT account_id AS id FROM local_accounts LIMIT 1");
    const emoji = [
      await seedEmojiRow(h.store, { id: snowflake(NOW - 2 * DAY, 5), shortcode: "on", owner: owner!.id }),
      await seedEmojiRow(h.store, {
        id: snowflake(NOW - 2 * DAY, 6),
        shortcode: "off",
        owner: owner!.id,
        disabled: true,
      }),
    ];
    for (const { id } of emoji) {
      await env.MEDIA.put(`originals/${id}`, new Uint8Array([1, 2, 3]));
    }
    expect(await h.run()).toBe("done");
    const { index } = await restore(h);
    for (const { id } of emoji) {
      expect(index).toContainEqual(expect.objectContaining({ source: `originals/${id}`, state: "copied" }));
    }
  });

  it("writes the dump, the originals the dump references, the complete media index and the manifest last (DATA-4, DATA-10)", async () => {
    const h = await harness();
    const photo = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3, ...new TextEncoder().encode("exif-location-marker")]);
    const present = await addMedia(h.store, snowflake(NOW - 2 * DAY), photo);
    // Referenced by the dump but gone from R2.
    const gone = await addMedia(h.store, snowflake(NOW - 2 * DAY, 1), new Uint8Array(), false);
    // In R2 without a completed upload: not referenced, not copied.
    await env.MEDIA.put(`originals/${snowflake(NOW - DAY)}`, new Uint8Array([7]));

    expect(await h.run()).toBe("done");

    const { text, index, manifest } = await restore(h);
    expect(manifest).toMatchObject({
      format: "kopje-backup",
      version: 1,
      id: expect.stringMatching(/^2026-10-13-[0-9a-f]{8}$/),
      createdAt: new Date(NOW).toISOString(),
      kopje: { version: expect.any(String), build: BUILD },
      schema: { version: LATEST_MIGRATION },
      recipients: [recipient],
      media: { required: 2, copied: 1, pending: 0, absent: 1 },
    });
    const base = `${PREFIX}backups/${manifest.id}/${manifest.attempt}/`;
    expect(manifest.dump.key).toBe(`${base}dump.kopje.age`);
    expect(manifest.mediaIndex.key).toBe(`${base}media-index.json.age`);
    expect(keysUnder(h, `${PREFIX}backups/`)).toEqual(
      [`${base}dump.kopje.age`, `${base}manifest.json.age`, `${base}media-index.json.age`].sort(),
    );
    expect(index).toEqual([
      {
        source: present,
        state: "copied",
        key: `${PREFIX}media/${manifest.id}/${manifest.attempt}/${present}.age`,
        size: expect.any(Number),
        sha256: expect.any(String),
        plaintext: { size: photo.byteLength, sha256: await sha256Hex(photo) },
        run: manifest.id,
      },
      { source: gone, state: "absent" },
    ]);
    expect(keysUnder(h, `${PREFIX}media/`)).toEqual([index[0]!.key]);
    // The manifest is the last object written.
    expect(h.s3.requests.filter((r) => r.op === "put" || r.op === "complete-upload").at(-1)?.key).toBe(
      `${base}manifest.json.age`,
    );
    expect(text.startsWith("-- kopje-dump-header ")).toBe(true);
    expect(text.endsWith("-- kopje-dump-end\n")).toBe(true);

    // DATA-4: nothing the bucket received is plaintext.
    for (const body of h.s3.received) {
      const decoded = new TextDecoder().decode(body);
      expect(decoded.startsWith("age-encryption.org/v1\n")).toBe(true);
      for (const marker of ["kopje-dump-header", "exif-location-marker", "kopje-backup", "bulk 1 ", "originals/"]) {
        expect(decoded).not.toContain(marker);
      }
    }
    // Nothing is deleted from R2.
    expect((await env.MEDIA.list({ prefix: "originals/" })).objects).toHaveLength(2);
    expect(await backupState(h.store)).toMatchObject({
      runner: null,
      run: null,
      lastSuccess: { id: manifest.id, at: NOW, coverage: { copied: 1, absent: 1 } },
      lastFailure: null,
    });
    expect(await frozen(h.store)).toBe(false);

    // Once a day. The next day copies only what is new, and its index still lists every original the dump needs.
    expect(await h.run()).toBe("not-due");
    const later = await addMedia(h.store, snowflake(NOW), new Uint8Array([4, 5]));
    h.clock.now = NOW + DAY;
    const puts = h.s3.count("put");
    expect(await h.run()).toBe("done");
    expect(h.s3.count("put")).toBe(puts + 2); // the new original and the manifest
    const next = await restore(h);
    expect(next.index.map((e) => [e.source, e.state])).toEqual([
      [present, "copied"],
      [gone, "absent"],
      [later, "copied"],
    ]);
    expect(next.index[0]!.key).toBe(index[0]!.key);
  });

  it("waits for BACKUP_HOUR_UTC, and never reuses a day that already has a backup when the clock goes back", async () => {
    const h = await harness({ env: backupEnv({ BACKUP_HOUR_UTC: "4" }) });
    expect(await h.run()).toBe("not-due");
    h.clock.now = NOW + 60 * MINUTE;
    expect(await h.run()).toBe("done");
    h.clock.now = NOW - DAY + 2 * 60 * MINUTE;
    expect(await h.run()).toBe("not-due");
    h.clock.now = NOW + DAY + 60 * MINUTE;
    expect(await h.run()).toBe("done");
  });

  it("round-trips a dump larger than one part: dump, encrypt, decrypt, import, same data (DATA-10)", async () => {
    const h = await harness();
    // About 12 MiB of rows: three parts of at least 5 MiB except the last (the mock enforces S3's rule).
    await addLargeRows(h.store, 8, 1536 * 1024);
    expect(await h.run()).toBe("done");
    expect(h.s3.count("upload-part")).toBeGreaterThanOrEqual(3);
    const { text } = await restore(h);
    expect(h.s3.received.some((b) => new TextDecoder().decode(b).includes("kopje-plaintext-marker"))).toBe(false);

    const target = await migratedStore();
    await copyConfig(h.store, target);
    const { report } = await importViaRpc(target, text, 4 * 1024 * 1024);
    expect(report).toMatchObject({ ok: true, foreignKeyViolations: 0, problems: [] });
    expect(withoutState(await tableSnapshot(target))).toEqual(withoutState(await tableSnapshot(h.store)));
  }, 30_000);

  it("ends the freeze as soon as the last chunk is read, before the remaining parts are uploaded", async () => {
    const h = await harness();
    await addLargeRows(h.store, 8, 1536 * 1024);
    let lastChunkRead = false;
    const store = wrapStore(h.store, async (name, call) => {
      const result = await call();
      if (name === "dumpNext") {
        const step = result as { ok: boolean; done?: boolean };
        lastChunkRead ||= step.ok && step.done === true;
      }
      return result;
    });
    const frozenDuringUpload: boolean[] = [];
    h.s3.before = async (op) => {
      if (lastChunkRead && (op === "upload-part" || op === "complete-upload")) {
        frozenDuringUpload.push(await frozen(h.store));
      }
    };
    expect(await h.run({ store: () => store })).toBe("done");
    expect(frozenDuringUpload.length).toBeGreaterThan(0);
    expect(frozenDuringUpload).not.toContain(true);
  }, 30_000);
});

describe("backup fencing (OPS-5)", () => {
  it("a runner that lost its lease mid-PUT cannot change the backup another runner recorded", async () => {
    const h = await harness();
    await addMedia(h.store, snowflake(NOW - DAY), new Uint8Array([1, 2, 3]));
    // A stops in the middle of its manifest PUT, until past its lease.
    let releaseA: () => void = () => {};
    const held = new Promise<void>((resolve) => (releaseA = resolve));
    let holding = true;
    h.s3.before = async (op, key) => {
      if (holding && op === "put" && key?.endsWith("manifest.json.age") === true) {
        holding = false;
        await held;
      }
    };
    const clockA = { now: NOW };
    const a = h.run({ now: () => clockA.now });
    while (holding) {
      await new Promise((r) => setTimeout(r, 1));
    }
    clockA.now = NOW + 16 * MINUTE;
    // B (a later cron) takes the run over and finishes it.
    h.clock.now = NOW + 16 * MINUTE;
    expect(await h.run()).toBe("done");
    const recorded = await restore(h);
    releaseA();
    expect(await a).toBe("busy");
    // A's late PUT landed under A's own name; B's recorded backup is unchanged.
    const again = await restore(h);
    expect(again.manifest).toEqual(recorded.manifest);
    expect(keysUnder(h, `${PREFIX}backups/`).filter((k) => k.endsWith("manifest.json.age"))).toHaveLength(2);
  });

  it("a runner with a skewed clock that takes over early leaves the first runner unable to record anything", async () => {
    const h = await harness();
    for (const n of [1, 2, 3]) {
      await addMedia(h.store, snowflake(NOW - DAY, n), new TextEncoder().encode(`original ${n}`));
    }
    // A is between two media copies when B, whose clock runs 16 minutes ahead, claims the run.
    let releaseA: () => void = () => {};
    const held = new Promise<void>((resolve) => (releaseA = resolve));
    let puts = 0;
    let waiting = false;
    h.s3.before = async (op) => {
      if (op === "put" && ++puts === 2) {
        waiting = true;
        await held;
      }
    };
    const a = h.run();
    while (!waiting) {
      await new Promise((r) => setTimeout(r, 1));
    }
    expect(await h.run({ now: () => NOW + 16 * MINUTE })).toBe("done");
    const recorded = await restore(h);
    releaseA();
    expect(await a).toBe("busy");
    expect((await restore(h)).manifest).toEqual(recorded.manifest);
    expect(recorded.index.map((e) => e.state)).toEqual(["copied", "copied", "copied"]);
  });
});

describe("backup resumption (OPS-5)", () => {
  it("restarts a dump that died mid-dump: the freeze and the upload are released, the next run completes", async () => {
    const h = await harness();
    await addLargeRows(h.store, 8, 1536 * 1024);
    h.faults.set("dump-chunk", 3);
    await expect(h.run()).rejects.toThrow("crash at dump-chunk");
    // The dead invocation left the Store frozen (until its lease) and an upload open.
    expect(await frozen(h.store)).toBe(true);
    expect(h.s3.uploads.size).toBe(1);

    h.clock.now += 16 * MINUTE;
    expect(await h.run()).toBe("done");
    expect(h.s3.uploads.size).toBe(0);
    expect(await frozen(h.store)).toBe(false);
    await restore(h);
  }, 30_000);

  it("restarts a dump that died after some parts were uploaded", async () => {
    const h = await harness();
    await addLargeRows(h.store, 8, 1536 * 1024);
    h.faults.set("dump-part", 1);
    await expect(h.run()).rejects.toThrow("crash at dump-part");
    const saved = (await backupState(h.store)).run;
    expect(saved?.dump).toMatchObject({ parts: 2, uploadId: expect.any(String) });
    const dead = saved!.dump!.uploadId!;
    expect(h.s3.uploads.get(dead)?.parts.size).toBe(2);

    h.clock.now += 16 * MINUTE;
    expect(await h.run()).toBe("done");
    expect(h.s3.uploads.has(dead)).toBe(false);
    expect(await frozen(h.store)).toBe(false);
    const target = await migratedStore();
    await copyConfig(h.store, target);
    const { report } = await importViaRpc(target, (await restore(h)).text, 4 * 1024 * 1024);
    expect(report).toMatchObject({ ok: true });
  }, 30_000);

  for (const point of ["dump-complete", "media-copied", "index-stage", "manifest-stage", "manifest-written"] as const) {
    it(`resumes after dying at ${point}`, async () => {
      const h = await harness();
      await addMedia(h.store, snowflake(NOW - DAY), new Uint8Array([1, 2, 3]));
      h.faults.set(point, 0);
      await expect(h.run()).rejects.toThrow(`crash at ${point}`);
      h.clock.now += 16 * MINUTE;
      expect(await h.run()).toBe("done");
      const { index } = await restore(h);
      expect(index.map((e) => e.state)).toEqual(["copied"]);
      expect(h.s3.uploads.size).toBe(0);
    });
  }

  it("does not dump again when it resumes before the manifest", async () => {
    const h = await harness();
    h.faults.set("manifest-stage", 0);
    await expect(h.run()).rejects.toThrow("crash at manifest-stage");
    const dumps = h.s3.requests.filter((r) => r.op === "create-upload" && r.key?.endsWith("dump.kopje.age")).length;
    h.clock.now += 16 * MINUTE;
    expect(await h.run()).toBe("done");
    expect(h.s3.requests.filter((r) => r.op === "create-upload" && r.key?.endsWith("dump.kopje.age"))).toHaveLength(
      dumps,
    );
  });

  it("gives up on a run after three deaths and records it", async () => {
    const h = await harness();
    for (let i = 0; i < 3; i++) {
      h.faults.set("manifest-stage", 0);
      await expect(h.run()).rejects.toThrow("crash at manifest-stage");
      h.clock.now += 16 * MINUTE;
    }
    expect(await h.run()).toBe("failed");
    expect((await backupState(h.store)).lastFailure).toMatchObject({ reason: "interrupted", stage: "manifest" });
    // After the retry delay the run continues where it was.
    h.clock.now += 61 * MINUTE;
    expect(await h.run()).toBe("done");
  });

  it("releases the freeze when dumpStart committed but its answer was lost", async () => {
    const h = await harness();
    const store = lossy(h.store, { dumpStart: 1 });
    expect(await h.run({ store: () => store })).toBe("failed");
    expect(await frozen(h.store)).toBe(false);
    expect((await backupState(h.store)).lastFailure?.reason).toBe("store-unavailable");
  });

  it("keeps the handles when the cleanup itself fails, and the next run releases them", async () => {
    const h = await harness();
    await addLargeRows(h.store, 8, 1536 * 1024);
    h.s3.fail = (op) => (op === "upload-part" ? 500 : undefined);
    const store = lossy(h.store, { dumpAbort: 1 });
    // The abort committed but its answer was lost: the run keeps the opId.
    expect(await h.run({ store: () => store })).toBe("failed");
    expect((await backupState(h.store)).run?.dump).toMatchObject({ opId: expect.any(String) });
    h.s3.fail = undefined;
    h.clock.now += 61 * MINUTE;
    expect(await h.run()).toBe("done");
    expect(await frozen(h.store)).toBe(false);
  }, 30_000);

  it("recovers when a save committed but its answer was lost", async () => {
    const h = await harness();
    await addMedia(h.store, snowflake(NOW - DAY), new Uint8Array([1]));
    const store = lossy(h.store, { backupSave: 1 });
    expect(await h.run({ store: () => store })).toBe("failed");
    expect(await frozen(h.store)).toBe(false);
    h.clock.now += 61 * MINUTE;
    expect(await h.run()).toBe("done");
    await restore(h);
  });
});

describe("backup deadline", () => {
  it("pauses media copying near the invocation deadline and continues at the next cron", async () => {
    const h = await harness();
    for (const n of [1, 2, 3, 4]) {
      await addMedia(h.store, snowflake(NOW - DAY, n), new TextEncoder().encode(`original ${n}`));
    }
    // Each media PUT takes 5 minutes of the 13-minute invocation.
    h.s3.before = async (op, key) => {
      if (op === "put" && key?.includes("/media/") === true) {
        h.clock.now += 5 * MINUTE;
      }
    };
    expect(await h.run()).toBe("paused");
    expect((await backupState(h.store)).run).toMatchObject({ stage: "media", copied: 3 });
    expect((await backupState(h.store)).runner).toBeNull();
    expect(await h.run()).toBe("done");
    expect((await restore(h)).index.map((e) => e.state)).toEqual(["copied", "copied", "copied", "copied"]);
  });

  it("never encrypts past the byte budget: media waits for the next cron (plaintext bytes are counted)", async () => {
    expect(WORK_BYTES).toBe(512 * 1024 * 1024);
    const h = await harness();
    for (const n of [1, 2, 3]) {
      await addMedia(h.store, snowflake(NOW - DAY, n), new Uint8Array(1000));
    }
    // The first invocation runs out of time at its first media copy, after the dump.
    h.s3.before = async (op, key) => {
      if (op === "put" && key?.includes("/media/") === true) {
        h.s3.before = undefined;
        h.clock.now += 13 * MINUTE;
      }
    };
    expect(await h.run()).toBe("paused");
    h.clock.now += 16 * MINUTE;
    // 1,500 bytes: one 1,000-byte original fits, the second would cross the budget, so it is not even read.
    expect(await h.run({ workBytes: 1500 })).toBe("paused");
    expect((await backupState(h.store)).run).toMatchObject({ stage: "media", copied: 2 });
    expect(await h.run()).toBe("done");
  });

  it("fails a dump larger than the byte budget as dump-too-large, and releases the freeze", async () => {
    const h = await harness();
    expect(await h.run({ workBytes: 1000 })).toBe("failed");
    expect((await backupState(h.store)).lastFailure?.reason).toBe("dump-too-large");
    expect(await frozen(h.store)).toBe(false);
    expect(h.s3.uploads.size).toBe(0);
  });

  it("fails as dump-too-large when the budget is crossed after parts were uploaded", async () => {
    const h = await harness();
    await addLargeRows(h.store, 8, 1536 * 1024);
    expect(await h.run({ workBytes: 7 * 1024 * 1024 })).toBe("failed");
    expect((await backupState(h.store)).lastFailure?.reason).toBe("dump-too-large");
    expect(h.s3.requests.filter((r) => r.op === "upload-part" && r.status === 200).length).toBeGreaterThan(0);
    expect(h.s3.uploads.size).toBe(0);
    expect(await frozen(h.store)).toBe(false);
  }, 30_000);

  // The plaintext sizes of a reference run; the same seed gives the same sizes (the ids in names have fixed lengths).
  async function sizes(): Promise<{ dump: number; index: number }> {
    const h = await harness();
    await addMedia(h.store, snowflake(NOW - DAY), new Uint8Array(1000));
    expect(await h.run()).toBe("done");
    const manifest = await recordedManifest(h);
    await clearOriginals();
    return { dump: manifest.dump.plaintext.size, index: manifest.mediaIndex.plaintext.size };
  }

  it("completes a dump of exactly the budget, and refuses one byte less", async () => {
    const { dump } = await sizes();
    const exact = await harness();
    await addMedia(exact.store, snowflake(NOW - DAY), new Uint8Array(1000), false);
    expect(await exact.run({ workBytes: dump })).not.toBe("failed");
    expect((await backupState(exact.store)).lastFailure).toBeNull();
    const short = await harness();
    await addMedia(short.store, snowflake(NOW - DAY), new Uint8Array(1000), false);
    expect(await short.run({ workBytes: dump - 1 })).toBe("failed");
    expect((await backupState(short.store)).lastFailure?.reason).toBe("dump-too-large");
  });

  it("pauses an index that exceeds what is left of the budget, and completes it with the same budget", async () => {
    const { dump, index } = await sizes();
    const h = await harness();
    await addMedia(h.store, snowflake(NOW - DAY), new Uint8Array(1000));
    const budget = dump + 1000 + index - 1;
    expect(await h.run({ workBytes: budget })).toBe("paused");
    expect((await backupState(h.store)).run).toMatchObject({ stage: "index", copied: 1 });
    expect(h.s3.uploads.size).toBe(0);
    expect(await h.run({ workBytes: budget })).toBe("done");
    expect((await restore(h)).index.map((e) => e.state)).toEqual(["copied"]);
  });

  it("fails an index larger than a whole invocation budget as index-too-large", async () => {
    const h = await harness();
    await addMedia(h.store, snowflake(NOW - DAY), new Uint8Array([1]));
    h.faults.set("index-stage", 0);
    await expect(h.run()).rejects.toThrow("crash at index-stage");
    h.clock.now += 16 * MINUTE;
    expect(await h.run({ workBytes: 10 })).toBe("failed");
    expect((await backupState(h.store)).lastFailure?.reason).toBe("index-too-large");
  });

  it("cancels a request that never answers when the time left runs out", async () => {
    const h = await harness();
    h.s3.hang = (op) => (op === "create-upload" ? "request" : undefined);
    // 200 ms of request time beyond the reserve.
    expect(await h.run({ invocationMs: 60_000 + 200 })).toBe("failed");
    expect(h.s3.aborted).toEqual(["create-upload"]);
    expect((await backupState(h.store)).lastFailure?.reason).toBe("s3-create-upload-timeout");
    expect(await frozen(h.store)).toBe(false);
  });

  it("cancels a response body that stalls when the time left runs out", async () => {
    const h = await harness();
    h.s3.hang = (op) => (op === "list" ? "body" : undefined);
    expect(await h.run({ invocationMs: 60_000 + 200 })).toBe("done");
    expect(h.s3.aborted).toEqual(["list"]);
    expect((await backupState(h.store)).retentionFailure?.reason).toBe("s3-list-timeout");
  });

  it("bounds a request by the time left: a dump that runs out of time fails and releases the freeze", async () => {
    const h = await harness();
    await addLargeRows(h.store, 8, 1536 * 1024);
    h.s3.before = async (op) => {
      if (op === "upload-part") {
        h.clock.now += 7 * MINUTE;
      }
    };
    expect(await h.run()).toBe("failed");
    expect((await backupState(h.store)).lastFailure?.reason).toBe("s3-upload-part-timeout");
    expect(await frozen(h.store)).toBe(false);
  }, 30_000);
});

describe("backup destination and recipients", () => {
  it("abandons a run whose bucket changed, and copies every original to the new bucket", async () => {
    const h = await harness();
    for (const n of [1, 2]) {
      await addMedia(h.store, snowflake(NOW - DAY, n), new TextEncoder().encode(`original ${n}`));
    }
    // The first destination takes a full backup.
    expect(await h.run()).toBe("done");
    // A second run is cut off in its media stage; then the operator moves the backups to another prefix.
    await addMedia(h.store, snowflake(NOW, 3), new TextEncoder().encode("original 3"));
    h.clock.now = NOW + DAY;
    h.faults.set("media-copied", 0);
    await expect(h.run()).rejects.toThrow("crash at media-copied");
    h.env = backupEnv({ BACKUP_S3_PREFIX: "moved/" });
    h.clock.now += 16 * MINUTE;
    expect(await h.run()).toBe("done");
    expect(h.logs).toContainEqual(expect.objectContaining({ event: "kopje.backup.abandoned" }));

    const { index, manifest } = await restore(h);
    expect(manifest.dump.key.startsWith("moved/backups/")).toBe(true);
    expect(index.map((e) => [e.state, e.key?.startsWith("moved/media/")])).toEqual([
      ["copied", true],
      ["copied", true],
      ["copied", true],
    ]);
  });

  const COMPONENTS: [string, Record<string, string>][] = [
    ["endpoint", { BACKUP_S3_ENDPOINT: "https://s3-other.test" }],
    ["bucket", { BACKUP_S3_BUCKET: "other-bucket" }],
    ["region", { BACKUP_S3_REGION: "eu-west-1" }],
    ["prefix", { BACKUP_S3_PREFIX: "moved/" }],
    ["recipients", { BACKUP_AGE_RECIPIENT: otherRecipient }],
  ];
  for (const [component, overrides] of COMPONENTS) {
    it(`abandons a run when only its ${component} changes`, async () => {
      const h = await harness();
      h.faults.set("index-stage", 0);
      await expect(h.run()).rejects.toThrow("crash at index-stage");
      const before = (await backupState(h.store)).run!.id;
      h.env = backupEnv(overrides);
      h.clock.now += 16 * MINUTE;
      await h.run();
      expect(h.logs).toContainEqual(expect.objectContaining({ event: "kopje.backup.abandoned", id: before }));
      const after = await backupState(h.store);
      expect(after.lastSuccess?.id ?? after.run?.id).not.toBe(before);
    });
  }

  it("abandons a run whose recipients changed, so nothing of it is encrypted to the old key", async () => {
    const h = await harness();
    await addMedia(h.store, snowflake(NOW - DAY), new Uint8Array([1, 2]));
    h.faults.set("index-stage", 0);
    await expect(h.run()).rejects.toThrow("crash at index-stage");
    const other = await generateX25519Identity();
    h.env = backupEnv({ BACKUP_AGE_RECIPIENT: await identityToRecipient(other) });
    h.clock.now += 16 * MINUTE;
    expect(await h.run()).toBe("done");
    const { manifest, index } = await restore(h, other);
    expect(manifest.recipients).toEqual([await identityToRecipient(other)]);
    expect(index.map((e) => e.state)).toEqual(["copied"]);
  });
});

describe("backupFinishDump (OPS-5)", () => {
  const LEASE = 15 * MINUTE;

  async function membership(store: StoreStub): Promise<string[]> {
    return runInDurableObject(store, (_instance, state) =>
      state.storage.sql
        .exec<{ row: string }>("SELECT source || '@' || required_run AS row FROM backup_media ORDER BY source")
        .toArray()
        .map((r) => r.row),
    );
  }

  // A dump read to its last chunk under `opId`, with runner r1 holding the backup lease.
  async function readDump(store: StoreStub, opId: string) {
    const started = await store.dumpStart(BUILD, 60, opId);
    if (!started.ok) {
      throw new Error(started.code);
    }
    let cursor = started.cursor;
    for (;;) {
      const step = await store.dumpNext(BUILD, cursor);
      if (!step.ok) {
        throw new Error(step.code);
      }
      cursor = step.cursor;
      if (step.done) {
        return cursor;
      }
    }
  }

  async function prepared() {
    const store = await migratedStore();
    await seedStore(store);
    await addMedia(store, snowflake(NOW - DAY, 1), new Uint8Array([1]));
    await addMedia(store, snowflake(NOW - DAY, 2), new Uint8Array([2]));
    expect((await store.backupClaim(BUILD, "runner-1", NOW, LEASE)).ok).toBe(true);
    return store;
  }

  const finish = (store: StoreStub, runner: string, now: number, opId: string, cursor: unknown) =>
    store.backupFinishDump(BUILD, runner, now, "2026-10-13-aaaaaaaa", "fingerprint", opId, cursor);

  it("refuses a wrong opId, and leaves the dump and the membership as they were", async () => {
    const store = await prepared();
    const cursor = await readDump(store, "op-good-0001");
    expect(await finish(store, "runner-1", NOW, "op-wrong-0001", cursor)).toMatchObject({
      ok: false,
      code: "dump-not-found",
    });
    expect(await frozen(store)).toBe(true);
    expect(await membership(store)).toEqual([]);
  });

  it("refuses a runner whose lease ended or was taken over, and leaves everything as it was", async () => {
    const store = await prepared();
    const cursor = await readDump(store, "op-good-0002");
    expect(await finish(store, "runner-1", NOW + LEASE + 1, "op-good-0002", cursor)).toMatchObject({
      ok: false,
      code: "lost",
    });
    expect((await store.backupClaim(BUILD, "runner-2", NOW + LEASE + 1, LEASE)).ok).toBe(true);
    expect(await finish(store, "runner-1", NOW + LEASE + 2, "op-good-0002", cursor)).toMatchObject({
      ok: false,
      code: "lost",
    });
    expect(await frozen(store)).toBe(true);
    expect(await membership(store)).toEqual([]);
  });

  it("refuses a stale completion of an aborted dump against a newer good one", async () => {
    const store = await prepared();
    const stale = await readDump(store, "op-stale-0003");
    expect((await store.dumpAbort(BUILD, "op-stale-0003")).ok).toBe(true);
    const good = await readDump(store, "op-good-0003");
    expect(await finish(store, "runner-1", NOW, "op-stale-0003", stale)).toMatchObject({
      ok: false,
      code: "dump-not-found",
    });
    expect(await frozen(store)).toBe(true);
    expect(await membership(store)).toEqual([]);
    expect(await finish(store, "runner-1", NOW, "op-good-0003", good)).toMatchObject({ ok: true, required: 2 });
  });

  it("answers a replayed completion from its receipt without capturing again", async () => {
    const store = await prepared();
    const cursor = await readDump(store, "op-good-0004");
    const first = await finish(store, "runner-1", NOW, "op-good-0004", cursor);
    expect(first).toMatchObject({ ok: true, required: 2 });
    const captured = await membership(store);
    expect(captured).toHaveLength(2);
    // An attachment goes after the freeze ended; the replay (a lost answer) must not change the membership.
    await runInDurableObject(store, (_instance, state) => {
      state.storage.sql.exec("DELETE FROM media_attachments WHERE id = ?", snowflake(NOW - DAY, 2));
    });
    const replay = await finish(store, "runner-1", NOW, "op-good-0004", cursor);
    expect(replay).toMatchObject({ ok: true, trailerText: (first as { trailerText: string }).trailerText });
    expect(await membership(store)).toEqual(captured);
    expect(await frozen(store)).toBe(false);
  });
});

describe("backup failures (OPS-5, DATA-9)", () => {
  it("releases the Store freeze and aborts the upload when the job fails, then waits before retrying", async () => {
    const h = await harness();
    await addLargeRows(h.store, 8, 1536 * 1024);
    h.s3.fail = (op) => (op === "upload-part" ? 500 : undefined);
    let frozenAtFailure: boolean | undefined;
    h.s3.before = async (op) => {
      if (frozenAtFailure === undefined && op === "upload-part") {
        frozenAtFailure = await frozen(h.store);
      }
    };
    expect(await h.run()).toBe("failed");
    expect(frozenAtFailure).toBe(true);
    expect(await frozen(h.store)).toBe(false);
    expect((await h.store.health(BUILD)).readonly).toBe(false);
    expect(h.s3.uploads.size).toBe(0);
    expect(await backupState(h.store)).toMatchObject({
      runner: null,
      lastFailure: { at: NOW, stage: "dump", reason: "s3-upload-part-500" },
      retryAt: NOW + 60 * MINUTE,
      run: { stage: "dump" },
    });
    const report = await healthReport(BUILD, readConfig(h.env), () => h.store, {
      checkKeys: false,
      backup: readBackupConfig(h.env),
      now: NOW,
    });
    expect(report.ok).toBe(false);
    expect(report.checks.backup).toMatchObject({
      ok: false,
      lastFailure: { reason: "s3-upload-part-500" },
      inProgress: { stage: "dump" },
    });

    h.s3.fail = undefined;
    h.s3.before = undefined;
    expect(await h.run()).toBe("waiting");
    h.clock.now += 61 * MINUTE;
    expect(await h.run()).toBe("done");
  }, 30_000);

  it("releases the freeze before it cleans up the upload", async () => {
    const h = await harness();
    await addLargeRows(h.store, 8, 1536 * 1024);
    h.s3.fail = (op) => (op === "upload-part" ? 500 : undefined);
    let frozenAtAbort: boolean | undefined;
    h.s3.before = async (op) => {
      if (op === "abort-upload" && frozenAtAbort === undefined) {
        // The abort stays pending until the freeze has been checked.
        frozenAtAbort = await frozen(h.store);
      }
    };
    expect(await h.run()).toBe("failed");
    expect(frozenAtAbort).toBe(false);
    expect(h.s3.uploads.size).toBe(0);
  }, 30_000);

  it("restarts a dump whose freeze ended before its last step, so the membership matches the dump", async () => {
    const h = await harness();
    const kept = await addMedia(h.store, snowflake(NOW - DAY, 1), new Uint8Array([1]));
    const deletedId = snowflake(NOW - DAY, 2);
    await addMedia(h.store, deletedId, new Uint8Array([2]));
    // The answer to the last dump step arrives after the freeze lease ended, and a writer deleted an attachment.
    let expired = false;
    const store = wrapStore(h.store, async (name, call) => {
      const result = await call();
      const step = result as { ok: boolean; done?: boolean };
      if (name === "dumpNext" && step.ok && step.done === true && !expired) {
        expired = true;
        await runInDurableObject(h.store, (_instance, state) => {
          const sql = state.storage.sql;
          const row = sql.exec<{ value: string }>("SELECT value FROM kopje_state WHERE name = 'dump'").one();
          sql.exec(
            "UPDATE kopje_state SET value = ? WHERE name = 'dump'",
            JSON.stringify({ ...(JSON.parse(row.value) as object), leaseUntil: 0 }),
          );
          sql.exec("DELETE FROM media_attachments WHERE id = ?", deletedId);
        });
      }
      return result;
    });
    expect(await h.run({ store: () => store })).toBe("failed");
    expect((await backupState(h.store)).lastFailure?.reason).toBe("dump-dump-lease-expired");
    expect(await frozen(h.store)).toBe(false);
    h.clock.now += 61 * MINUTE;
    expect(await h.run()).toBe("done");
    const { index, text } = await restore(h);
    expect(index.map((e) => e.source)).toEqual([kept]);
    expect(text).not.toContain(deletedId);
  });

  it("a restarted dump replaces the membership the attempt before it recorded", async () => {
    const h = await harness();
    const kept = await addMedia(h.store, snowflake(NOW - DAY, 1), new Uint8Array([1]));
    const goneId = snowflake(NOW - DAY, 2);
    await addMedia(h.store, goneId, new Uint8Array([2]));
    // The dump and its membership are recorded, then completing the upload fails.
    h.s3.completeError = true;
    expect(await h.run()).toBe("failed");
    await runInDurableObject(h.store, (_instance, state) => {
      state.storage.sql.exec("DELETE FROM media_attachments WHERE id = ?", goneId);
    });
    h.s3.completeError = false;
    h.clock.now += 61 * MINUTE;
    expect(await h.run()).toBe("done");
    const { index, manifest } = await restore(h);
    expect(index.map((e) => e.source)).toEqual([kept]);
    expect(manifest.media).toEqual({ required: 1, copied: 1, pending: 0, absent: 0 });
  });

  it("treats an HTTP 200 completion that reports an error as a failure", async () => {
    const h = await harness();
    h.s3.completeError = true;
    expect(await h.run()).toBe("failed");
    expect((await backupState(h.store)).lastFailure?.reason).toBe("s3-complete-upload-200");
    expect(h.s3.uploads.size).toBe(0);
    expect(await frozen(h.store)).toBe(false);
  });

  it("a refused dump (another dump holds the freeze) fails without touching that dump", async () => {
    const h = await harness();
    const other = await h.store.dumpStart(BUILD, 60, "operator-dump-1");
    expect(other.ok).toBe(true);
    expect(await h.run()).toBe("failed");
    expect((await backupState(h.store)).lastFailure?.reason).toBe("dump-dump-in-progress");
    expect(await frozen(h.store)).toBe(true);
    expect(h.s3.count("create-upload")).toBe(0);
  });

  it("aborts abandoned multipart uploads under its prefix only, across listing pages", async () => {
    const h = await harness();
    const strays = [1, 2, 3].map((n) =>
      h.s3.strayUpload(`${PREFIX}backups/2026-10-12-0000000${n}/0123456789abcdef/dump.kopje.age`, new Uint8Array(10)),
    );
    const foreign = h.s3.strayUpload("someone-else/backup.tar");
    expect(await h.run()).toBe("done");
    for (const stray of strays) {
      expect(h.s3.uploads.has(stray)).toBe(false);
    }
    expect(h.s3.uploads.has(foreign)).toBe(true);
  });

  it("a wrong signing region is refused by the store and recorded", async () => {
    const h = await harness({ env: backupEnv({ BACKUP_S3_REGION: "eu-west-1" }) });
    expect(await h.run()).toBe("failed");
    expect((await backupState(h.store)).lastFailure?.reason).toBe("s3-create-upload-403");
  });

  it("never logs, saves or reports a secret or an S3 response (DATA-5, DATA-9)", async () => {
    const h = await harness();
    h.s3.fail = (op) => (op === "create-upload" ? 403 : undefined);
    expect(await h.run()).toBe("failed");
    const report = await healthReport(BUILD, readConfig(h.env), () => h.store, {
      checkKeys: false,
      backup: readBackupConfig(h.env),
    });
    const seen = JSON.stringify([h.logs, await backupState(h.store), report]);
    for (const marker of [SECRET, "Injected", "AKIDKOPJETEST", "s3.test", "Signature"]) {
      expect(seen).not.toContain(marker);
    }
    expect(seen).toContain("s3-create-upload-403");
  });
});

describe("backup retention (OPS-5)", () => {
  const ATTEMPT = "0123456789abcdef";
  function preload(s3: S3Mock, ids: string[], complete = true): void {
    for (const id of ids) {
      s3.objects.set(`${PREFIX}backups/${id}/${ATTEMPT}/dump.kopje.age`, new Uint8Array([1]));
      s3.objects.set(`${PREFIX}backups/${id}/${ATTEMPT}/media-index.json.age`, new Uint8Array([1]));
      if (complete) {
        s3.objects.set(`${PREFIX}backups/${id}/${ATTEMPT}/manifest.json.age`, new Uint8Array([2]));
      }
    }
  }

  it("keeps the newest N complete backups by manifest and deletes older ones, only its own objects", async () => {
    const h = await harness({ env: backupEnv({ BACKUP_RETENTION: "3" }) });
    preload(h.s3, ["2026-10-08-aaaaaaaa", "2026-10-10-aaaaaaaa", "2026-10-12-aaaaaaaa"]);
    // Incomplete (no manifest): an older one goes, a newer one than the oldest kept stays.
    preload(h.s3, ["2026-10-01-aaaaaaaa"], false);
    preload(h.s3, ["2026-10-11-aaaaaaaa"], false);
    const untouched = [
      "other-app/backups/2026-10-01-aaaaaaaa/0123456789abcdef/dump.kopje.age",
      `${PREFIX}backups/2026-10-01-aaaaaaaa/${ATTEMPT}/notes.txt`,
      `${PREFIX}media/2026-10-01-aaaaaaaa/${ATTEMPT}/originals/110000000000000001.age`,
      `${PREFIX}backups/README`,
    ];
    for (const key of untouched) {
      h.s3.objects.set(key, new Uint8Array([3]));
    }
    expect(await h.run()).toBe("done");

    const keys = [...h.s3.objects.keys()];
    const kept = (await backupState(h.store)).lastSuccess!.id;
    for (const id of [kept, "2026-10-12-aaaaaaaa", "2026-10-10-aaaaaaaa"]) {
      expect(keys.some((k) => k.startsWith(`${PREFIX}backups/${id}/`) && k.endsWith("manifest.json.age"))).toBe(true);
    }
    expect(keys).toContain(`${PREFIX}backups/2026-10-11-aaaaaaaa/${ATTEMPT}/dump.kopje.age`);
    for (const id of ["2026-10-08-aaaaaaaa", "2026-10-01-aaaaaaaa"]) {
      expect(keys.filter((k) => k.startsWith(`${PREFIX}backups/${id}/`) && !k.endsWith("notes.txt"))).toEqual([]);
    }
    for (const key of untouched) {
      expect(keys).toContain(key);
    }
    // A run's manifests go first, so a half-deleted backup never looks complete.
    const deletes = h.s3.requests.filter((r) => r.op === "delete").map((r) => r.key);
    const old = `${PREFIX}backups/2026-10-08-aaaaaaaa/${ATTEMPT}/`;
    expect(deletes.indexOf(`${old}manifest.json.age`)).toBeLessThan(deletes.indexOf(`${old}dump.kopje.age`));
    expect(deletes.indexOf(`${old}manifest.json.age`)).toBeLessThan(deletes.indexOf(`${old}media-index.json.age`));
    expect(deletes.every((k) => k?.startsWith(`${PREFIX}backups/`))).toBe(true);
  });

  it("never deletes the newest complete backup, even when the new manifest is not listed yet", async () => {
    const h = await harness({ env: backupEnv({ BACKUP_RETENTION: "1" }) });
    preload(h.s3, ["2026-10-11-aaaaaaaa", "2026-10-12-aaaaaaaa"]);
    h.s3.before = async (op, key) => {
      if (op === "put" && key?.endsWith("manifest.json.age") === true) {
        h.s3.hidden.add(key);
      }
    };
    expect(await h.run()).toBe("done");
    const keys = [...h.s3.objects.keys()];
    expect(keys).toContain(`${PREFIX}backups/2026-10-12-aaaaaaaa/${ATTEMPT}/manifest.json.age`);
    expect(keys).not.toContain(`${PREFIX}backups/2026-10-11-aaaaaaaa/${ATTEMPT}/manifest.json.age`);
    await recordedManifest(h);
  });

  it("a failure between deleting a manifest and its dump is recorded, and the next retention finishes the job", async () => {
    const h = await harness({ env: backupEnv({ BACKUP_RETENTION: "1" }) });
    preload(h.s3, ["2026-10-11-aaaaaaaa"]);
    const oldDump = `${PREFIX}backups/2026-10-11-aaaaaaaa/${ATTEMPT}/dump.kopje.age`;
    let failed = false;
    h.s3.fail = (op, key) => {
      if (op === "delete" && key === oldDump && !failed) {
        failed = true;
        return 403;
      }
      return undefined;
    };
    expect(await h.run()).toBe("done");
    const state = await backupState(h.store);
    expect(state.retentionFailure).toMatchObject({ reason: "s3-delete-403" });
    expect(h.s3.objects.has(oldDump)).toBe(true);
    expect(h.s3.objects.has(`${PREFIX}backups/2026-10-11-aaaaaaaa/${ATTEMPT}/manifest.json.age`)).toBe(false);
    await recordedManifest(h);

    h.clock.now = NOW + DAY;
    expect(await h.run()).toBe("done");
    expect(h.s3.objects.has(oldDump)).toBe(false);
    expect((await backupState(h.store)).retentionFailure).toBeNull();
    await recordedManifest(h);
  });

  it("records a listing failure without failing the backup", async () => {
    const h = await harness();
    h.s3.fail = (op) => (op === "list" ? 500 : undefined);
    expect(await h.run()).toBe("done");
    expect(await backupState(h.store)).toMatchObject({ retentionFailure: { at: NOW, reason: "s3-list-500" } });
  });
});

describe("backup restore path (DATA-10)", () => {
  async function verify(io: ReturnType<typeof memoryIO>, args: string[]) {
    let out = "";
    let err = "";
    const code = await cliRun({
      argv: ["backup-verify", ...args],
      env: {},
      io,
      stdout: { write: (t: string) => void (out += t) },
      stderr: { write: (t: string) => void (err += t) },
    });
    return { code, out, err };
  }

  // What an operator has after downloading the recorded manifest and what it lists, and `age -d` on each.
  async function download(h: Harness): Promise<ReturnType<typeof memoryIO>> {
    const manifest = await recordedManifest(h);
    const io = memoryIO();
    io.files.set("manifest.json", new TextEncoder().encode(JSON.stringify(manifest)));
    io.files.set("dump.kopje.age", h.s3.objects.get(manifest.dump.key)!);
    io.files.set("dump.kopje", await decrypt(h.s3.objects.get(manifest.dump.key)));
    const indexBytes = await decrypt(h.s3.objects.get(manifest.mediaIndex.key));
    io.files.set("media-index.json", indexBytes);
    const index = JSON.parse(new TextDecoder().decode(indexBytes)) as { objects: IndexEntry[] };
    for (const entry of index.objects.filter((e) => e.state === "copied")) {
      io.files.set(`media/${entry.source}`, await decrypt(h.s3.objects.get(entry.key!)));
    }
    return io;
  }

  const ALL = ["manifest.json", "dump.kopje", "--encrypted", "dump.kopje.age", "--index", "media-index.json"];

  it("kopje-admin backup-verify checks every file against the manifest and refuses a changed one", async () => {
    const h = await harness();
    const key = await addMedia(h.store, snowflake(NOW - DAY), new TextEncoder().encode("an original"));
    expect(await h.run()).toBe("done");
    const io = await download(h);

    expect(await verify(io, [...ALL, "--media", "media"])).toMatchObject({
      code: 0,
      out: expect.stringContaining("matches its manifest"),
    });

    // The same length with one byte changed fails, for the dump and for an original.
    const dump = io.files.get("dump.kopje")!;
    const changed = dump.slice();
    changed[changed.length - 30] = (changed[changed.length - 30] ?? 0) ^ 1;
    io.files.set("dump.kopje", changed);
    const badDump = await verify(io, [...ALL, "--media", "media"]);
    expect(badDump.code).toBe(1);
    expect(badDump.err).toContain("dump: dump.kopje does not match the manifest's SHA-256");
    io.files.set("dump.kopje", dump);
    io.files.set(`media/${key}`, new TextEncoder().encode("an origjnal"));
    const badMedia = await verify(io, [...ALL, "--media", "media"]);
    expect(badMedia.code).toBe(1);
    expect(badMedia.err).toContain(`media: media/${key} does not match`);

    // A truncated dump, and a manifest that was not decrypted.
    io.files.set("dump.kopje", dump.slice(0, 100));
    expect((await verify(io, ["manifest.json", "dump.kopje"])).err).toContain("the manifest says");
    io.files.set("manifest.age", h.s3.objects.get((await backupState(h.store)).lastSuccess!.manifest)!);
    expect((await verify(io, ["manifest.age", "dump.kopje"])).code).toBe(1);
  });

  it("verifies the index alone before any media is downloaded, and refuses an index that does not match", async () => {
    const h = await harness();
    await addMedia(h.store, snowflake(NOW - DAY), new Uint8Array([1, 2]));
    expect(await h.run()).toBe("done");
    const io = await download(h);
    for (const key of [...io.files.keys()].filter((k) => k.startsWith("media/") || k.startsWith("dump."))) {
      io.files.delete(key);
    }
    // Index-only: no dump and no media on disk yet.
    expect((await verify(io, ["manifest.json", "--index", "media-index.json"])).code).toBe(0);
    // A replaced index (validly encrypted, but not the manifest's) is refused before anything uses it.
    const index = JSON.parse(new TextDecoder().decode(io.files.get("media-index.json"))) as { objects: IndexEntry[] };
    index.objects[0]!.source = "originals/../../../home/operator/.profile";
    io.files.set("media-index.json", new TextEncoder().encode(JSON.stringify(index)));
    const refused = await verify(io, ["manifest.json", "--index", "media-index.json"]);
    expect(refused.code).toBe(1);
    expect(refused.err).toMatch(/^media index: media-index\.json (has \d+ bytes|does not match)/);
  });

  it("rejects index entries that name anything but originals/<id> under their run, and stops at the first", async () => {
    const h = await harness();
    await addMedia(h.store, snowflake(NOW - DAY), new Uint8Array([1, 2]));
    expect(await h.run()).toBe("done");
    const io = await download(h);
    const original = JSON.parse(new TextDecoder().decode(io.files.get("media-index.json"))) as {
      objects: IndexEntry[];
    };
    const entry = original.objects[0]!;
    // Even an index whose digest matches the manifest (as if the manifest were forged too) is validated entry by entry.
    const cases: [Partial<IndexEntry>, string][] = [
      [{ source: "../../etc/passwd" }, "names something other than originals/<18-digit id>"],
      [{ source: `${entry.source}/../../x` }, "names something other than originals/<18-digit id>"],
      [{ key: entry.key!.replace("/media/", "/backups/") }, "is not under its run's media/ prefix"],
      [{ key: `../${entry.key!}` }, "is not under its run's media/ prefix"],
    ];
    for (const [change, message] of cases) {
      const forged = {
        ...original,
        objects: [
          { ...entry, ...change },
          { ...entry, source: "../second" },
        ],
      };
      const bytes = new TextEncoder().encode(JSON.stringify(forged));
      const manifest = JSON.parse(new TextDecoder().decode(io.files.get("manifest.json"))) as BackupManifest;
      manifest.mediaIndex.plaintext = { size: bytes.byteLength, sha256: await sha256Hex(bytes) };
      io.files.set("forged-manifest.json", new TextEncoder().encode(JSON.stringify(manifest)));
      io.files.set("forged-index.json", bytes);
      const result = await verify(io, ["forged-manifest.json", "--index", "forged-index.json", "--media", "media"]);
      expect(result.code).toBe(1);
      expect(result.err).toContain(message);
      // The first error stops verification: one line.
      expect(result.err.trim().split("\n")).toHaveLength(1);
    }
  });

  it("rejects a mismatched run, a malformed attempt, or a bad entry after a good one, before reading any media", async () => {
    const h = await harness();
    await addMedia(h.store, snowflake(NOW - DAY, 1), new Uint8Array([1]));
    await addMedia(h.store, snowflake(NOW - DAY, 2), new Uint8Array([2]));
    expect(await h.run()).toBe("done");
    const io = await download(h);
    const original = JSON.parse(new TextDecoder().decode(io.files.get("media-index.json"))) as {
      objects: IndexEntry[];
    };
    const [first, second] = original.objects as [IndexEntry, IndexEntry];
    const otherRun = "2026-10-01-0badc0de";
    const attempt = /\/([0-9a-f]{16})\//.exec(first.key!)![1]!;
    const cases: [IndexEntry[], string][] = [
      // A well-formed key under another run than the entry names.
      [[{ ...first, key: first.key!.replace(/\/media\/[^/]+\//, `/media/${otherRun}/`) }, second], "not under its run"],
      [[{ ...first, run: otherRun }, second], "not under its run"],
      // Malformed attempts: too short, upper case.
      [[{ ...first, key: first.key!.replace(attempt, attempt.slice(1)) }, second], "not under its run"],
      [[{ ...first, key: first.key!.replace(attempt, attempt.toUpperCase()) }, second], "not under its run"],
      // The first entry is valid, the second is not.
      [[first, { ...second, source: "originals/../../etc/passwd" }], "originals/<18-digit id>"],
    ];
    for (const [objects, message] of cases) {
      const bytes = new TextEncoder().encode(JSON.stringify({ ...original, objects }));
      const manifest = JSON.parse(new TextDecoder().decode(io.files.get("manifest.json"))) as BackupManifest;
      manifest.mediaIndex.plaintext = { size: bytes.byteLength, sha256: await sha256Hex(bytes) };
      io.files.set("forged-manifest.json", new TextEncoder().encode(JSON.stringify(manifest)));
      io.files.set("forged-index.json", bytes);
      const reads: string[] = [];
      const watched = {
        ...io,
        size: (path: string) => (reads.push(path), io.size(path)),
        sha256: (path: string) => (reads.push(path), io.sha256(path)),
      };
      let err = "";
      const code = await cliRun({
        argv: ["backup-verify", "forged-manifest.json", "--index", "forged-index.json", "--media", "media"],
        env: {},
        io: watched,
        stdout: { write: () => {} },
        stderr: { write: (t: string) => void (err += t) },
      });
      expect(code).toBe(1);
      expect(err).toContain(message);
      expect(reads.filter((path) => path.startsWith("media/"))).toEqual([]);
    }
  });

  it("lists the originals beyond the per-run cap as pending, and copies them in the next backup", async () => {
    expect(MAX_MEDIA_PER_RUN).toBe(2000);
    const h = await harness();
    const sources: string[] = [];
    for (const n of [1, 2, 3]) {
      sources.push(await addMedia(h.store, snowflake(NOW - DAY, n), new Uint8Array([n])));
    }
    expect(await h.run({ maxMediaPerRun: 2 })).toBe("done");
    const { index, manifest } = await restore(h);
    expect(index.map((e) => [e.source, e.state])).toEqual([
      [sources[0], "copied"],
      [sources[1], "copied"],
      [sources[2], "pending"],
    ]);
    expect(manifest.media).toEqual({ required: 3, copied: 2, pending: 1, absent: 0 });
    const result = await verify(await download(h), [...ALL, "--media", "media"]);
    expect(result.code).toBe(3);
    expect(result.err).toContain(`missing: ${sources[2]} (pending)`);
    expect(result.err).toContain("incomplete: 1 of 3 originals");

    h.clock.now = NOW + DAY;
    expect(await h.run({ maxMediaPerRun: 2 })).toBe("done");
    expect((await restore(h)).manifest.media).toEqual({ required: 3, copied: 3, pending: 0, absent: 0 });
  });

  it("reports incomplete media coverage with its own exit code", async () => {
    const h = await harness();
    await addMedia(h.store, snowflake(NOW - DAY), new Uint8Array([1]));
    const gone = await addMedia(h.store, snowflake(NOW - DAY, 1), new Uint8Array(), false);
    expect(await h.run()).toBe("done");
    const result = await verify(await download(h), [...ALL, "--media", "media"]);
    expect(result.code).toBe(3);
    expect(result.err).toContain(`missing: ${gone} (absent)`);
    expect(result.err).toContain("incomplete: 1 of 2 originals");
  });

  it("verifies the whole restore set after retention removed the backup that copied an original", async () => {
    // Retention 1: day 1 copies X; day 2 copies nothing and deletes day 1's manifest and index. Day 2's index
    // still names X's object and digests, so a replaced X is caught.
    const h = await harness({ env: backupEnv({ BACKUP_RETENTION: "1" }) });
    const x = await addMedia(h.store, snowflake(NOW - DAY), new TextEncoder().encode("original X"));
    expect(await h.run()).toBe("done");
    h.clock.now = NOW + DAY;
    expect(await h.run()).toBe("done");
    const manifest = await recordedManifest(h);
    const day1 = (await backupState(h.store)).lastSuccess!.id;
    expect(keysUnder(h, `${PREFIX}backups/`).every((k) => k.includes(`/${day1}/`))).toBe(true);

    const io = await download(h);
    expect((await verify(io, [...ALL, "--media", "media"])).code).toBe(0);
    // Someone with bucket access and the public key replaces X with a valid encryption of other bytes.
    const index = JSON.parse(new TextDecoder().decode(io.files.get("media-index.json"))) as { objects: IndexEntry[] };
    const entry = index.objects.find((e) => e.source === x)!;
    expect(entry.key).not.toContain(manifest.id);
    h.s3.objects.set(entry.key!, await encrypt(new TextEncoder().encode("original Y")));
    io.files.set(`media/${x}`, await decrypt(h.s3.objects.get(entry.key!)));
    const result = await verify(io, [...ALL, "--media", "media"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain(`media: media/${x} does not match`);
  });
});

describe("public /health with backups", () => {
  it("answers fail while the last backup failed, and ok again after a success", async () => {
    const h = await harness();
    h.s3.fail = (op) => (op === "create-upload" ? 500 : undefined);
    expect(await h.run()).toBe("failed");
    const app = appHarness(h.store, h.env as unknown as Record<string, unknown>);
    const failing = await app.request("/health");
    expect(failing.status).toBe(503);
    expect(await failing.text()).toBe("fail");

    h.s3.fail = undefined;
    h.clock.now += 61 * MINUTE;
    expect(await h.run()).toBe("done");
    const ok = await app.request("/health");
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("ok");
  });

  it("answers fail on invalid backup settings while the Mastodon API keeps serving", async () => {
    const api = await apiHarness({
      ...(backupEnv() as unknown as Record<string, unknown>),
      BACKUP_AGE_RECIPIENT: "not-a-key",
    });
    expect((await api.request("/health")).status).toBe(503);
    expect((await api.request("/api/v1/instance")).status).toBe(200);
  });

  it("answers ok when backups are enabled but not configured", async () => {
    const app = appHarness(await migratedStore());
    expect((await app.request("/health")).status).toBe(200);
  });
});

describe("SigV4 (independent vectors)", () => {
  // AWS's published examples for S3 header authorization (Signature Version 4, "Examples of signature
  // calculations"): the mock's verifier and aws4fetch, which signs the backup's requests, must both reproduce them.
  const CREDENTIALS = {
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    region: "us-east-1",
  };
  const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const VECTORS: {
    name: string;
    method: string;
    url: string;
    headers: Record<string, string>;
    signed: string[];
    signature: string;
  }[] = [
    {
      name: "GET Object",
      method: "GET",
      url: "https://examplebucket.s3.amazonaws.com/test.txt",
      headers: { range: "bytes=0-9", "x-amz-content-sha256": EMPTY, "x-amz-date": "20130524T000000Z" },
      signed: ["host", "range", "x-amz-content-sha256", "x-amz-date"],
      signature: "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    },
    {
      name: "PUT Object",
      method: "PUT",
      url: "https://examplebucket.s3.amazonaws.com/test%24file.text",
      headers: {
        date: "Fri, 24 May 2013 00:00:00 GMT",
        "x-amz-content-sha256": "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072",
        "x-amz-date": "20130524T000000Z",
        "x-amz-storage-class": "REDUCED_REDUNDANCY",
      },
      signed: ["date", "host", "x-amz-content-sha256", "x-amz-date", "x-amz-storage-class"],
      signature: "98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd",
    },
    {
      name: "GET Bucket Lifecycle",
      method: "GET",
      url: "https://examplebucket.s3.amazonaws.com/?lifecycle",
      headers: { "x-amz-content-sha256": EMPTY, "x-amz-date": "20130524T000000Z" },
      signed: ["host", "x-amz-content-sha256", "x-amz-date"],
      signature: "fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543",
    },
    {
      name: "Get Bucket (List Objects)",
      method: "GET",
      url: "https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J",
      headers: { "x-amz-content-sha256": EMPTY, "x-amz-date": "20130524T000000Z" },
      signed: ["host", "x-amz-content-sha256", "x-amz-date"],
      signature: "34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7",
    },
  ];

  for (const vector of VECTORS) {
    it(`reproduces AWS's ${vector.name} example`, async () => {
      const headers = new Headers(vector.headers);
      expect(
        await signatureOf(
          {
            method: vector.method,
            url: vector.url,
            headers,
            secretAccessKey: CREDENTIALS.secretAccessKey,
            region: CREDENTIALS.region,
          },
          vector.signed,
        ),
      ).toBe(vector.signature);
      const signer = new AwsV4Signer({
        ...CREDENTIALS,
        service: "s3",
        method: vector.method,
        url: vector.url,
        headers: vector.headers,
        datetime: "20130524T000000Z",
        allHeaders: true,
      });
      expect(signer.signedHeaders).toBe(vector.signed.join(";"));
      expect(await signer.signature()).toBe(vector.signature);
    });
  }
});
