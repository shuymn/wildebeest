import { describe, expect, it, vi } from "vitest";

import { publishScheduled } from "../src/jobs/scheduled";
import type { StoreStub } from "../src/platform/store-client";
import { type ApiHarness, bearer, json, sql } from "./api-helpers";
import { NOW } from "./app-helpers";
import { BUILD } from "./helpers";
import { scopedToken } from "./read-helpers";
import {
  act,
  community,
  follow,
  getJson,
  outbound,
  post,
  remoteAccount,
  remoteFollows,
  seedStatus,
  type Status,
  type User,
} from "./status-helpers";

// Quote policies (R36's policy part; Mastodon 4.5's Api::InteractionPoliciesConcern, Status::InteractionPolicyConcern,
// Statuses::InteractionPoliciesController, REST::StatusSerializer#quote_approval, the credential and preferences
// serializers): what a local author chooses, how it is stored (statuses.quote_policy, Mastodon's bit flags) and how
// every status shows it (quote_approval).

type QuoteApproval = { automatic: string[]; manual: string[]; current_user: string };
type PolicyStatus = Status & { quote_approval: QuoteApproval; edited_at: string | null };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// Mastodon's stored values: automatic approval in the high 16 bits, each of unsupported_policy (1), public (2),
// followers (4) and following (8).
const PUBLIC = 2 << 16;
const FOLLOWERS = 4 << 16;
const FLAGS = ["unsupported_policy", "public", "followers", "following"] as const;

const CHOICES = [
  ["public", PUBLIC],
  ["followers", FOLLOWERS],
  ["nobody", 0],
] as const;

async function stored(store: StoreStub, id: string): Promise<number | undefined> {
  return (await sql<{ quote_policy: number }>(store, "SELECT quote_policy FROM statuses WHERE id = ?", id))[0]
    ?.quote_policy;
}

async function setDefault(h: ApiHarness, user: User, policy: string): Promise<void> {
  const response = await h.request(
    "/api/v1/accounts/update_credentials",
    bearer(user.token, json({ source: { quote_policy: policy } }, { method: "PATCH" })),
  );
  expect(response.status).toBe(200);
}

function send(h: ApiHarness, token: string, method: string, path: string, body: Record<string, unknown> = {}) {
  return h.request(path, bearer(token, json(body, { method })));
}

async function refusal(response: Response): Promise<{ status: number; body: unknown }> {
  return { status: response.status, body: await response.json() };
}

// current_user: what R36 answers the viewer (the author of their own public, unlisted or private status: automatic).
function approvalOf(automatic: string[], current = "automatic"): QuoteApproval {
  return { automatic, manual: [], current_user: current };
}

describe("POST /api/v1/statuses quote_approval_policy", () => {
  it("stores public, followers or nobody, and shows it in quote_approval", async () => {
    const h = await community(["alice"]);
    for (const [name, value] of CHOICES) {
      const status = (await post(h, h.users.alice, {
        status: name,
        quote_approval_policy: name,
      })) as PolicyStatus;
      expect(await stored(h.store, status.id)).toBe(value);
      expect(status.quote_approval).toEqual(approvalOf(name === "nobody" ? [] : [name]));
    }
  });

  it("takes the account's default when none is sent, or a blank one", async () => {
    const h = await community(["alice"]);
    const first = await post(h, h.users.alice, { status: "default" });
    expect(await stored(h.store, first.id)).toBe(PUBLIC);
    await setDefault(h, h.users.alice, "followers");
    const second = await post(h, h.users.alice, { status: "default again" });
    const blank = await post(h, h.users.alice, { status: "blank", quote_approval_policy: "" });
    expect(await stored(h.store, second.id)).toBe(FOLLOWERS);
    expect(await stored(h.store, blank.id)).toBe(FOLLOWERS);
    // A chosen policy wins over the default.
    const chosen = await post(h, h.users.alice, { status: "chosen", quote_approval_policy: "public" });
    expect(await stored(h.store, chosen.id)).toBe(PUBLIC);
  });

  it("refuses any other value with 422 and writes nothing", async () => {
    const h = await community(["alice"]);
    for (const policy of ["everyone", "following", "PUBLIC", "unsupported_policy"]) {
      const response = await act(h, h.users.alice, "/api/v1/statuses", {
        status: "x",
        quote_approval_policy: policy,
      });
      expect(await refusal(response)).toEqual({ status: 422, body: { error: "Record invalid" } });
    }
    expect(await sql(h.store, "SELECT id FROM statuses")).toEqual([]);
  });

  it("stores nobody for a private or direct status, whatever was chosen or defaulted", async () => {
    const h = await community(["alice", "bob"]);
    for (const visibility of ["private", "direct"]) {
      for (const policy of ["public", "followers", undefined]) {
        const status = (await post(h, h.users.alice, {
          status: `@bob ${visibility}`,
          visibility,
          ...(policy === undefined ? {} : { quote_approval_policy: policy }),
        })) as PolicyStatus;
        expect(await stored(h.store, status.id)).toBe(0);
        // Its author may quote a private status of theirs, never a direct one (R36).
        expect(status.quote_approval).toEqual(approvalOf([], visibility === "direct" ? "denied" : "automatic"));
      }
    }
    // Unlisted is distributable: its policy is kept.
    const unlisted = await post(h, h.users.alice, {
      status: "unlisted",
      visibility: "unlisted",
      quote_approval_policy: "followers",
    });
    expect(await stored(h.store, unlisted.id)).toBe(FOLLOWERS);
  });
});

