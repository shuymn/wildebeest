import { describe, expect, it } from "vitest";

import {
  DOMAIN_BLOCKS_LIMIT,
  listAdminDomainBlocks,
  MAX_BLOCK_COMMENT,
  MAX_DOMAIN_BLOCKS_LIMIT,
} from "../src/domain/admin-domain-blocks";
import { MAX_BLOCK_LABELS } from "../src/domain/audience";
import { MAX_DOMAIN_INPUT, MAX_DOMAIN_LENGTH } from "../src/domain/instance-domain-blocks";
import { sha256Hex } from "../src/security/tokens";
import { bearer, form, json, sql, userToken } from "./api-helpers";
import { NOW } from "./app-helpers";
import { rowsRead } from "./read-helpers";
import { world, type World } from "./remote-suspension-helpers";

// The Mastodon admin API's domain blocks and domain allows (Api::V1::Admin::DomainBlocksController and
// DomainAllowsController of Mastodon 4.5.11; domain/admin-domain-blocks.ts): the entity
// (REST::Admin::DomainBlockSerializer), parameters, paging, errors (ExistingDomainBlockErrorSerializer and validation
// failures), the moderation log, and Kopje's refusals (silence, depth, comment length).

const ADMIN_SCOPES = "read write admin:read admin:write";
const BLOCKS = "/api/v1/admin/domain_blocks";

type Answer = { status: number; link: string | null; body: unknown };

async function call(w: World, path: string, init: RequestInit = {}, token: string | null = w.admin): Promise<Answer> {
  const response = await w.h.request(path, token === null ? init : bearer(token, init));
  return { status: response.status, link: response.headers.get("Link"), body: await response.json() };
}

type Entity = Record<string, unknown> & { id: string; domain: string; severity: string };

const create = (w: World, body: Record<string, unknown>) => call(w, BLOCKS, json(body));

const suspendBlock = (w: World, domain: string) => created(w, { domain, severity: "suspend" });

async function created(w: World, body: Record<string, unknown>): Promise<Entity> {
  const answer = await create(w, body);
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return answer.body as Entity;
}

const logRows = (w: World) =>
  sql<{ actor: string; account_id: string; action: string; target_type: string; target_id: string; detail: string }>(
    w.h.store,
    "SELECT actor, account_id, action, target_type, target_id, detail FROM admin_actions WHERE target_type = 'DomainBlock' ORDER BY id",
  );

