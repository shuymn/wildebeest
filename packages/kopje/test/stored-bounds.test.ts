import { Person } from "@fedify/vocab";
import { runInDurableObject } from "cloudflare:test";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { MIGRATIONS } from "../src/db/migrations";
import { Db } from "../src/db/sql";
import { jsonBytes } from "../src/domain/answer-budget";
import { upsertRemoteActor } from "../src/domain/remote-actors";
import { MAX_SPOILER_LENGTH } from "../src/domain/remote-statuses";
import { MAX_RAW_LENGTH, parseStatusText, renderFieldValue, renderStatusHtml } from "../src/domain/status-text";
import { remoteActorInput } from "../src/federation/remote-actor";
import { parseRemoteStatus } from "../src/federation/remote-status";
import { REMOTE_USERNAME_LIMIT, STATUS_URI_LIMIT } from "../src/platform/identity-bounds";
import { mediaUrl, SERVED_TYPES } from "../src/platform/media-files";
import {
  APP_ID_BYTES,
  APP_NAME_BYTES,
  APP_NAME_JSON_BYTES,
  APP_NAME_LIMIT,
  appNameSql,
  applicationIdPastBoundSql,
  BASE83,
  BIO_JSON_BYTES,
  BLURHASH_BYTES,
  blurhashPastBoundSql,
  CONTACT_EMAIL_BYTES,
  CONTACT_SETTING_BOUNDS,
  CONTACT_USERNAME_BYTES,
  CONTACT_USERNAME_LIMIT,
  contactUsernamePastBoundSql,
  CONTENT_JSON_BYTES,
  contentSql,
  DISPLAY_NAME_LIMIT,
  displayNameSql,
  DOMAIN_BLOCKS_SHOWN,
  INSTANCE_DESCRIPTION_LIMIT,
  INSTANCE_DOCUMENT_BYTES,
  INSTANCE_RULES_BYTES,
  INSTANCE_SETTING_BOUNDS,
  INSTANCE_SETTING_NAMES,
  INSTANCE_TITLE_LIMIT,
  type InstanceSettingName,
  isBlank,
  MAX_MEDIA_DESCRIPTION_LENGTH,
  MAX_REMOTE_OPTION_LENGTH,
  MAX_REMOTE_OPTIONS,
  MEDIA_META_BYTES,
  MEDIA_URL_LIMIT,
  mediaDescriptionSql,
  mediaMetaSql,
  mediaUrlSql,
  noteSql,
  POLL_OPTIONS_BYTES,
  PROFILE_URL_LIMIT,
  pollOptionsSql,
  profileUrlSql,
  sourceTextSql,
  SPOILER_JSON_BYTES,
  spoilerSql,
  STATUS_URL_LIMIT,
  statusUrlSql,
  presentedAppName,
  storedApplicationId,
  storedBlurhash,
  storedDisplayName,
  storedInstanceSetting,
  storedMediaDescription,
  storedMediaLink,
  storedMediaMeta,
  storedMediaUrl,
  storedProfileUrl,
  storedStatusUrl,
  storedText,
  trimBlank,
} from "../src/platform/stored-bounds";
import {
  cutCodeUnits,
  cutJsonString,
  jsonStringBytes,
  REMOTE_BIO_BYTES,
  REMOTE_HTML_RAW_LIMIT,
  sanitizeRemoteBio,
  sanitizeRemoteContent,
  sanitizeRemoteHtml,
  SPOILER_BYTES,
  STATUS_CONTENT_BYTES,
} from "../src/security/html";
import { sha256Hex } from "../src/security/tokens";
import { bearer } from "./api-helpers";
import { NOW } from "./app-helpers";
import { BUILD, freshStore, migratedStore } from "./helpers";
import { community } from "./status-helpers";
import { blurhashOf, loneSurrogates, movedCountSql, seedBounded, STATUS, TABLES } from "./stored-bounds-fixtures";

// RES-2 (src/platform/stored-bounds.ts): for every covered column, evaluated in the Store's SQLite, a writer's output
// as stored is a fixed point of the column's projection P, and P(P(x)) = P(x). The inputs are random strings with
// U+0000, characters outside the BMP, lone surrogates and characters JSON escapes, measured at each bound, one below
// and one past it, in the bound's own unit (code points, UTF-8 bytes, or UTF-8 bytes of the JSON string).
//
// Both are evaluated inside SQLite, as a trigger would compare them: workerd binds a lone surrogate as its three-byte
// surrogate encoding and reads those bytes back as three U+FFFD, so a value read into the Worker and bound again is
// not the stored value.

const ENCODER = new TextEncoder();

type Unit = "points" | "bytes" | "json";
const UNIT_OF: Record<Unit, (char: string) => number> = {
  points: () => 1,
  bytes: (char) => ENCODER.encode(char).length,
  json: (char) => jsonStringBytes(char) - 2,
};

const ALPHABET = [
  "a",
  " ",
  "\u0000",
  "\u0001",
  '"',
  "\\",
  "\n",
  "<",
  "&",
  "\u007f",
  "é",
  " ",
  "日",
  "\u{1F600}",
  "\ud800",
  "\udc00",
];

// A deterministic stream of choices from a seed (mulberry32).
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Mix = { seed: number; weights: number[]; padAt: number; alphabet: readonly string[] };

function mixOf(alphabet: readonly string[], least = 0): fc.Arbitrary<Mix> {
  return fc.record({
    seed: fc.integer(),
    weights: fc.array(fc.integer({ min: least, max: 8 }), { minLength: alphabet.length, maxLength: alphabet.length }),
    padAt: fc.double({ min: 0, max: 1, noNaN: true }),
    alphabet: fc.constant(alphabet),
  });
}

const mix = mixOf(ALPHABET);