describe("scheduled statuses carry the quote policy", () => {
  function round(h: ApiHarness, now: number) {
    return publishScheduled(h.env, {
      build: () => BUILD,
      now: () => now,
      store: () => h.store,
      doorbell: vi.fn(() => Promise.resolve()),
    });
  }

  async function schedule(h: ApiHarness, user: User, body: Record<string, unknown>) {
    const response = await act(h, user, "/api/v1/statuses", {
      scheduled_at: new Date(NOW + HOUR).toISOString(),
      ...body,
    });
    return {
      status: response.status,
      body: (await response.json()) as { id: string; params: Record<string, unknown> },
    };
  }

  async function published(h: ApiHarness, text: string): Promise<number | undefined> {
    return (
      await sql<{ quote_policy: number }>(h.store, "SELECT quote_policy FROM statuses WHERE source_text = ?", text)
    )[0]?.quote_policy;
  }

  it("keeps the chosen policy, or the default when the post is scheduled, and publishes with it", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    for (const [name] of CHOICES) {
      const answer = await schedule(h, alice, { status: name, quote_approval_policy: name });
      expect(answer.status).toBe(200);
      expect(answer.body.params.quote_approval_policy).toBe(name);
    }
    const absent = await schedule(h, alice, { status: "absent" });
    expect(absent.body.params.quote_approval_policy).toBe("public");
    // The default is resolved when the post is scheduled, as Mastodon's controller resolves it: a later change of
    // the default does not reach it.
    await setDefault(h, alice, "nobody");
    const later = await schedule(h, alice, { status: "later" });
    expect(later.body.params.quote_approval_policy).toBe("nobody");
    await setDefault(h, alice, "followers");
    expect(
      (
        await getJson<{ params: Record<string, unknown> }>(
          h,
          `/api/v1/scheduled_statuses/${absent.body.id}`,
          alice.token,
        )
      ).body.params.quote_approval_policy,
    ).toBe("public");

    await round(h, NOW + 2 * HOUR);
    expect(await published(h, "public")).toBe(PUBLIC);
    expect(await published(h, "followers")).toBe(FOLLOWERS);
    expect(await published(h, "nobody")).toBe(0);
    expect(await published(h, "absent")).toBe(PUBLIC);
    expect(await published(h, "later")).toBe(0);
  });

  it("refuses any other value with 422 and keeps nothing", async () => {
    const h = await community(["alice"]);
    expect(await schedule(h, h.users.alice, { status: "x", quote_approval_policy: "anyone" })).toEqual({
      status: 422,
      body: { error: "Record invalid" },
    });
    expect(await sql(h.store, "SELECT id FROM scheduled_statuses")).toEqual([]);
  });

  it("publishes a private or direct status with nobody", async () => {
    const h = await community(["alice", "bob"]);
    for (const visibility of ["private", "direct"]) {
      const answer = await schedule(h, h.users.alice, {
        status: `@bob ${visibility}`,
        visibility,
        quote_approval_policy: "public",
      });
      expect(answer.body.params.quote_approval_policy).toBe("public");
    }
    await round(h, NOW + 2 * HOUR);
    expect(await published(h, "@bob private")).toBe(0);
    expect(await published(h, "@bob direct")).toBe(0);
  });
});

