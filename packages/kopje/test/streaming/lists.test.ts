import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { Db } from "../../src/db/sql";
import { streamDelete } from "../../src/domain/streaming";
import { type ApiHarness, bearer, json, sql } from "../api-helpers";
import { NOW } from "../app-helpers";
import { BUILD } from "../helpers";
import { act, community, follow, getJson, post, type User } from "../status-helpers";
import { connect, drained, type Inbox, settled, type StreamMessage, subscribed } from "./stream-helpers";

// The `list` stream: `update` and `status.update` when the list's read positioned
// at the status returns it (R33: the list must be the viewer's), and `delete` as its capture allowed and while the list
// is still the viewer's (R32). The stream is echoed as ["list", id], the id as the client sent it. Absence is proved
// with the drain barrier.

async function createList(h: ApiHarness, user: User, members: string[], exclusive = false): Promise<string> {
  const response = await act(h, user, "/api/v1/lists", { title: "list", exclusive });
  expect(response.status).toBe(200);
  const { id } = await response.json<{ id: string }>();
  expect((await act(h, user, `/api/v1/lists/${id}/accounts`, { account_ids: members })).status).toBe(200);
  return id;
}

async function listen(h: ApiHarness, token: string, list: string, ...streams: string[]): Promise<Inbox> {
  const inbox = await subscribed(h, token, ...streams);
  inbox.send({ type: "subscribe", stream: "list", list });
  await settled(h, inbox);
  return inbox;
}

// The messages left on a socket, as [stream, event, the payload's status id (or the deleted id)].
function events(inbox: Inbox): [string, string | undefined, string][] {
  return inbox.rest().map((m) => [(m.stream ?? []).join(" "), m.event, idOf(m)]);
}

function idOf(m: StreamMessage): string {
  const payload: unknown = JSON.parse(m.payload ?? "null");
  return typeof payload === "string" ? payload : ((payload as { id?: string } | null)?.id ?? "");
}

describe("subscribing to a list", () => {
  it("needs the list parameter, a list id, and the viewer's own list", async () => {
    const h = await community(["alice", "bob"]);
    await follow(h, h.users.bob, h.users.alice.id);
    const bobs = await createList(h, h.users.bob, [h.users.alice.id]);
    const inbox = await connect(h, h.users.alice.token);
    inbox.send({ type: "subscribe", stream: "list" });
    expect(await inbox.next()).toEqual({ error: "Missing list name parameter", status: 400 });
    inbox.send({ type: "subscribe", stream: "list", list: "x".repeat(20) });
    expect(await inbox.next()).toEqual({ error: "Invalid parameter", status: 400 });
    inbox.send({ type: "subscribe", stream: "list", list: bobs });
    expect(await inbox.next()).toEqual({ error: "Not authorized to stream this list", status: 401 });
    await settled(h, inbox);
    expect(await sql(h.store, "SELECT stream_key FROM stream_subscriptions")).toEqual([]);
    // Only read:statuses is needed (not read:lists), and the key is recorded.
    const own = await createList(h, h.users.alice, []);
    inbox.send({ type: "subscribe", stream: ["list"], list: own });
    await settled(h, inbox);
    expect(await sql(h.store, "SELECT stream_key FROM stream_subscriptions")).toEqual([{ stream_key: `list:${own}` }]);
    inbox.send({ type: "unsubscribe", stream: "list", list: own });
    await settled(h, inbox);
    expect(await sql(h.store, "SELECT stream_key FROM stream_subscriptions")).toEqual([]);
  });
});