// Canonical text: no U+0000, no lone surrogate, nothing JSON escapes or a sanitizer rewrites. HTML_ALPHABET's
// characters take three bytes and one code unit each, so HTML at a JSON bound stays within REMOTE_HTML_RAW_LIMIT.
const CANONICAL_ALPHABET = ["a", " ", "\u00e9", "\u65e5", "\u{1F600}"];
const HTML_ALPHABET = ["\u65e5", "\u672c", "\u30ab"];

// A string of exactly `target` in `unit` (the JSON unit counts the quotes): characters drawn from ALPHABET by the
// mix's weights, then 'a' (one in every unit) at a drawn position for the rest. A lone high surrogate is never
// followed by a low one, so the measure of the whole is the sum of its characters'.
function measured({ seed, weights, padAt, alphabet }: Mix, unit: Unit, target: number): string {
  const next = random(seed);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const pick = () => {
    let roll = next() * total;
    for (const [i, weight] of weights.entries()) {
      roll -= weight;
      if (roll < 0) {
        return alphabet[i] ?? "a";
      }
    }
    return "a";
  };
  const chars: string[] = [];
  let used = unit === "json" ? 2 : 0;
  while (total > 0) {
    const char = pick();
    if (char === "\udc00" && chars.at(-1) === "\ud800") {
      continue;
    }
    const size = UNIT_OF[unit](char);
    if (used + size > target) {
      break;
    }
    chars.push(char);
    used += size;
  }
  const at = Math.floor(padAt * chars.length);
  return [...chars.slice(0, at), "a".repeat(target - used), ...chars.slice(at)].join("");
}

const lengthIn = (unit: Unit, text: string) =>
  unit === "json" ? jsonStringBytes(text) : [...text].reduce((sum, char) => sum + UNIT_OF[unit](char), 0);

// The inputs at each of `bounds`, one below and one past.
function inputs(bounds: [Unit, number][]): fc.Arbitrary<string> {
  const targets = bounds.flatMap(([unit, bound]) => [-1, 0, 1].map((delta) => [unit, bound + delta] as const));
  return fc.tuple(fc.constantFrom(...targets), mix).map(([[unit, target], m]) => measured(m, unit, target));
}

type Column = {
  name: string;
  projection: (column: string) => string;
  writer: (value: string) => string | null;
  // A text column: its writer's output is well-formed and holds no U+0000.
  text?: true;
  // Canonical inputs within the bound, at it and one below, which the writer and P keep unchanged; html wraps them
  // in a paragraph (the tags count toward the bound).
  kept: { unit: Unit; bound: number; html?: true };
  bounds: [Unit, number][];
  runs: number;
};

const sanitizerRuns = 4;

// A column bounded in UTF-8 bytes alone: inputs at its bound, the same bound for canonical values, 60 runs.
function byteColumn(name: string, projection: Column["projection"], writer: Column["writer"], bound: number): Column {
  return { name, kept: { unit: "bytes", bound }, projection, writer, bounds: [["bytes", bound]], runs: 60 };
}
const COLUMNS: Column[] = [
  {
    name: "accounts.display_name",
    kept: { unit: "points", bound: DISPLAY_NAME_LIMIT },
    projection: displayNameSql,
    writer: storedDisplayName,
    text: true,
    bounds: [
      ["points", DISPLAY_NAME_LIMIT],
      ["bytes", DISPLAY_NAME_LIMIT],
    ],
    runs: 60,
  },
  {
    name: "accounts.note",
    kept: { unit: "json", bound: BIO_JSON_BYTES, html: true },
    projection: noteSql,
    writer: (value) => sanitizeRemoteBio(storedText(value)),
    text: true,
    bounds: [
      ["json", BIO_JSON_BYTES],
      ["bytes", BIO_JSON_BYTES],
    ],
    runs: sanitizerRuns,
  },
  byteColumn("accounts.url, avatar_url, header_url", profileUrlSql, storedProfileUrl, PROFILE_URL_LIMIT),
  {
    name: "statuses.content, status_edits.content",
    kept: { unit: "json", bound: CONTENT_JSON_BYTES, html: true },
    projection: contentSql,
    writer: (value) => sanitizeRemoteContent(storedText(value)),
    text: true,
    bounds: [
      ["json", CONTENT_JSON_BYTES],
      ["bytes", CONTENT_JSON_BYTES],
    ],
    runs: sanitizerRuns,
  },
  {
    name: "statuses.spoiler_text, status_edits.spoiler_text",
    kept: { unit: "json", bound: SPOILER_JSON_BYTES },
    projection: spoilerSql,
    writer: (value) => cutJsonString(storedText(value), SPOILER_JSON_BYTES),
    text: true,
    bounds: [
      ["json", SPOILER_JSON_BYTES],
      ["bytes", SPOILER_JSON_BYTES],
      ["points", Math.floor((SPOILER_JSON_BYTES - 2) / 6)],
    ],
    runs: 60,
  },
  {
    name: "statuses.source_text",
    kept: { unit: "json", bound: CONTENT_JSON_BYTES },
    projection: sourceTextSql,
    writer: (value) => cutJsonString(storedText(value), CONTENT_JSON_BYTES),
    text: true,
    bounds: [
      ["json", CONTENT_JSON_BYTES],
      ["bytes", CONTENT_JSON_BYTES],
    ],
    runs: 20,
  },
  byteColumn("statuses.url", statusUrlSql, storedStatusUrl, STATUS_URL_LIMIT),
  byteColumn("media_attachments.url", mediaUrlSql, storedMediaUrl, MEDIA_URL_LIMIT),
  byteColumn("media_attachments.preview_url", mediaUrlSql, storedMediaLink, MEDIA_URL_LIMIT),
  {
    name: "media_attachments.description",
    kept: { unit: "points", bound: MAX_MEDIA_DESCRIPTION_LENGTH },
    projection: mediaDescriptionSql,
    writer: storedMediaDescription,
    text: true,
    bounds: [
      ["points", MAX_MEDIA_DESCRIPTION_LENGTH],
      ["bytes", MAX_MEDIA_DESCRIPTION_LENGTH],
    ],
    runs: 60,
  },
  byteColumn("media_attachments.meta", mediaMetaSql, storedMediaMeta, MEDIA_META_BYTES),
];