describe("PUT /api/v1/statuses/:id quote_approval_policy", () => {
  it("stores the policy only when one is sent", async () => {
    const h = await community(["alice"]);
    const { alice } = h.users;
    const status = await post(h, alice, { status: "one", quote_approval_policy: "followers" });
    for (const [name, value] of [...CHOICES, ["followers", FOLLOWERS] as const]) {
      const response = await send(h, alice.token, "PUT", `/api/v1/statuses/${status.id}`, {
        status: `one ${name}`,
        quote_approval_policy: name,
      });
      expect(response.status).toBe(200);
      expect((await response.json<PolicyStatus>()).quote_approval).toEqual(approvalOf(value === 0 ? [] : [name]));
      expect(await stored(h.store, status.id)).toBe(value);
    }
    // None sent, or a blank one: the policy stays.
    for (const body of [{ status: "two" }, { status: "three", quote_approval_policy: "" }]) {
      expect((await send(h, alice.token, "PUT", `/api/v1/statuses/${status.id}`, body)).status).toBe(200);
      expect(await stored(h.store, status.id)).toBe(FOLLOWERS);
    }
    const response = await send(h, alice.token, "PUT", `/api/v1/statuses/${status.id}`, {
      status: "four",
      quote_approval_policy: "friends",
    });
    expect(await refusal(response)).toEqual({ status: 422, body: { error: "Record invalid" } });
    expect(await stored(h.store, status.id)).toBe(FOLLOWERS);
    expect(
      (await sql<{ source_text: string }>(h.store, "SELECT source_text FROM statuses WHERE id = ?", status.id))[0],
    ).toEqual({ source_text: "three" });
  });

  it("stores nobody for a private status", async () => {
    const h = await community(["alice"]);
    const status = await post(h, h.users.alice, { status: "mine", visibility: "private" });
    const response = await send(h, h.users.alice.token, "PUT", `/api/v1/statuses/${status.id}`, {
      status: "mine",
      quote_approval_policy: "public",
    });
    expect(response.status).toBe(200);
    expect(await stored(h.store, status.id)).toBe(0);
  });

  it("stores a change of the policy alone with no history entry or edited_at, and sends an Update", async () => {
    const h = await community(["alice"]);
    await remoteFollows(h.store, await remoteAccount(h.store, "rem"), h.users.alice.id);
    const status = await post(h, h.users.alice, { status: "same" });
    expect((await outbound(h.store)).map((row) => row.activity.type)).toEqual(["Create"]);
    const response = await send(h, h.users.alice.token, "PUT", `/api/v1/statuses/${status.id}`, {
      status: "same",
      quote_approval_policy: "nobody",
    });
    const edited = await response.json<PolicyStatus>();
    expect(edited.edited_at).toBeNull();
    expect(edited.quote_approval).toEqual(approvalOf([]));
    expect(await stored(h.store, status.id)).toBe(0);
    expect(await sql(h.store, "SELECT id FROM status_edits")).toEqual([]);
    expect((await outbound(h.store)).map((row) => row.activity.type)).toEqual(["Create", "Update"]);
  });
});