describe("admin domain blocks", () => {
  it("create a block as Mastodon's entity, from JSON (Fediblockhole) or a form (Fedilab), and show it", async () => {
    const w = await world();
    // Fediblockhole's add_block body: DomainBlock._asdict (fediblockhole/const.py:218-232).
    const block = await created(w, {
      domain: "Bad.Example.",
      severity: "suspend",
      public_comment: "spam",
      private_comment: "",
      reject_media: false,
      reject_reports: true,
      obfuscate: true,
    });
    // domain_block_serializer.rb:4-6, in its attribute order; digest is domain_block.rb:104-106.
    expect(Object.keys(block)).toEqual([
      "id",
      "domain",
      "digest",
      "created_at",
      "severity",
      "reject_media",
      "reject_reports",
      "private_comment",
      "public_comment",
      "obfuscate",
    ]);
    expect(block).toEqual({
      id: expect.stringMatching(/^\d+$/),
      domain: "bad.example",
      digest: await sha256Hex("bad.example"),
      created_at: new Date(NOW).toISOString(),
      severity: "suspend",
      reject_media: false,
      reject_reports: true,
      private_comment: "",
      public_comment: "spam",
      obfuscate: true,
    });
    expect(await call(w, `${BLOCKS}/${block.id}`)).toMatchObject({ status: 200, body: block });
    const noop = await call(w, BLOCKS, form({ domain: "noisy.example", severity: "noop", reject_reports: "1" }));
    expect(noop).toMatchObject({
      status: 200,
      body: { domain: "noisy.example", severity: "noop", reject_reports: true, private_comment: null },
    });
    expect(await logRows(w)).toEqual([
      expect.objectContaining({ actor: "oauth", account_id: w.owner.id, action: "create", target_id: block.id }),
      expect.objectContaining({ action: "create", target_id: (noop.body as Entity).id }),
    ]);
  });

  it("refuse silence (also as the default severity), values outside the list and blank or bad domains with 422", async () => {
    const w = await world();
    const failed = (error: string) => ({ status: 422, body: { error: `Validation failed: ${error}` } });
    const outside = "Severity is not included in the list";
    expect(await create(w, { domain: "a.example", severity: "silence" })).toMatchObject(failed(outside));
    // Mastodon's default severity is silence (domain_block.rb:11).
    expect(await create(w, { domain: "a.example" })).toMatchObject(failed(outside));
    expect(await create(w, { domain: "a.example", severity: "bogus" })).toMatchObject(failed(outside));
    expect(await create(w, { severity: "suspend" })).toMatchObject(failed("Domain can't be blank"));
    expect(await create(w, { domain: "not a domain", severity: "suspend" })).toMatchObject(failed("Domain is invalid"));
    expect(await create(w, {})).toMatchObject(failed(`${outside}, Domain can't be blank`));
    const deep = `${"x.".repeat(MAX_BLOCK_LABELS)}example`;
    expect(await create(w, { domain: deep, severity: "suspend" })).toMatchObject(
      failed(`Domain has more than ${MAX_BLOCK_LABELS} labels`),
    );
    const long = "é".repeat(MAX_BLOCK_COMMENT + 1);
    expect(await create(w, { domain: "a.example", severity: "noop", public_comment: long })).toMatchObject(
      failed(`Public comment is too long (maximum is ${MAX_BLOCK_COMMENT} characters)`),
    );
    expect(await create(w, { domain: "a.example", severity: "noop", private_comment: long.slice(1) })).toMatchObject({
      status: 200,
    });
    expect(await sql(w.h.store, "SELECT domain FROM instance_domain_blocks")).toEqual([{ domain: "a.example" }]);
  });

  it("refuse a duplicate or a block no stricter than its ruling one with ExistingDomainBlockErrorSerializer", async () => {
    const w = await world();
    const parent = await created(w, { domain: "example.org", severity: "suspend" });
    const exists = { error: "You have already imposed stricter limits on example.org.", existing_domain_block: parent };
    // domain_blocks_controller.rb:32-33, 58-60: the same domain, then a weaker child.
    expect(await create(w, { domain: "EXAMPLE.org", severity: "suspend" })).toMatchObject({
      status: 422,
      body: exists,
    });
    expect(await create(w, { domain: "a.example.org", severity: "noop" })).toMatchObject({ status: 422, body: exists });
    // The conflict is answered before the validations, as Mastodon checks it before save!.
    expect(await create(w, { domain: "a.example.org", severity: "silence" })).toMatchObject({
      status: 422,
      body: exists,
    });
    // Under a noop parent, a child is created when it is stricter (DomainBlock#stricter_than?, domain_block.rb:81-87):
    // a suspend, or a noop rejecting at least what the parent rejects.
    await created(w, { domain: "noop.example", severity: "noop", reject_reports: true });
    expect(await create(w, { domain: "a.noop.example", severity: "suspend" })).toMatchObject({ status: 200 });
    expect(await create(w, { domain: "b.noop.example", severity: "noop", reject_reports: true })).toMatchObject({
      status: 200,
    });
    expect(await create(w, { domain: "c.noop.example", severity: "noop" })).toMatchObject({ status: 422 });
  });

  it("update only the fields sent, keep the domain, refuse silence, and log it", async () => {
    const w = await world();
    const block = await created(w, { domain: "up.example", severity: "suspend", public_comment: "kept" });
    const path = `${BLOCKS}/${block.id}`;
    // Fediblockhole's update_known_block sends the whole block, its domain included (__init__.py:606-624).
    const put = await call(
      w,
      path,
      json({ domain: "other.example", severity: "noop", obfuscate: true, reject_media: false }, { method: "PUT" }),
    );
    expect(put).toMatchObject({
      status: 200,
      body: { ...block, severity: "noop", obfuscate: true, public_comment: "kept" },
    });
    const patch = await call(w, path, form({ private_comment: "note" }, { method: "PATCH" }));
    expect(patch.body).toMatchObject({ severity: "noop", obfuscate: true, private_comment: "note" });
    for (const body of [{ severity: "silence" }, { severity: "" }] as Record<string, string>[]) {
      expect((await call(w, path, form(body, { method: "PUT" }))).status, JSON.stringify(body)).toBe(422);
    }
    expect((await call(w, path)).body).toEqual(patch.body);
    expect((await logRows(w)).map((row) => row.action)).toEqual(["create", "update", "update"]);
  });

  it("accept reject_media on create and update, a child stricter than its noop parent by it", async () => {
    const w = await world();
    const parent = await created(w, { domain: "media.example", severity: "noop", reject_media: true });
    expect(parent).toMatchObject({ severity: "noop", reject_media: true, reject_reports: false });
    expect(await call(w, `${BLOCKS}/${parent.id}`)).toMatchObject({ status: 200, body: parent });
    // DomainBlock#stricter_than? (domain_block.rb:81-87): a child without reject_media is not stricter than this
    // parent, one with it and reject_reports is.
    const exists = { status: 422, body: { existing_domain_block: parent } };
    expect(await create(w, { domain: "a.media.example", severity: "noop" })).toMatchObject(exists);
    expect(
      await create(w, { domain: "a.media.example", severity: "noop", reject_media: "1", reject_reports: "1" }),
    ).toMatchObject({ status: 200, body: { reject_media: true, reject_reports: true } });
    const path = `${BLOCKS}/${parent.id}`;
    const off = await call(w, path, form({ reject_media: "false" }, { method: "PUT" }));
    expect(off).toMatchObject({ status: 200, body: { ...parent, reject_media: false } });
    const on = await call(w, path, json({ reject_media: true }, { method: "PATCH" }));
    expect(on).toMatchObject({ status: 200, body: { ...parent, reject_media: true } });
    expect(await sql(w.h.store, "SELECT domain, reject_media FROM instance_domain_blocks ORDER BY domain")).toEqual([
      { domain: "a.media.example", reject_media: 1 },
      { domain: "media.example", reject_media: 1 },
    ]);
    expect((await logRows(w)).map((row) => row.action)).toEqual(["create", "create", "update", "update"]);
  });

  it("delete a block with an empty object, log it, and answer 404 for an id that is no block", async () => {
    const w = await world();
    const block = await created(w, { domain: "gone.example", severity: "noop" });
    expect(await call(w, `${BLOCKS}/${block.id}`, { method: "DELETE" })).toMatchObject({ status: 200, body: {} });
    for (const method of ["GET", "PUT", "PATCH", "DELETE"]) {
      for (const id of [block.id, "x", "99999999999999999999"]) {
        expect(await call(w, `${BLOCKS}/${id}`, { method }), `${method} ${id}`).toMatchObject({
          status: 404,
          body: { error: "Record not found" },
        });
      }
    }
    expect(await logRows(w)).toEqual([
      expect.objectContaining({ action: "create" }),
      expect.objectContaining({ action: "destroy", target_id: block.id, detail: expect.stringContaining("gone") }),
    ]);
  });

  it("answer everyone but the OAuth admin 403, before reading any block", async () => {
    const w = await world();
    const block = await created(w, { domain: "kept.example", severity: "noop" });
    const alice = await userToken(w.h, "alice@example.com", ADMIN_SCOPES);
    for (const token of [null, alice]) {
      for (const [path, init] of [
        [BLOCKS, {}],
        [BLOCKS, json({ domain: "x.example", severity: "suspend" })],
        [`${BLOCKS}/${block.id}`, {}],
        [`${BLOCKS}/${block.id}`, form({ severity: "suspend" }, { method: "PUT" })],
        [`${BLOCKS}/${block.id}`, { method: "DELETE" }],
        [`${BLOCKS}/404`, {}],
      ] as const) {
        expect(await call(w, path, init, token)).toMatchObject({
          status: 403,
          body: { error: "This action is not allowed" },
        });
      }
    }
    expect(await sql(w.h.store, "SELECT domain, severity FROM instance_domain_blocks")).toEqual([
      { domain: "kept.example", severity: "noop" },
    ]);
  });

  it("page newest first by id, with Mastodon's limits and Link header", async () => {
    const w = await world();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.unshift((await created(w, { domain: `p${i}.example`, severity: "noop" })).id);
    }
    const page = async (query: string) => {
      const answer = await call(w, `${BLOCKS}${query}`);
      return { ids: (answer.body as Entity[]).map((block) => block.id), link: answer.link };
    };
    expect((await page("")).ids).toEqual(ids);
    const first = await page("?limit=2");
    expect(first).toEqual({
      ids: ids.slice(0, 2),
      link: `<https://kopje.test${BLOCKS}?limit=2&max_id=${ids[1]}>; rel="next", <https://kopje.test${BLOCKS}?limit=2&min_id=${ids[0]}>; rel="prev"`,
    });
    expect((await page(`?limit=2&max_id=${ids[1]}`)).ids).toEqual(ids.slice(2, 4));
    // The last page is short: no next (records_continue? is a full page), a prev only.
    const last = await page(`?limit=2&max_id=${ids[3]}`);
    expect(last.ids).toEqual(ids.slice(4));
    expect(last.link).toBe(`<https://kopje.test${BLOCKS}?limit=2&min_id=${ids[4]}>; rel="prev"`);
    expect(await page(`?limit=2&max_id=${ids[4]}`)).toEqual({ ids: [], link: null });
    // min_id gives the oldest above it, newest first; since_id the newest above it.
    expect((await page(`?limit=2&min_id=${ids[4]}`)).ids).toEqual(ids.slice(2, 4));
    expect((await page(`?limit=2&since_id=${ids[4]}`)).ids).toEqual(ids.slice(0, 2));
    expect((await page(`?limit=2&min_id=${ids[4]}&since_id=${ids[1]}`)).ids).toEqual(ids.slice(2, 4));
    // limit_param: the absolute value, at most MAX_LIMIT.
    expect((await page("?limit=-3")).ids).toEqual(ids.slice(0, 3));
  });
});