type Sql = DurableObjectState["storage"]["sql"];

// One value: `expression` over ?1 bound to `value`, as SQLite returns it.
function valueOf(sql: Sql, expression: string, value: string): SqlStorageValue {
  return sql.exec<{ v: SqlStorageValue }>(`SELECT ${expression} AS v`, value).one().v;
}

// P(P(x)) IS P(x) for x bound to ?1, inside SQLite.
function idempotent(sql: Sql, projection: (column: string) => string, input: string): boolean {
  return valueOf(sql, `(${projection(`(${projection("?1")})`)}) IS (${projection("?1")})`, input) === 1;
}

// P(P(x)) = P(x), and P(writer(x)) = writer(x) as stored.
function checkColumn(sql: Sql, { projection, writer, text }: Column, input: string): void {
  expect(idempotent(sql, projection, input)).toBe(true);
  const written = writer(input);
  if (written !== null) {
    expect(valueOf(sql, `(${projection("?1")}) IS ?1`, written)).toBe(1);
  }
  if (text === true) {
    expect(written?.isWellFormed()).toBe(true);
    expect(written).not.toContain("\u0000");
  }
}

describe("stored bounds (RES-2)", () => {
  it("repeats the bounds it shares with security/html.ts and identity-bounds.ts", () => {
    expect([BIO_JSON_BYTES, CONTENT_JSON_BYTES, SPOILER_JSON_BYTES, STATUS_URL_LIMIT]).toEqual([
      REMOTE_BIO_BYTES,
      STATUS_CONTENT_BYTES,
      SPOILER_BYTES,
      STATUS_URI_LIMIT,
    ]);
  });

  it("generates inputs of exactly the measure asked for", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<Unit>("points", "bytes", "json"),
        fc.integer({ min: 2, max: 3000 }),
        mix,
        (unit, target, m) => {
          expect(lengthIn(unit, measured(m, unit, target))).toBe(target);
        },
      ),
      { numRuns: 300 },
    );
  });

  for (const column of COLUMNS) {
    it(`${column.name}: the writer and P keep a canonical value within the bound`, async () => {
      const { unit, bound, html } = column.kept;
      const canonical = fc
        .tuple(fc.constantFrom(bound - 1, bound), mixOf(html === true ? HTML_ALPHABET : CANONICAL_ALPHABET, 1))
        .map(([target, m]) => (html === true ? `<p>${measured(m, unit, target - 7)}</p>` : measured(m, unit, target)));
      await runInDurableObject(freshStore(), (_instance, state) => {
        fc.assert(
          fc.property(canonical, (input) => {
            expect(lengthIn(unit, input)).toBeLessThanOrEqual(bound);
            expect(column.writer(input)).toBe(input);
            expect(valueOf(state.storage.sql, `(${column.projection("?1")}) IS ?1`, input)).toBe(1);
          }),
          { numRuns: column.text === true && html === true ? 4 : 30 },
        );
      });
    });

    it(`${column.name}: P is idempotent and the writer's output is its fixed point`, async () => {
      await runInDurableObject(freshStore(), (_instance, state) => {
        fc.assert(
          fc.property(inputs(column.bounds), (input) => checkColumn(state.storage.sql, column, input)),
          { numRuns: column.runs * column.bounds.length },
        );
      });
    }, 120_000);
  }

  it("runs where String.prototype.toWellFormed exists", () => {
    expect(typeof String.prototype.toWellFormed).toBe("function");
    expect(storedText("a\ud800b\u0000\udc00")).toBe("a\ufffdb\ufffd");
  });

  // An actor's display name of lone surrogates is stored as U+FFFD, three bytes each, and reads back at that size.
  it("stores a display name of lone surrogates from ingestion within three bytes a character, read back alike", async () => {
    const actor = await Person.fromJsonLd({
      "@context": "https://www.w3.org/ns/activitystreams",
      id: "https://remote.example/users/s",
      type: "Person",
      preferredUsername: "s",
      name: "\ud800".repeat(DISPLAY_NAME_LIMIT),
      inbox: "https://remote.example/users/s/inbox",
    });
    const input = await remoteActorInput(actor, {});
    expect(input).not.toBeNull();
    const store = await migratedStore();
    const stored = await runInDurableObject(store, (_instance, state) =>
      state.storage.transactionSync(() => {
        const db = new Db(state.storage.sql);
        upsertRemoteActor(db, input!, "https://kopje.test", NOW);
        return db.first<{ name: string; bytes: number }>(
          "SELECT display_name AS name, length(CAST(display_name AS BLOB)) AS bytes FROM accounts WHERE uri = ?",
          "https://remote.example/users/s",
        );
      }),
    );
    expect(stored?.bytes).toBeLessThanOrEqual(3 * DISPLAY_NAME_LIMIT);
    expect(ENCODER.encode(stored?.name).length).toBe(stored?.bytes);
    expect(stored?.name).toBe("\ufffd".repeat(DISPLAY_NAME_LIMIT));
  });

  it("writers remove U+0000 and cut by code points", () => {
    for (const [writer, limit] of [
      [storedDisplayName, DISPLAY_NAME_LIMIT],
      [storedMediaDescription, MAX_MEDIA_DESCRIPTION_LENGTH],
    ] as const) {
      fc.assert(
        fc.property(inputs([["points", limit]]), (input) => {
          const written = writer(input);
          expect(written).not.toContain("\u0000");
          expect([...written].length).toBe(Math.min([...storedText(input)].length, limit));
        }),
        { numRuns: 100 },
      );
    }
  });

  // An edit's snapshot stores P of the poll's choices (statuses.ts recordEdit), so its writer is P itself.
  it("status_edits.poll_options: P is idempotent over JSON arrays of choices at each bound", async () => {
    const choice = (unit: Unit, target: number) => mix.map((m) => measured(m, unit, target));
    const near = (bound: number) => fc.constantFrom(bound - 1, bound, bound + 1);
    const choices = fc.oneof(
      // The number of choices at MAX_REMOTE_OPTIONS, each short.
      near(MAX_REMOTE_OPTIONS).chain((n) => fc.array(choice("points", 8), { minLength: n, maxLength: n })),
      // Choices at MAX_REMOTE_OPTION_LENGTH, in code points or bytes.
      fc.array(
        fc.oneof(
          near(MAX_REMOTE_OPTION_LENGTH).chain((n) => choice("points", n)),
          near(MAX_REMOTE_OPTION_LENGTH).chain((n) => choice("bytes", n)),
        ),
        { minLength: 1, maxLength: 8 },
      ),
    );
    // The whole array at POLL_OPTIONS_BYTES: long choices, the last padded to the size.
    const whole = fc
      .tuple(near(POLL_OPTIONS_BYTES), fc.array(choice("json", 20_000), { minLength: 40, maxLength: 40 }))
      .map(([target, parts]) => {
        const kept = [...parts];
        while (kept.length > 1 && jsonBytes(kept) > target) {
          kept.pop();
        }
        const size = jsonBytes(kept);
        kept[kept.length - 1] = `${kept.at(-1) ?? ""}${"a".repeat(Math.max(0, target - size))}`;
        return kept;
      });
    await runInDurableObject(freshStore(), (_instance, state) => {
      const sql = state.storage.sql;
      fc.assert(
        fc.property(fc.oneof(choices, whole), (options) => {
          expect(idempotent(sql, pollOptionsSql, JSON.stringify(options))).toBe(true);
        }),
        { numRuns: 120 },
      );
    });
  }, 120_000);

  it("builds tokened media URLs within the bound on a host of 253 characters", async () => {
    const host = [63, 63, 63, 61].map((n, i) => String.fromCharCode(97 + i).repeat(n)).join(".");
    expect(host).toHaveLength(253);
    const token = "T".repeat(64);
    const urls = [...SERVED_TYPES.keys()].flatMap((type) =>
      (["full", "small"] as const).map((variant) => mediaUrl(`https://${host}`, token, variant, type)),
    );
    await runInDurableObject(freshStore(), (_instance, state) => {
      for (const url of urls) {
        expect(ENCODER.encode(url).length).toBeLessThanOrEqual(MEDIA_URL_LIMIT);
        expect(storedMediaUrl(url)).toBe(url);
        expect(valueOf(state.storage.sql, mediaUrlSql("?1"), url)).toBe(url);
      }
    });
    expect(Math.max(...urls.map((url) => url.length))).toBeLessThan(350);
  });
});