describe("PUT and PATCH /api/v1/statuses/:id/interaction_policy", () => {
  describe.for(["PUT", "PATCH"])("%s", (method) => {
    it("stores each policy, and the default when none is sent, and answers with the status", async () => {
      const h = await community(["alice"]);
      const { alice } = h.users;
      // A remote follower, so a Create (and any Update) of alice's status is recorded for delivery.
      await remoteFollows(h.store, await remoteAccount(h.store, "rem"), alice.id);
      const status = await post(h, alice, { status: "mine", quote_approval_policy: "nobody" });
      const path = `/api/v1/statuses/${status.id}/interaction_policy`;
      for (const [name, value] of CHOICES) {
        const response = await send(h, alice.token, method, path, { quote_approval_policy: name });
        expect(response.status).toBe(200);
        const body = await response.json<PolicyStatus>();
        expect(body.id).toBe(status.id);
        expect(body.quote_approval).toEqual(approvalOf(value === 0 ? [] : [name]));
        expect(await stored(h.store, status.id)).toBe(value);
      }
      // None sent, or a blank one: the account's default.
      await setDefault(h, alice, "followers");
      expect((await send(h, alice.token, method, path, { quote_approval_policy: "nobody" })).status).toBe(200);
      expect((await send(h, alice.token, method, path)).status).toBe(200);
      expect(await stored(h.store, status.id)).toBe(FOLLOWERS);
      await setDefault(h, alice, "public");
      expect((await send(h, alice.token, method, path, { quote_approval_policy: "" })).status).toBe(200);
      expect(await stored(h.store, status.id)).toBe(PUBLIC);
      // Each change is sent as an Update of the status (Notes carry the policy); the last supersedes those waiting.
      expect((await outbound(h.store)).map((row) => row.activity.type)).toEqual(["Create", "Update"]);
      expect(await sql(h.store, "SELECT edited_at FROM statuses WHERE id = ?", status.id)).toEqual([
        { edited_at: null },
      ]);
    });

    it("refuses any other value with 422 and keeps the policy", async () => {
      const h = await community(["alice"]);
      const status = await post(h, h.users.alice, { status: "mine", quote_approval_policy: "followers" });
      const response = await send(h, h.users.alice.token, method, `/api/v1/statuses/${status.id}/interaction_policy`, {
        quote_approval_policy: "everyone",
      });
      expect(await refusal(response)).toEqual({ status: 422, body: { error: "Record invalid" } });
      expect(await stored(h.store, status.id)).toBe(FOLLOWERS);
    });

    it("stores nobody for a private or direct status", async () => {
      const h = await community(["alice", "bob"]);
      for (const visibility of ["private", "direct"]) {
        const status = await post(h, h.users.alice, { status: "@bob hi", visibility });
        const response = await send(
          h,
          h.users.alice.token,
          method,
          `/api/v1/statuses/${status.id}/interaction_policy`,
          { quote_approval_policy: "public" },
        );
        expect(response.status).toBe(200);
        expect((await response.json<PolicyStatus>()).quote_approval).toEqual(
          approvalOf([], visibility === "direct" ? "denied" : "automatic"),
        );
        expect(await stored(h.store, status.id)).toBe(0);
      }
    });

    it("answers 403 for another's status the caller may see, before the value", async () => {
      const h = await community(["alice", "bob"]);
      const status = await post(h, h.users.bob, { status: "bob’s", quote_approval_policy: "public" });
      const remote = await remoteAccount(h.store, "rem");
      const theirs = await seedStatus(h.store, { accountId: remote, visibility: "public" });
      for (const [id, body] of [
        [status.id, { quote_approval_policy: "nobody" }],
        [status.id, { quote_approval_policy: "everyone" }],
        [theirs, { quote_approval_policy: "nobody" }],
      ] as const) {
        const response = await send(h, h.users.alice.token, method, `/api/v1/statuses/${id}/interaction_policy`, body);
        expect(await refusal(response)).toEqual({ status: 403, body: { error: "This action is not allowed" } });
      }
      expect(await stored(h.store, status.id)).toBe(PUBLIC);
    });

    it("answers 404 for a status the caller may not see, or none", async () => {
      const h = await community(["alice", "bob"]);
      const hidden = await post(h, h.users.bob, { status: "followers only", visibility: "private" });
      for (const id of [hidden.id, "999999999999999999"]) {
        const response = await send(h, h.users.alice.token, method, `/api/v1/statuses/${id}/interaction_policy`, {
          quote_approval_policy: "everyone",
        });
        expect(response.status).toBe(404);
      }
      // Once alice follows bob she sees it, and it is still not hers.
      await follow(h, h.users.alice, h.users.bob.id);
      const response = await send(h, h.users.alice.token, method, `/api/v1/statuses/${hidden.id}/interaction_policy`, {
        quote_approval_policy: "public",
      });
      expect(response.status).toBe(403);
    });

    it("needs write:statuses (403 otherwise)", async () => {
      const h = await community(["alice"]);
      const status = await post(h, h.users.alice, { status: "mine", quote_approval_policy: "public" });
      const path = `/api/v1/statuses/${status.id}/interaction_policy`;
      for (const scope of ["read", "read:statuses", "write:accounts", "write:favourites"]) {
        const token = await scopedToken(h, scope);
        expect((await send(h, token, method, path, { quote_approval_policy: "nobody" })).status).toBe(403);
      }
      expect(await stored(h.store, status.id)).toBe(PUBLIC);
      const token = await scopedToken(h, "write:statuses");
      expect((await send(h, token, method, path, { quote_approval_policy: "nobody" })).status).toBe(200);
      expect(await stored(h.store, status.id)).toBe(0);
    });
  });
});

