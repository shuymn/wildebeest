import { describe, expect, it } from "vitest";

import { createKeyring } from "../src/security/keyring";
import { bearer, json, sql } from "./api-helpers";
import { LEGACY } from "./federation-helpers";
import { act, community, outbound, post, remoteAccount, remoteFollows, seedStatus } from "./status-helpers";

// VIS-4: /ap/o/:uuid serves local public and unlisted statuses only, as the Note of their outbound Create; the
// outbox lists the same. Everything else answers 404, as Mastodon does for an unauthenticated fetch.

const AP = { headers: { accept: "application/activity+json" } };

function path(uri: string): string {
  const url = new URL(uri);
  return `${url.pathname}${url.search}`;
}

async function fetchObject(h: Awaited<ReturnType<typeof community>>, uri: string) {
  const response = await h.request(path(uri), AP);
  return {
    status: response.status,
    body: response.status === 200 ? await response.json<Record<string, unknown>>() : null,
  };
}

describe("object endpoint (VIS-4)", () => {
  it("serves a public status as the Note of its Create", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const fan = await remoteAccount(h.store, "fan", "fans.example");
    await remoteFollows(h.store, fan, alice.id);
    const status = await post(h, alice, { status: "hello #kopje", spoiler_text: "cw" });
    const response = await h.request(path(status.uri as string), AP);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^application\/activity\+json/);
    const note = await response.json<Record<string, unknown>>();
    const [create] = await outbound(h.store);
    const sent = create?.activity.object as Record<string, unknown>;
    expect(note).toMatchObject({
      id: sent.id,
      type: "Note",
      attributedTo: sent.attributedTo,
      content: sent.content,
      summary: "cw",
      to: sent.to,
      cc: sent.cc,
      url: sent.url,
    });
  });

  it("serves unlisted, and answers 404 for private, direct, limited, boosts, remote and suspended", async () => {
    const h = await community(["alice", "bob"]);
    const { alice, bob } = h.users;
    await remoteAccount(h.store, "carol", "carol.example");
    const unlisted = await post(h, alice, { status: "quiet", visibility: "unlisted" });
    expect((await fetchObject(h, unlisted.uri as string)).status).toBe(200);

    const hidden: string[] = [];
    for (const visibility of ["private", "direct"]) {
      hidden.push((await post(h, alice, { status: `@carol@carol.example ${visibility}`, visibility })).uri as string);
    }
    const limited = await post(h, alice, { status: "limited later", visibility: "direct" });
    await sql(h.store, "UPDATE statuses SET visibility = 'limited' WHERE id = ?", limited.id);
    hidden.push(limited.uri as string);
    const original = await post(h, bob, { status: "boost me" });
    const boost = await (await act(h, alice, `/api/v1/statuses/${original.id}/reblog`)).json<{ uri: string }>();
    hidden.push(boost.uri);
    // A remote status, even under a path that looks local.
    const remote = await remoteAccount(h.store, "dave", "remote.example");
    await seedStatus(h.store, {
      accountId: remote,
      visibility: "public",
      uri: "https://kopje.test/ap/o/00000000-0000-4000-8000-000000000001",
    });
    hidden.push("https://kopje.test/ap/o/00000000-0000-4000-8000-000000000001");
    const suspended = await post(h, bob, { status: "before suspension" });
    await sql(h.store, "UPDATE local_accounts SET suspended_at = '2026-10-12T00:00:00Z' WHERE account_id = ?", bob.id);
    hidden.push(suspended.uri as string);
    hidden.push("https://kopje.test/ap/o/no-such-object", "https://kopje.test/ap/o/..%2F..%2Factor");

    for (const uri of hidden) {
      expect((await fetchObject(h, uri)).status, uri).toBe(404);
    }
  });

  it("lists public and unlisted statuses and boosts in the outbox, newest first", async () => {
    const h = await community(["alice", "bob"]);
    const { alice, bob } = h.users;
    const first = await post(h, alice, { status: "first" });
    await post(h, alice, { status: "private", visibility: "private" });
    const original = await post(h, bob, { status: "boost me" });
    await act(h, alice, `/api/v1/statuses/${original.id}/reblog`);
    const quiet = await post(h, alice, { status: "quiet", visibility: "unlisted" });

    const collection = await h.request("/ap/users/alice/outbox", AP);
    expect(collection.status).toBe(200);
    const outbox = await collection.json<{ type: string; totalItems: number; first: string }>();
    // totalItems is the account's statuses_count, as Mastodon's OutboxesController gives it; the pages list only what
    // may be served.
    const count = (
      await sql<{ count: number }>(h.store, "SELECT statuses_count AS count FROM accounts WHERE id = ?", alice.id)
    )[0]?.count;
    expect(outbox).toMatchObject({ type: "OrderedCollection", totalItems: count });
    expect(count).toBeGreaterThanOrEqual(4);
    const page = await (
      await h.request(path(outbox.first), AP)
    ).json<{
      orderedItems: { type: string; object: unknown }[];
    }>();
    expect(page.orderedItems.map((item) => item.type)).toEqual(["Create", "Announce", "Create"]);
    expect((page.orderedItems[0]!.object as { id: string }).id).toBe(quiet.uri);
    expect(page.orderedItems[1]?.object).toBe(original.uri);
    expect((page.orderedItems[2]!.object as { id: string }).id).toBe(first.uri);
    expect(JSON.stringify(page)).not.toContain("private");

    expect((await h.request("/ap/users/Alice/outbox", AP)).status).toBe(404);
    expect((await h.request("/ap/users/nobody/outbox", AP)).status).toBe(404);
  });

  it("keeps sensitivity, tags, attachments, timestamps and replies through the JSON-LD round trip", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const parent = await post(h, alice, { status: "parent" });
    const status = await post(h, alice, {
      status: "reply #kopje",
      spoiler_text: "cw",
      in_reply_to_id: parent.id,
    });
    await h.request(
      `/api/v1/statuses/${status.id}`,
      bearer(alice.token, json({ status: "reply #kopje edited", spoiler_text: "cw" }, { method: "PUT" })),
    );
    // Attached after the edit, which replaces the media list.
    await sql(
      h.store,
      `INSERT INTO media_attachments (id, account_id, status_id, type, url, description)
			VALUES ('100000000000000999', ?, ?, 'image', 'https://kopje.test/media/1.png', 'a cat')`,
      alice.id,
      status.id,
    );
    const { status: code, body } = await fetchObject(h, status.uri as string);
    expect(code).toBe(200);
    expect(body).toMatchObject({
      type: "Note",
      sensitive: true,
      summary: "cw",
      inReplyTo: parent.uri,
      published: expect.stringMatching(/^2026-10-12T/),
      updated: expect.stringMatching(/^2026-10-12T/),
      tag: [{ type: "Hashtag", name: "#kopje", href: "https://kopje.test/tags/kopje" }],
      attachment: [expect.objectContaining({ type: "Document", url: "https://kopje.test/media/1.png", name: "a cat" })],
    });
    expect(String(body?.content)).toContain("edited");
  });

  it("answers 404 for hidden objects to signed requests too", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    await remoteAccount(h.store, "carol", "carol.example");
    const hidden = await post(h, alice, { status: "@carol@carol.example psst", visibility: "direct" });
    const signer = await createKeyring(LEGACY.kek).signerFor({
      ...LEGACY,
      keyId: new URL("https://carol.example/users/carol#main-key"),
    });
    const signed = await signer.sign(new Request(hidden.uri as string, AP));
    expect(signed.headers.get("signature")).not.toBeNull();
    const response = await h.request(path(hidden.uri as string), { headers: signed.headers });
    expect(response.status).toBe(404);
  });

  it("pages the outbox", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const posted: string[] = [];
    for (let i = 0; i < 25; i++) {
      h.now.mockReturnValue(Date.parse("2026-10-12T00:00:00.000Z") + i * 1000);
      posted.push((await post(h, alice, { status: `post ${i}` })).uri as string);
    }
    const outbox = await (
      await h.request("/ap/users/alice/outbox", AP)
    ).json<{
      totalItems: number;
      first: string;
    }>();
    expect(outbox.totalItems).toBe(25);
    type Page = { orderedItems: { object: { id: string } }[]; next?: string };
    const first = await (await h.request(path(outbox.first), AP)).json<Page>();
    expect(first.orderedItems).toHaveLength(20);
    expect(first.next).toBeDefined();
    const second = await (await h.request(path(first.next ?? ""), AP)).json<Page>();
    expect(second.orderedItems).toHaveLength(5);
    expect(second.next).toBeUndefined();
    expect([...first.orderedItems, ...second.orderedItems].map((item) => item.object.id)).toEqual(posted.toReversed());
  });
});