// Cuts that run after storedText split no surrogate pair, so the text writers' output stays well-formed: each case
// puts a pair across the cut.
describe("cuts after normalization (RES-2)", () => {
  const PAIR = "\u{1F600}";

  it("cuts by code units without splitting a pair", () => {
    expect(cutCodeUnits(`ab${PAIR}`, 3)).toBe("ab");
    expect(cutCodeUnits(`ab${PAIR}`, 4)).toBe(`ab${PAIR}`);
    expect(cutCodeUnits(`abc${PAIR}`, 3)).toBe("abc");
    expect(cutCodeUnits("\ud800\ud800x", 1)).toBe("\ud800");
  });

  it("keeps an ingested status's content warning, content and poll choices well-formed", () => {
    const status = parseRemoteStatus({
      id: "https://remote.example/notes/1",
      type: "Question",
      attributedTo: "https://remote.example/users/r",
      summary: `${"a".repeat(MAX_SPOILER_LENGTH - 1)}${PAIR}`,
      content: `${"c".repeat(REMOTE_HTML_RAW_LIMIT - 1)}${PAIR}`,
      oneOf: [
        { type: "Note", name: `${"o".repeat(MAX_REMOTE_OPTION_LENGTH - 1)}${PAIR}` },
        { type: "Note", name: "\ud800".repeat(MAX_REMOTE_OPTION_LENGTH) },
      ],
    });
    expect(status?.spoilerText).toBe("a".repeat(MAX_SPOILER_LENGTH - 1));
    expect(status?.content).toBe("c".repeat(REMOTE_HTML_RAW_LIMIT - 1));
    expect(status?.poll?.options).toEqual([
      "o".repeat(MAX_REMOTE_OPTION_LENGTH - 1),
      "�".repeat(MAX_REMOTE_OPTION_LENGTH),
    ]);
    expect(status?.poll?.cut).toEqual([0, 1]);
  });

  it("keeps sanitized HTML well-formed where the bound's prefix search cuts it", () => {
    // 50,000 code units whose sanitized JSON passes both bounds, so the search halves through the pairs.
    const html = `<<${PAIR}`.repeat(REMOTE_HTML_RAW_LIMIT / 4);
    for (const [within, bytes] of [
      [sanitizeRemoteContent, STATUS_CONTENT_BYTES],
      [sanitizeRemoteBio, REMOTE_BIO_BYTES],
    ] as const) {
      const output = within(html);
      expect(jsonStringBytes(sanitizeRemoteHtml(html))).toBeGreaterThan(bytes);
      expect(output.isWellFormed()).toBe(true);
      expect(jsonStringBytes(output)).toBeLessThanOrEqual(bytes);
      expect(output.length).toBeGreaterThan(0);
    }
  });

  it("keeps local composition well-formed where a link display or a field value is cut", () => {
    const url = `https://example.com/${"p".repeat(17)}${PAIR}q`;
    const html = renderStatusHtml(parseStatusText(`see ${url}`).segments, {
      mention: () => undefined,
      tagUrl: (name) => `https://kopje.test/tags/${name}`,
    });
    expect(html).toContain(`href="${url}"`);
    expect(html).toContain(`<span class="ellipsis">example.com/${"p".repeat(17)}</span>`);
    expect(html.isWellFormed()).toBe(true);
    expect(renderFieldValue(`${"v".repeat(MAX_RAW_LENGTH - 1)}${PAIR}`).isWellFormed()).toBe(true);
  });
});