describe("quote_approval", () => {
  // Every combination of the automatic and manual flags, as the arrays name them in Mastodon's order.
  it("names the flags of each half of every stored policy, in Mastodon’s order", async () => {
    const h = await community(["alice"]);
    const remote = await remoteAccount(h.store, "rem");
    const id = await seedStatus(h.store, { accountId: remote, visibility: "public" });
    const names = (bits: number) => FLAGS.filter((_, i) => (bits & (1 << i)) !== 0);
    for (let automatic = 0; automatic < 16; automatic++) {
      for (let manual = 0; manual < 16; manual++) {
        await sql(h.store, "UPDATE statuses SET quote_policy = ? WHERE id = ?", (automatic << 16) | manual, id);
        const { body } = await getJson<PolicyStatus>(h, `/api/v1/statuses/${id}`);
        expect(body.quote_approval, `${automatic} ${manual}`).toEqual({
          automatic: names(automatic),
          manual: names(manual),
          current_user: "denied",
        });
      }
    }
  });

  // current_user is R36 for the viewer (audience.ts quoteApprovalReads): denied whenever R36 refuses, automatic for
  // the viewer's own, and otherwise what the policy answers them. Every policy against every viewer relation, local
  // and remote statuses, a private and a direct one, and a boost (which answers for its original).
  it("answers R36 for every policy and viewer relation, a boost and a private post included", async () => {
    const h = await community(["alice", "bob", "carol", "dan", "erin", "frank", "gina"]);
    const { alice, bob, carol, dan, erin, frank, gina } = h.users;
    await follow(h, bob, alice.id);
    await follow(h, alice, dan.id);
    expect((await act(h, erin, `/api/v1/accounts/${alice.id}/block`)).status).toBe(200);
    expect((await act(h, alice, `/api/v1/accounts/${frank.id}/block`)).status).toBe(200);
    const remote = await remoteAccount(h.store, "rem", "far.example");
    expect((await act(h, gina, "/api/v1/domain_blocks", { domain: "far.example" })).status).toBe(200);
    // bob follows rem; rem follows dan.
    await sql(
      h.store,
      `INSERT INTO follows (account_id, target_account_id, state, created_at) VALUES (?1, ?2, 'accepted', ?4),
				(?2, ?3, 'accepted', ?4)`,
      bob.id,
      remote,
      dan.id,
      new Date(NOW).toISOString(),
    );
    type Case = { id: string; author: string; visibility: string; policy: number };
    const cases: Case[] = [];
    const seed = async (author: string, visibility: "public" | "unlisted" | "private" | "direct", policy: number) => {
      const id = await seedStatus(h.store, { accountId: author, visibility });
      await sql(h.store, "UPDATE statuses SET quote_policy = ? WHERE id = ?", policy, id);
      cases.push({ id, author, visibility, policy });
    };
    for (const author of [alice.id, remote]) {
      for (const visibility of ["public", "unlisted"] as const) {
        for (const policy of [PUBLIC, FOLLOWERS, 8 << 16, 2, 4, 8, 1 << 16, 1, 0]) {
          await seed(author, visibility, policy);
        }
      }
      await seed(author, "private", PUBLIC);
      await seed(author, "direct", PUBLIC);
    }
    const follows = (a: string, b: string) =>
      (a === bob.id && (b === alice.id || b === remote)) ||
      (a === alice.id && b === dan.id) ||
      (a === remote && b === dan.id);
    const half = (bits: number, viewer: string, author: string) =>
      (bits & 2) !== 0 ||
      ((bits & 4) !== 0 && follows(viewer, author)) ||
      ((bits & 8) !== 0 && follows(author, viewer));
    const expected = (viewer: string | null, c: Case): string => {
      if (viewer === null) {
        return "denied";
      }
      if (viewer === c.author) {
        return c.visibility === "direct" ? "denied" : "automatic";
      }
      const blocked =
        (c.author === alice.id && (viewer === erin.id || viewer === frank.id)) ||
        (c.author === remote && viewer === gina.id);
      if (blocked || c.visibility === "private" || c.visibility === "direct") {
        return "denied";
      }
      return half(c.policy >> 16, viewer, c.author)
        ? "automatic"
        : half(c.policy & 0xffff, viewer, c.author)
          ? "manual"
          : ((c.policy >> 16) | (c.policy & 0xffff)) & 1
            ? "unknown"
            : "denied";
    };
    const viewers: [string | null, string | undefined][] = [
      [null, undefined],
      ...[alice, bob, carol, dan, erin, frank, gina].map((user) => [user.id, user.token] as [string, string]),
    ];
    for (const [viewer, token] of viewers) {
      for (const c of cases) {
        const response = await h.request(`/api/v1/statuses/${c.id}`, token === undefined ? {} : bearer(token));
        // A status the viewer may not see is not shown at all.
        if (response.status === 404) {
          expect(expected(viewer, c), `${viewer} ${c.visibility}`).toBe("denied");
          continue;
        }
        const body = await response.json<PolicyStatus>();
        expect(body.quote_approval.current_user, `${viewer} ${c.author} ${c.visibility} ${c.policy}`).toBe(
          expected(viewer, c),
        );
      }
    }
    // A boost answers for its original, for each viewer: bob's boost of alice's public status open to followers.
    const original = cases.find((c) => c.author === alice.id && c.visibility === "public" && c.policy === FOLLOWERS)!;
    const boost = await (await act(h, bob, `/api/v1/statuses/${original.id}/reblog`)).json<PolicyStatus>();
    for (const [viewer, token] of [
      [bob.id, bob.token],
      [carol.id, carol.token],
    ] as const) {
      const { body } = await getJson<PolicyStatus & { reblog: PolicyStatus }>(h, `/api/v1/statuses/${boost.id}`, token);
      expect(body.quote_approval.current_user).toBe(expected(viewer, original));
      expect(body.reblog.quote_approval.current_user).toBe(expected(viewer, original));
    }
  });

  it("shows the original’s policy on a boost, and is served on the statuses a quote embeds", async () => {
    const h = await community(["alice", "bob"]);
    const { alice, bob } = h.users;
    const status = await post(h, alice, { status: "boost me", quote_approval_policy: "followers" });
    const boost = await act(h, bob, `/api/v1/statuses/${status.id}/reblog`);
    const boosted = await boost.json<PolicyStatus & { reblog: PolicyStatus }>();
    // bob does not follow alice: her followers policy denies him, on the boost as on its original.
    expect(boosted.quote_approval).toEqual(approvalOf(["followers"], "denied"));
    expect(boosted.reblog.quote_approval).toEqual(approvalOf(["followers"], "denied"));
    expect(await stored(h.store, boosted.id)).toBe(0);
    // A remote quote of alice's status, accepted: the embedded status carries its own quote_approval.
    const remote = await remoteAccount(h.store, "rem");
    const quoting = await seedStatus(h.store, { accountId: remote, visibility: "public" });
    await sql(
      h.store,
      `INSERT INTO quotes (status_id, quoted_uri, quoted_status_id, quoted_account_id, state, updated_at)
			SELECT ?1, uri, id, account_id, 'accepted', '2026-10-12T00:00:00.000Z' FROM statuses WHERE id = ?2`,
      quoting,
      status.id,
    );
    const { body } = await getJson<PolicyStatus & { quote: { quoted_status: PolicyStatus } }>(
      h,
      `/api/v1/statuses/${quoting}`,
      bob.token,
    );
    expect(body.quote_approval).toEqual(approvalOf([], "denied"));
    expect(body.quote.quoted_status.quote_approval).toEqual(approvalOf(["followers"], "denied"));
  });

  // Ice Cubes (Models/QuoteApproval.swift) decodes all three fields, non-optional, current_user from a closed enum, or
  // fails the whole status.
  it("has the shape Ice Cubes decodes", async () => {
    const h = await community(["alice", "bob"]);
    const { alice, bob } = h.users;
    const mine = await post(h, alice, { status: "mine" });
    const remote = await remoteAccount(h.store, "rem");
    const theirs = await seedStatus(h.store, { accountId: remote, visibility: "public" });
    await sql(h.store, "UPDATE statuses SET quote_policy = ? WHERE id = ?", (15 << 16) | 15, theirs);
    const old = await seedStatus(h.store, { accountId: remote, visibility: "unlisted" });
    for (const token of [undefined, alice.token, bob.token]) {
      for (const id of [mine.id, theirs, old]) {
        const { body } = await getJson<Record<string, unknown>>(h, `/api/v1/statuses/${id}`, token);
        const approval = body.quote_approval as Record<string, unknown>;
        expect(Object.keys(approval).sort()).toEqual(["automatic", "current_user", "manual"]);
        for (const half of [approval.automatic, approval.manual]) {
          expect(Array.isArray(half)).toBe(true);
          for (const flag of half as unknown[]) {
            expect(FLAGS).toContain(flag);
          }
        }
        expect(["automatic", "manual", "unknown", "denied"]).toContain(approval.current_user);
      }
    }
  });
});