describe("admin domain blocks, bounds", () => {
  it("read at most a page of blocks by primary key, at the first, a middle and the final cursor", async () => {
    const w = await world();
    const n = 3_000;
    await sql(
      w.h.store,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO instance_domain_blocks (domain, severity, created_at, updated_at)
			SELECT 'g' || i || '.example', 'noop', ?2, ?2 FROM n`,
      n,
      new Date(NOW).toISOString(),
    );
    const credential = { tokenHash: await sha256Hex(w.admin), scope: "admin:read:domain_blocks" as const, now: NOW };
    for (const [maxId, want] of [
      [undefined, MAX_DOMAIN_BLOCKS_LIMIT],
      [String(n / 2), MAX_DOMAIN_BLOCKS_LIMIT],
      ["3", 2],
    ] as const) {
      const page = { maxId, limit: MAX_DOMAIN_BLOCKS_LIMIT };
      const read = await rowsRead(w.h, listAdminDomainBlocks, { credential, page });
      // The page itself, plus the authorization's few keyed reads.
      expect(read, String(maxId)).toBeGreaterThanOrEqual(want);
      expect(read, String(maxId)).toBeLessThan(want + 20);
    }
    const answer = await call(w, `${BLOCKS}?limit=${MAX_DOMAIN_BLOCKS_LIMIT}&max_id=${n / 2}`);
    expect((answer.body as Entity[]).length).toBe(MAX_DOMAIN_BLOCKS_LIMIT);
    expect(answer.link).toContain('rel="next"');
    expect(((await call(w, BLOCKS)).body as Entity[]).length).toBe(DOMAIN_BLOCKS_LIMIT);
  });

  it("answer a full page of blocks with the longest comments within a known size", async () => {
    const w = await world();
    // The worst JSON escaping: a control character becomes six bytes (\u0001).
    const comment = "\u0001".repeat(MAX_BLOCK_COMMENT);
    await sql(
      w.h.store,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
			INSERT INTO instance_domain_blocks (domain, severity, private_comment, public_comment, created_at, updated_at)
			SELECT printf('%063d.%063d.%063d.%059d', i, 0, 0, 0), 'noop', ?2, ?2, ?3, ?3 FROM n`,
      MAX_DOMAIN_BLOCKS_LIMIT,
      comment,
      new Date(NOW).toISOString(),
    );
    const response = await w.h.request(`${BLOCKS}?limit=${MAX_DOMAIN_BLOCKS_LIMIT}`, bearer(w.admin));
    const bytes = (await response.arrayBuffer()).byteLength;
    // Two comments of at most 6 bytes per character, a domain of MAX_DOMAIN_LENGTH (251 here), and at most 512
    // bytes of other fields (the digest included), per block.
    expect(bytes).toBeGreaterThan(MAX_DOMAIN_BLOCKS_LIMIT * (2 * 6 * MAX_BLOCK_COMMENT + 251));
    expect(bytes).toBeLessThan(MAX_DOMAIN_BLOCKS_LIMIT * (2 * 6 * MAX_BLOCK_COMMENT + MAX_DOMAIN_LENGTH + 512));
  });

  it("hold a domain to Mastodon's limits, from JSON or a form, before it is normalized or matched", async () => {
    const w = await world();
    const label = (n: number, c = "a") => c.repeat(n);
    // 255 characters with labels of 63 (domain_validator.rb:4-6, 29): the longest domain stored.
    const longest = [label(63), label(63, "b"), label(63, "c"), label(60, "d"), "ex"].join(".");
    expect(longest).toHaveLength(MAX_DOMAIN_LENGTH);
    const invalid = { status: 422, body: { error: "Validation failed: Domain is invalid" } };
    const send = (domain: string, asJson: boolean) =>
      asJson ? create(w, { domain, severity: "noop" }) : call(w, BLOCKS, form({ domain, severity: "noop" }));
    for (const asJson of [true, false]) {
      const prefix = asJson ? "j" : "f";
      // 256 characters, a label of 64, and a raw input past MAX_DOMAIN_INPUT (refused before normalizing).
      for (const domain of [
        `${prefix}${longest}`,
        `${label(64)}.${prefix}.example`,
        `${"x".repeat(MAX_DOMAIN_INPUT)}.${prefix}.example`,
        `${"a.".repeat(30_000)}${prefix}.example`,
      ]) {
        expect(await send(domain, asJson), `${domain.length}`).toMatchObject(invalid);
      }
    }
    const created = await w.h.request(
      BLOCKS,
      bearer(w.admin, json({ domain: ` ${longest.toUpperCase()}. `, severity: "noop" })),
    );
    expect(created.status).toBe(200);
    const text = await created.text();
    expect((JSON.parse(text) as Entity).domain).toBe(longest);
    // The entity of the longest domain: the domain, its digest and the other fields.
    expect(new TextEncoder().encode(text).byteLength).toBeLessThan(MAX_DOMAIN_LENGTH + 512);
    expect((await call(w, BLOCKS, form({ domain: `${label(63)}.f.example`, severity: "noop" }))).status).toBe(200);
    // Depth is refused before any ruling block is looked up: a deep child of a blocked parent is not a conflict.
    await suspendBlock(w, "parent.example");
    expect(
      await create(w, { domain: `${"a.".repeat(MAX_BLOCK_LABELS)}parent.example`, severity: "noop" }),
    ).toMatchObject({
      status: 422,
      body: { error: `Validation failed: Domain has more than ${MAX_BLOCK_LABELS} labels` },
    });
  });
});

describe("admin domain allows", () => {
  it("list none to the OAuth admin, refuse a create, and find no allow, as without limited federation mode", async () => {
    const w = await world();
    const alice = await userToken(w.h, "alice@example.com", ADMIN_SCOPES);
    const allows = "/api/v1/admin/domain_allows";
    expect(await call(w, allows)).toMatchObject({ status: 200, body: [] });
    for (const token of [null, alice]) {
      expect(await call(w, allows, {}, token)).toMatchObject({ status: 403 });
    }
    for (const token of [w.admin, alice, null]) {
      expect(await call(w, allows, form({ domain: "a.example" }), token)).toMatchObject({
        status: 403,
        body: { error: "This action is not allowed" },
      });
      for (const method of ["GET", "DELETE"]) {
        expect(await call(w, `${allows}/1`, { method }, token)).toMatchObject({
          status: 404,
          body: { error: "Record not found" },
        });
      }
    }
  });
});