// Migration 0048_stored_bounds stores P(x) for every covered value (test/migrations.test.ts), and reads present the
// stored value, which P(P(x)) = P(x) makes what a read through P showed before the rewrite. A converted-row fixture
// with every covered column at its bound, past it (all together), of 400,000 U+0001 and with U+0000, stored without
// the triggers as a Store before 0048 holds it, is rewritten and then read whole.
describe("0048_stored_bounds and presented output (RES-2)", () => {
  it("answers every converted row after the rewrite", async () => {
    const h = await community(["alice"]);
    const { token } = h.users.alice;
    await runInDurableObject(h.store, (_instance, state) => {
      const sql = state.storage.sql;
      for (const table of TABLES) {
        sql.exec(`DROP TRIGGER ${table}_bounds_insert`);
        sql.exec(`DROP TRIGGER ${table}_bounds_update`);
      }
      seedBounded(sql);
      sql.exec("UPDATE statuses SET edited_at = '2026-10-02T00:00:00.000Z' WHERE id = ?", STATUS);
    });
    const ids = (table: string) =>
      runInDurableObject(h.store, (_instance, state) =>
        state.storage.sql
          .exec<{ id: string }>(`SELECT id FROM ${table} ORDER BY id`)
          .toArray()
          .map((row) => row.id),
      );
    const paths = [
      ...(await ids("accounts")).filter((id) => id.startsWith("1")).map((id) => `/api/v1/accounts/${id}`),
      ...(await ids("statuses")).filter((id) => id.startsWith("2")).map((id) => `/api/v1/statuses/${id}`),
      `/api/v1/statuses/${STATUS}/history`,
    ];
    const answers = async () => {
      const read: [string, number, string][] = [];
      for (const path of paths) {
        const response = await h.request(path, { headers: { authorization: `Bearer ${token}` } });
        read.push([path, response.status, await response.text()]);
      }
      return read;
    };
    const sql = MIGRATIONS.find((m) => m.name === "0048_stored_bounds")?.sql ?? "";
    const moved = await runInDurableObject(h.store, (_instance, state) => {
      const store = state.storage.sql;
      const count = () => TABLES.map((table) => store.exec<{ n: number }>(movedCountSql(table)).one().n);
      const was = count();
      state.storage.transactionSync(() => store.exec(sql));
      return { was, now: count() };
    });
    expect(moved.was.every((n) => n > 0)).toBe(true);
    expect(moved.now).toEqual([0, 0, 0, 0]);
    const after = await answers();
    expect(after.map(([, status]) => status)).toEqual(paths.map(() => 200));
    const shown = (path: string) =>
      JSON.parse(after.find(([p]) => p === path)?.[2] ?? "null") as Record<string, unknown>;
    // The status at its bounds shows its four attachments, and its history every version.
    expect(shown(`/api/v1/statuses/${STATUS}`).media_attachments).toHaveLength(4);
    expect(shown(`/api/v1/statuses/${STATUS}/history`)).toHaveLength(8);
  }, 120_000);
});

// A display name of lone surrogate bytes at its bound is a fixed point SQLite stores as given, which a value read into
// the Worker and bound again is not (three U+FFFD for each): a profile update that leaves the display name keeps it in
// SQL, and the trigger accepts it.
describe("a legacy display name after 0048_stored_bounds (RES-2)", () => {
  it("keeps the stored bytes through a profile update that does not change the display name", async () => {
    const h = await community(["alice"]);
    const { id, token } = h.users.alice;
    const bytes = () =>
      runInDurableObject(
        h.store,
        (_instance, state) =>
          state.storage.sql
            .exec<{ h: string }>("SELECT hex(CAST(display_name AS BLOB)) AS h FROM accounts WHERE id = ?", id)
            .one().h,
      );
    await runInDurableObject(h.store, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE accounts SET display_name = CAST(? AS TEXT) WHERE id = ?",
        loneSurrogates(DISPLAY_NAME_LIMIT),
        id,
      );
    });
    const stored = await bytes();
    expect(stored).toBe("EDA080".repeat(DISPLAY_NAME_LIMIT));
    const body = new FormData();
    body.set("note", "a new bio");
    const response = await h.request("/api/v1/accounts/update_credentials", bearer(token, { method: "PATCH", body }));
    expect(response.status).toBe(200);
    expect(await bytes()).toBe(stored);
  });
});