describe("update and status.update on a list", () => {
  it("sends what enters the list, echoed with its id, and nothing the list's read leaves out", async () => {
    const h = await community(["alice", "bob", "carol", "dave"]);
    await follow(h, h.users.alice, h.users.bob.id);
    await follow(h, h.users.alice, h.users.carol.id);
    const list = await createList(h, h.users.alice, [h.users.bob.id]);
    // Only the list: no `user` subscription, so the journal is armed by the list alone.
    const inbox = await listen(h, h.users.alice.token, list);

    // Not in the list: a followed account who is no member, an account alice does not follow, and bob's reply to dave
    // (the list's replies_policy is `list`).
    await post(h, h.users.carol, { status: "not a member", visibility: "public" });
    await post(h, h.users.dave, { status: "not followed", visibility: "public" });
    const daves = await post(h, h.users.dave, { status: "to reply to", visibility: "public" });
    await post(h, h.users.bob, { status: "a reply", visibility: "public", in_reply_to_id: daves.id });
    await drained(h, inbox);
    expect(events(inbox)).toEqual([]);

    const shown = await post(h, h.users.bob, { status: "for followers", visibility: "private" });
    await drained(h, inbox);
    expect(events(inbox)).toEqual([[`list ${list}`, "update", shown.id]]);
    // The payload is the status as REST presents it to alice.
    const rest = await getJson(h, `/api/v1/statuses/${shown.id}`, h.users.alice.token);
    expect(JSON.parse((await inbox.next()).payload!)).toEqual(rest.body);

    const response = await h.request(
      `/api/v1/statuses/${shown.id}`,
      bearer(h.users.bob.token, json({ status: "edited" }, { method: "PUT" })),
    );
    expect(response.status).toBe(200);
    await drained(h, inbox);
    expect(events(inbox)).toEqual([[`list ${list}`, "status.update", shown.id]]);
  });

  it("sends a status on home and on each list that holds it, presented once; an exclusive list keeps it off home", async () => {
    const h = await community(["alice", "bob", "carol"]);
    await follow(h, h.users.alice, h.users.bob.id);
    await follow(h, h.users.alice, h.users.carol.id);
    const first = await createList(h, h.users.alice, [h.users.bob.id]);
    const second = await createList(h, h.users.alice, [h.users.bob.id]);
    const exclusive = await createList(h, h.users.alice, [h.users.carol.id], true);
    const inbox = await listen(h, h.users.alice.token, first, "user");
    inbox.send({ type: "subscribe", stream: "list", list: second });
    inbox.send({ type: "subscribe", stream: "list", list: exclusive });
    await settled(h, inbox);

    const bobs = await post(h, h.users.bob, { status: "everywhere", visibility: "public" });
    const carols = await post(h, h.users.carol, { status: "exclusive", visibility: "public" });
    await drained(h, inbox);
    expect(events(inbox)).toEqual([
      ["user", "update", bobs.id],
      [`list ${first}`, "update", bobs.id],
      [`list ${second}`, "update", bobs.id],
      [`list ${exclusive}`, "update", carols.id],
    ]);
  });

  it("sends nothing on a list deleted or emptied before the turn", async () => {
    const h = await community(["alice", "bob"]);
    await follow(h, h.users.alice, h.users.bob.id);
    const list = await createList(h, h.users.alice, [h.users.bob.id]);
    const inbox = await listen(h, h.users.alice.token, list);
    await sql(h.store, "DELETE FROM lists WHERE id = ?", list);
    // The subscription stays recorded, so the status is journaled; the unit finds the list gone.
    await post(h, h.users.bob, { status: "after the list went", visibility: "public" });
    expect(await sql(h.store, "SELECT count(*) AS n FROM stream_events WHERE kind = 'status'")).not.toEqual([{ n: 0 }]);
    await drained(h, inbox);
    expect(events(inbox)).toEqual([]);
  });
});

describe("delete on a list", () => {
  it("sends a delete on the lists whose read held the status at the capture, and none on a list deleted since", async () => {
    const h = await community(["alice", "bob", "carol"]);
    await follow(h, h.users.alice, h.users.bob.id);
    await follow(h, h.users.carol, h.users.bob.id);
    const holding = await createList(h, h.users.alice, [h.users.bob.id]);
    const other = await createList(h, h.users.alice, []);
    const carols = await createList(h, h.users.carol, [h.users.bob.id]);
    const inbox = await listen(h, h.users.alice.token, holding);
    inbox.send({ type: "subscribe", stream: "list", list: other });
    await settled(h, inbox);
    const carol = await listen(h, h.users.carol.token, carols);
    const status = await post(h, h.users.bob, { status: "deleted", visibility: "public" });
    await drained(h, inbox, carol);
    expect([events(inbox), events(carol)]).toEqual([
      [[`list ${holding}`, "update", status.id]],
      [[`list ${carols}`, "update", status.id]],
    ]);
    const seen = [inbox.messages.length, carol.messages.length];

    // The capture, with no turn yet; then carol's list goes before the delete is sent.
    await runInDurableObject(h.store, (_instance, state) => {
      state.storage.transactionSync(() => streamDelete(new Db(state.storage.sql), status.id, NOW));
    });
    expect(
      await sql(h.store, "SELECT account_id, lists, boosts FROM stream_delete_viewers ORDER BY account_id"),
    ).toEqual([
      { account_id: h.users.alice.id, lists: JSON.stringify([holding]), boosts: "[]" },
      { account_id: h.users.carol.id, lists: JSON.stringify([carols]), boosts: "[]" },
    ]);
    await sql(h.store, "DELETE FROM lists WHERE id = ?", carols);
    await h.store.streamTick(BUILD);
    await drained(h, inbox, carol);
    const sent = (box: Inbox, from: number) =>
      box.messages
        .slice(from)
        .filter((m) => m.event !== undefined)
        .map((m) => [m.stream, m.event, m.payload]);
    expect(sent(inbox, seen[0]!)).toEqual([[["list", holding], "delete", status.id]]);
    expect(sent(carol, seen[1]!)).toEqual([]);
  });
});