describe("source[quote_policy] and posting:default:quote_policy", () => {
  it("round-trips through update_credentials, verify_credentials and preferences", async () => {
    const h = await community(["alice"]);
    const { token } = h.users.alice;
    const preference = async () =>
      (await getJson<Record<string, unknown>>(h, "/api/v1/preferences", token)).body["posting:default:quote_policy"];
    const source = async () =>
      (await getJson<{ source: { quote_policy: string } }>(h, "/api/v1/accounts/verify_credentials", token)).body.source
        .quote_policy;
    expect(await preference()).toBe("public");
    expect(await source()).toBe("public");
    for (const policy of ["followers", "nobody", "public"]) {
      const response = await send(h, token, "PATCH", "/api/v1/accounts/update_credentials", {
        source: { quote_policy: policy },
      });
      expect((await response.json<{ source: { quote_policy: string } }>()).source.quote_policy).toBe(policy);
      expect(await source()).toBe(policy);
      expect(await preference()).toBe(policy);
    }
    // Another change leaves it alone.
    await send(h, token, "PATCH", "/api/v1/accounts/update_credentials", { source: { privacy: "unlisted" } });
    await setDefault(h, h.users.alice, "nobody");
    await send(h, token, "PATCH", "/api/v1/accounts/update_credentials", { display_name: "Alice" });
    expect(await preference()).toBe("nobody");
  });

  it("refuses any other value with 422 and keeps the setting", async () => {
    const h = await community(["alice"]);
    await setDefault(h, h.users.alice, "followers");
    const response = await send(h, h.users.alice.token, "PATCH", "/api/v1/accounts/update_credentials", {
      source: { quote_policy: "everyone" },
    });
    expect(await refusal(response)).toEqual({
      status: 422,
      body: { error: "Validation failed: Quote policy is not included in the list" },
    });
    expect(await sql(h.store, "SELECT default_quote_policy FROM local_accounts")).toEqual([
      { default_quote_policy: "followers" },
    ]);
  });
});