// A media URL of lone surrogate bytes within its bound (921 stored bytes, which a read into the Worker would decode to
// 2,721) is copied to the profile within SQL when made the avatar, so the account's trigger accepts it.
describe("a legacy media URL made a profile image after 0048_stored_bounds (RES-2)", () => {
  it("stores the media row's bytes as the avatar", async () => {
    const h = await community(["alice"]);
    const { id, token } = h.users.alice;
    const media = "300000000000000001";
    const url = new Uint8Array([...new TextEncoder().encode("https://kopje.test/m/"), ...loneSurrogates(300)]);
    expect(url.length).toBe(921);
    await runInDurableObject(h.store, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO media_attachments (id, account_id, type, url) VALUES (?, ?, 'image', CAST(? AS TEXT))",
        media,
        id,
        url,
      );
    });
    const credential = { tokenHash: await sha256Hex(token), scope: "write", now: NOW } as const;
    expect(
      await h.store.updateCredentials(BUILD, {
        credential,
        changes: {},
        images: { avatar: media },
        present: { origin: "https://kopje.test" },
        now: NOW,
      }),
    ).toMatchObject({
      status: "ok",
      value: { status: "ok" },
    });
    const stored = await runInDurableObject(h.store, (_instance, state) =>
      state.storage.sql
        .exec<{ avatar: string; media: string }>(
          `SELECT hex(CAST(a.avatar_url AS BLOB)) AS avatar, hex(CAST(m.url AS BLOB)) AS media
					FROM accounts a, media_attachments m WHERE a.id = ? AND m.id = ?`,
          id,
          media,
        )
        .one(),
    );
    expect(stored.avatar).toBe(stored.media);
    expect(stored.avatar.length).toBe(2 * 921);
  });
});

// RES-2 for the instance settings (INSTANCE_SETTING_BOUNDS, migration 0049_instance_bounds): P is idempotent, a
// writer's output is P's fixed point (the triggers accept it), and on normalized inputs (storedText's output) the
// writer and P agree, a writer's null being P's NULL. What the admin write refuses besides (blank after trimming, a
// document that sanitizes to no text, an email's shape, the terms of service's pairing) is tested in
// test/admin-instance.test.ts.
describe("instance setting bounds (RES-2)", () => {
  type Sql = DurableObjectState["storage"]["sql"];
  // Blank characters (BLANK_CODES), and spaces outside the set, which are text.
  const BLANKS = [" ", "\t", "\n", "\v", "\f", "\r"];
  const SETTING_ALPHABET = [...ALPHABET, ...BLANKS, "\u3000", "\u00a0", "\u2028"];
  const settingMix = mixOf(SETTING_ALPHABET);
  const near = (unit: Unit, bound: number) =>
    fc.tuple(fc.constantFrom(bound - 1, bound, bound + 1), settingMix).map(([target, m]) => measured(m, unit, target));
  const blank = fc.array(fc.constantFrom(...BLANKS, "\u3000", "\u00a0", "a"), { maxLength: 8 }).map((c) => c.join(""));
  const text = (bounds: [Unit, number][]) =>
    fc.oneof(blank, fc.string({ unit: "binary", maxLength: 40 }), ...bounds.map(([unit, bound]) => near(unit, bound)));
  // rules as the cutover writes them (JSON.stringify of an array), at INSTANCE_RULES_BYTES, and other JSON.
  const rules = fc.oneof(
    fc
      .array(fc.record({ id: fc.string(), text: fc.string({ unit: "binary" }) }), { maxLength: 4 })
      .map((r) => JSON.stringify(r)),
    fc.jsonValue({ maxDepth: 3 }).map((value) => JSON.stringify(value)),
    fc
      .tuple(fc.constantFrom(-1, 0, 1), settingMix)
      .map(([delta, m]) => JSON.stringify([measured(m, "json", INSTANCE_RULES_BYTES - 2 + delta)])),
    blank,
  );
  const digits = (n: number) => fc.array(fc.constantFrom(..."0123456789"), { minLength: n, maxLength: n });
  const date = fc.oneof(
    fc.tuple(digits(4), digits(2), digits(2)).map(([y, m, d]) => `${y.join("")}-${m.join("")}-${d.join("")}`),
    fc.date({ noInvalidDate: true }).map((d) => d.toISOString().slice(0, 10)),
    fc.string({ maxLength: 12 }),
  );
  const stamp = fc.oneof(
    fc
      .date({ min: new Date(0), max: new Date("9999-12-31T23:59:59.999Z"), noInvalidDate: true })
      .map((d) => d.toISOString()),
    fc
      .tuple(digits(4), digits(2), digits(2), digits(2), digits(2), digits(2), digits(3))
      .map(
        ([y, mo, d, h, mi, s, ms]) =>
          `${y.join("")}-${mo.join("")}-${d.join("")}T${h.join("")}:${mi.join("")}:${s.join("")}.${ms.join("")}Z`,
      ),
    fc.string({ maxLength: 26 }),
  );
  const shown = fc.oneof(fc.constantFrom(...DOMAIN_BLOCKS_SHOWN, "Users", " all", ""), fc.string({ maxLength: 8 }));
  const INPUTS: Record<InstanceSettingName, fc.Arbitrary<string>> = {
    title: text([
      ["points", INSTANCE_TITLE_LIMIT],
      ["bytes", INSTANCE_TITLE_LIMIT],
    ]),
    description: text([
      ["points", INSTANCE_DESCRIPTION_LIMIT],
      ["bytes", INSTANCE_DESCRIPTION_LIMIT],
    ]),
    contact_email: text([["bytes", CONTACT_EMAIL_BYTES]]),
    rules,
    extended_description: text([["bytes", INSTANCE_DOCUMENT_BYTES]]),
    privacy_policy: text([["bytes", INSTANCE_DOCUMENT_BYTES]]),
    terms_of_service: text([["bytes", INSTANCE_DOCUMENT_BYTES]]),
    terms_of_service_effective_date: date,
    show_domain_blocks: shown,
    show_domain_blocks_rationale: shown,
    extended_description_updated_at: stamp,
    privacy_policy_updated_at: stamp,
  };

  // P of ?1, as SQLite stores it (NULL for no row).
  const projected = (sql: Sql, name: InstanceSettingName, value: string) =>
    valueOf(sql, INSTANCE_SETTING_BOUNDS[name].projection("?1"), value);

  for (const name of INSTANCE_SETTING_NAMES) {
    it(`${name}: P is idempotent, the writer's output its fixed point, and on normalized input they agree`, async () => {
      const { projection } = INSTANCE_SETTING_BOUNDS[name];
      await runInDurableObject(freshStore(), (_instance, state) => {
        const sql = state.storage.sql;
        fc.assert(
          fc.property(INPUTS[name], (input) => {
            expect(idempotent(sql, projection, input)).toBe(true);
            const written = storedInstanceSetting(name, input);
            if (written !== null) {
              expect(valueOf(sql, `(${projection("?1")}) IS ?1`, written)).toBe(1);
              expect(written.isWellFormed()).toBe(true);
              expect(written).not.toContain("\u0000");
            }
            const normalized = storedText(input);
            expect(storedInstanceSetting(name, normalized)).toBe(projected(sql, name, normalized));
          }),
          { numRuns: name.endsWith("description") || name.endsWith("policy") || name.endsWith("service") ? 60 : 200 },
        );
      });
    }, 120_000);
  }

  it("counts blank only over its six ASCII characters, in SQL and JS alike", async () => {
    await runInDurableObject(freshStore(), (_instance, state) => {
      for (const [value, blankValue] of [
        [" \t\n\v\f\r", true],
        ["\v", true],
        ["", true],
        ["\u3000", false],
        ["\u00a0", false],
        [" a ", false],
      ] as const) {
        expect(isBlank(value), JSON.stringify(value)).toBe(blankValue);
        expect(projected(state.storage.sql, "title", value), JSON.stringify(value)).toBe(blankValue ? null : value);
        expect(storedInstanceSetting("privacy_policy", value)).toBe(blankValue ? null : value);
      }
      expect(trimBlank("\v\u3000 x \t\r")).toBe("\u3000 x");
    });
  });
});

describe("contact_username (0059_contact_and_activity)", () => {
  const { projection, writer } = CONTACT_SETTING_BOUNDS.contact_username;
  const ADDRESS = fc.stringMatching(/^[-.0-9@A-Z_a-z]{0,12}$/);

  it("repeats REMOTE_USERNAME_LIMIT, and is a username, @ and a domain name of 253 bytes", () => {
    expect(CONTACT_USERNAME_LIMIT).toBe(REMOTE_USERNAME_LIMIT);
    expect(CONTACT_USERNAME_BYTES).toBe(REMOTE_USERNAME_LIMIT + 1 + 253);
  });

  it("P is idempotent and the writer's output its fixed point; they agree on every input", async () => {
    await runInDurableObject(freshStore(), (_instance, state) => {
      const sql = state.storage.sql;
      fc.assert(
        fc.property(
          fc.oneof(ADDRESS, fc.string({ unit: "binary", maxLength: 40 }), fc.constantFrom("a@b", "@a", "a@", "a@@b")),
          (input) => {
            expect(idempotent(sql, projection, input)).toBe(true);
            expect(writer(input)).toBe(valueOf(sql, projection("?1"), input));
            // The migration's CASE-free predicate is P(x) IS NOT x.
            expect(valueOf(sql, `${contactUsernamePastBoundSql("?1")}`, input)).toBe(
              valueOf(sql, `(${projection("?1")}) IS NOT ?1`, input),
            );
            const written = writer(input);
            if (written !== null) {
              expect(valueOf(sql, `(${projection("?1")}) IS ?1`, written)).toBe(1);
            }
          },
        ),
        { numRuns: 500 },
      );
    });
  }, 60_000);

  it("drops NUL, a value past its bytes or its username part, and a value of more or misplaced @", async () => {
    const username = "a".repeat(REMOTE_USERNAME_LIMIT);
    const domain = `${"d".repeat(249)}.com`;
    expect(new TextEncoder().encode(`${username}@${domain}`).length).toBe(CONTACT_USERNAME_BYTES);
    await runInDurableObject(freshStore(), (_instance, state) => {
      const sql = state.storage.sql;
      const cases = [
        [`${username}@${domain}`, true],
        [`${username}@${domain}x`, false],
        [username, true],
        [`${username}a`, false],
        [`${username}a@remote.test`, false],
        ["alice", true],
        ["Bob@remote.test", true],
        ["alice\u0000", false],
        ["al\u0000ice@remote.test", false],
        ["", false],
        ["@alice", false],
        ["alice@", false],
        ["a@b@c", false],
        ["a b", false],
        ["al\u00e9", false],
        ["\u{1F600}", false],
      ] as const;
      for (const [input, kept] of cases) {
        expect(writer(input), JSON.stringify(input)).toBe(kept ? input : null);
        expect(valueOf(sql, projection("?1"), input), JSON.stringify(input)).toBe(kept ? input : null);
      }
      for (const [input, kept] of cases) {
        expect(valueOf(sql, contactUsernamePastBoundSql("?1"), input), JSON.stringify(input)).toBe(kept ? 0 : 1);
      }
      // A value of another storage class reads as NULL, and is past the bound.
      expect(sql.exec(`SELECT ${projection("?1")} AS v`, new Uint8Array([97]).buffer).one().v).toBeNull();
      expect(sql.exec(`SELECT ${contactUsernamePastBoundSql("?1")} AS v`, new Uint8Array([97]).buffer).one().v).toBe(1);
      expect(sql.exec(`SELECT ${projection("?1")} AS v`, 12).one().v).toBeNull();
    });
  });
});

describe("status applications (0064_status_applications)", () => {
  // The bound's value cases for `input` on a local original (no boost, no author row to read).
  const pastBound = (sql: Sql, input: string) =>
    sql
      .exec<{ v: number }>(
        `SELECT ${applicationIdPastBoundSql("r")} AS v
				FROM (SELECT ?1 AS application_id, NULL AS reblog_of_id, NULL AS account_id) r`,
        input,
      )
      .one().v;

  it("derives the name bounds from its code points", () => {
    expect({ bytes: APP_NAME_BYTES, json: APP_NAME_JSON_BYTES }).toEqual({
      bytes: 4 * APP_NAME_LIMIT,
      json: 6 * APP_NAME_LIMIT + 2,
    });
  });

  it("keeps an application id exactly when the trigger accepts it: the writer's output is its fixed point", async () => {
    await runInDurableObject(await migratedStore(), (_instance, state) => {
      const sql = state.storage.sql;
      fc.assert(
        fc.property(
          fc.oneof(
            fc.stringMatching(/^[-0-9A-Za-z_]{0,70}$/),
            fc.string({ unit: "binary", maxLength: 70 }),
            fc.constantFrom("a".repeat(APP_ID_BYTES), "a".repeat(APP_ID_BYTES + 1), "a\u0000", "a*", "[a]", "é"),
          ),
          (input) => {
            const written = storedApplicationId(input);
            expect(written === null ? 1 : 0, JSON.stringify(input)).toBe(pastBound(sql, input));
            if (written !== null) {
              expect(written).toBe(input);
            }
          },
        ),
        { numRuns: 500 },
      );
    });
  }, 60_000);

  it("reads every name the presenter shows whole from SQLite", async () => {
    await runInDurableObject(freshStore(), (_instance, state) => {
      const sql = state.storage.sql;
      fc.assert(
        fc.property(
          fc.oneof(
            fc.string({ unit: "binary", maxLength: 70 }),
            fc.constantFrom(
              "\u0001".repeat(APP_NAME_LIMIT),
              "𠀀".repeat(APP_NAME_LIMIT),
              "x".repeat(APP_NAME_BYTES + 1),
            ),
          ),
          (input) => {
            if (presentedAppName(input) !== null) {
              expect(valueOf(sql, appNameSql("?1"), input)).toBe(input);
            }
          },
        ),
        { numRuns: 500 },
      );
    });
  }, 60_000);
});

describe("media blurhash (0065_media_blurhash)", () => {
  const pastBound = (sql: Sql, input: SqlStorageValue) =>
    sql.exec<{ v: number }>(`SELECT ${blurhashPastBoundSql("?1")} AS v`, input).one().v;
  // Every size flag with its exact length, every character of the alphabet, and the cases around the bound.
  const witnesses = [
    ...[...BASE83].map((flag) => `${flag}${"0".repeat(5)}`),
    ...[...BASE83].map((c) => `${blurhashOf(2, 2)}`.slice(0, -1) + c),
    `U${"0".repeat(34)}\n`,
    `${blurhashOf(1, 1)}\u0000`,
    `${blurhashOf(5, 5)}0`,
    blurhashOf(5, 5).slice(0, -1),
    " ".repeat(6),
    `${blurhashOf(1, 1).slice(0, -1)}\u{1F600}`,
  ];

  it("accepts all 25 component combinations of 1 to 5 at their exact lengths, and none past 5", async () => {
    await runInDurableObject(freshStore(), (_instance, state) => {
      const sql = state.storage.sql;
      for (let x = 1; x <= 9; x++) {
        for (let y = 1; y <= 9; y++) {
          const value = blurhashOf(x, y, "z");
          const kept = x <= 5 && y <= 5;
          expect(storedBlurhash(value), `${x}x${y}`).toBe(kept ? value : null);
          expect(pastBound(sql, value), `${x}x${y}`).toBe(kept ? 0 : 1);
          if (kept) {
            expect([storedBlurhash(`${value}z`), storedBlurhash(value.slice(0, -1))]).toEqual([null, null]);
          }
        }
      }
      expect(blurhashOf(5, 5).length).toBe(BLURHASH_BYTES);
    });
  });

  it("keeps a blurhash exactly when the trigger accepts it: the writer's output is its fixed point", async () => {
    await runInDurableObject(await migratedStore(), (_instance, state) => {
      const sql = state.storage.sql;
      fc.assert(
        fc.property(
          fc.oneof(
            fc.stringMatching(/^[0-9A-Za-z#$%*+,\-.:;=?@[\]^_{|}~]{0,60}$/),
            fc
              .tuple(fc.integer({ min: 1, max: 9 }), fc.integer({ min: 1, max: 9 }), fc.constantFrom("0", "~", "#"))
              .map(([x, y, fill]) => blurhashOf(x, y, fill)),
            fc.string({ unit: "binary", maxLength: 60 }),
            fc.constantFrom(...witnesses),
          ),
          (input) => {
            const written = storedBlurhash(input);
            expect(written === null ? 1 : 0, JSON.stringify(input)).toBe(pastBound(sql, input));
            if (written !== null) {
              expect(written).toBe(input);
              expect(storedBlurhash(written)).toBe(written);
            }
          },
        ),
        { numRuns: 1000 },
      );
      for (const value of [42, null, undefined, {}, ["LEHV6nWB2yk8"]]) {
        expect(storedBlurhash(value)).toBeNull();
      }
      // Malformed UTF-8 an import may hold, past the alphabet whatever it decodes to.
      const malformed = new Uint8Array([0x4c, ...Array(11).fill(0xff)]);
      expect(
        sql.exec<{ v: number }>(`SELECT ${blurhashPastBoundSql("CAST(?1 AS TEXT)")} AS v`, malformed).one().v,
      ).toBe(1);
    });
  }, 60_000);
});
