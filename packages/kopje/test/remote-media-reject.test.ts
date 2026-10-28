import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { MAX_BLOCK_LABELS } from "../src/domain/audience";
import {
  admitRemoteMedia,
  LANE0_CLAIMS,
  maintainRemoteMedia,
  syncAttachmentFiles,
  VALIDITY_WALK,
} from "../src/domain/remote-media";
import { sql } from "./api-helpers";
import { blockDomain, setRejectMedia } from "./domain-block-helpers";
import { plannedRun, scansOf, staleStatistics } from "./read-helpers";
import {
  backfillDone,
  claimWith,
  deferred,
  fence,
  maintain,
  mediaWorld,
  type MediaWorld,
  noteEmoji,
  PNG,
  record,
  snapshot,
  storedOutcome,
} from "./remote-media-helpers";

// R38 reject_media in the cache of remote media (domain/remote-media.ts slotEligibleSql, audience.ts
// mediaRejectedSql; Mastodon's DomainBlock.reject_media?): a domain whose rule has reject_media gets nothing enqueued,
// claimed or recorded, and the validity walk retires what is cached of it. Each refusal has a control on another
// domain that the same call serves.

const CAP = 4 * 1024 * 1024 * 1024;
let tokens = 0;
const token = () => `J${String(++tokens).padStart(42, "0")}`;

const claim = (w: MediaWorld) => claimWith(w, token, LANE0_CLAIMS, CAP);

const stored = storedOutcome(10);

const rejectMedia = (w: MediaWorld, domain: string) => blockDomain(w.t.store, domain, "noop", { rejectMedia: true });

// Every slot claimed and stored, so the walk has files to retire.
async function storeAll(w: MediaWorld): Promise<void> {
  for (const c of (await claim(w)).claims) {
    expect(await record(w, c, stored), c.url).toEqual({ held: true });
  }
}

// The slots by owner (an account or attachment id) or, for an emoji, its domain, with whether each holds a file.
async function slotsOf(w: MediaWorld): Promise<string[]> {
  const rows = await sql<{ kind: string; who: string; url: string; token: string | null }>(
    w.t.store,
    "SELECT kind, coalesce(owner_id, domain) AS who, url, token FROM remote_media ORDER BY kind, who, url",
  );
  return rows.map((r) => `${r.kind} ${r.who} ${r.url}${r.token === null ? "" : " stored"}`);
}

describe("reject_media (R38) in the remote media cache", () => {
  it("enqueues nothing of an account, an attachment author or an emoji domain whose rule rejects media", async () => {
    const w = await mediaWorld();
    await backfillDone(w);
    await rejectMedia(w, "rejected.example");
    const rejected = await w.remote({}, "rejected.example");
    const kept = await w.remote({});
    const shot = snapshot("https://files.example/e/1.png");
    await noteEmoji(w, shot, "rejected.example");
    await noteEmoji(w, shot, "files.example");
    await w.attach(rejected.id, "https://files.example/m/r.png");
    const keptMedia = (await w.attach(kept.id, "https://files.example/m/k.png")).media;
    expect(await slotsOf(w)).toEqual([
      `attachment ${keptMedia} https://files.example/m/k.png`,
      `avatar ${kept.id} ${kept.avatar}`,
      "emoji files.example https://files.example/e/1.png",
    ]);
    await w.exact();
  });

  it("removes the slots of an account or attachment at its next sync once its domain rejects media", async () => {
    const w = await mediaWorld();
    await backfillDone(w);
    const account = await w.remote({}, "later.example");
    const { media } = await w.attach(account.id, "https://files.example/m/l.png");
    await storeAll(w);
    expect(await slotsOf(w)).toHaveLength(2);
    await rejectMedia(w, "later.example");
    await w.change(account.id, { avatar: account.avatar, header: null });
    // The status writer's sync of the same row (remote-statuses.ts writeMedia).
    await w.db((d) => syncAttachmentFiles(d, media, w.clock.now));
    expect(await slotsOf(w)).toEqual([]);
    expect((await w.objects()).map((o) => o.state)).toEqual(["doomed", "doomed"]);
    await w.exact();
  });

  it("backfills nothing of a domain whose rule rejects media, in every phase", async () => {
    const w = await mediaWorld();
    const rejected = await w.remote({}, "rejected.example");
    const kept = await w.remote({});
    const shot = snapshot("https://files.example/e/b.png");
    await sql(w.t.store, "UPDATE accounts SET emojis = ?1 WHERE id IN (?2, ?3)", shot, rejected.id, kept.id);
    const rejectedPost = await w.attach(rejected.id, "https://files.example/m/r.png");
    const keptPost = await w.attach(kept.id, "https://files.example/m/k.png");
    await sql(
      w.t.store,
      "UPDATE statuses SET emojis = ?1 WHERE id IN (?2, ?3)",
      snapshot("https://files.example/e/s.png"),
      rejectedPost.status,
      keptPost.status,
    );
    // What the writers enqueued is gone, so only the backfill enqueues.
    await sql(w.t.store, "DELETE FROM remote_media");
    await sql(w.t.store, "UPDATE remote_media_usage SET pending = 0");
    await rejectMedia(w, "rejected.example");
    // Every slot seen after a round: the next round's validity walk would retire one enqueued in error.
    const seen = new Set<string>();
    for (let round = 0; round < 4; round++) {
      await maintain(w);
      for (const slot of await slotsOf(w)) {
        seen.add(slot);
      }
    }
    expect([...seen].sort()).toEqual([
      `attachment ${keptPost.media} https://files.example/m/k.png`,
      `avatar ${kept.id} ${kept.avatar}`,
      "emoji files.example https://files.example/e/b.png",
      "emoji files.example https://files.example/e/s.png",
    ]);
    await w.exact();
  });

  it("claims nothing of a domain once its rule rejects media, and admits or records no claim made before it", async () => {
    const w = await mediaWorld();
    await backfillDone(w);
    const early = await w.remote({}, "early.example");
    const during = await w.remote({}, "during.example");
    const kept = await w.remote({});
    await noteEmoji(w, snapshot("https://files.example/e/d.png"), "during.example");
    await rejectMedia(w, "early.example");
    const claimed = await claim(w);
    // The early domain's slot is dropped at the claim; the others are claimed.
    expect(claimed.dropped).toBe(1);
    expect(claimed.claims.map((c) => c.url).sort()).toEqual(
      [during.avatar, kept.avatar, "https://files.example/e/d.png"].sort(),
    );
    expect((await w.slots()).some((s) => s.owner_id === early.id)).toBe(false);
    // A block committed after the claim: the fence refuses the admission and the record of its domain's slots (the
    // profile image by its account, the emoji by its slot's domain), and the object is doomed.
    await rejectMedia(w, "during.example");
    for (const c of claimed.claims) {
      const ours = c.url !== kept.avatar;
      expect(await w.op(admitRemoteMedia, { ...fence(c), hosts: ["files.example"] }), c.url).toEqual({
        held: !ours,
      });
      expect(await record(w, c, stored), c.url).toEqual({ held: !ours });
    }
    expect(await slotsOf(w)).toEqual([
      `avatar ${during.id} ${during.avatar}`,
      `avatar ${kept.id} ${kept.avatar} stored`,
      "emoji during.example https://files.example/e/d.png",
    ]);
    expect((await w.objects()).map((o) => o.state).sort()).toEqual(["doomed", "doomed", "stored"]);
    await w.exact();
  });

  it("stores nothing of a domain whose rule came to reject media while the round held its fetch", async () => {
    const w = await mediaWorld();
    await backfillDone(w);
    const during = await w.remote({}, "during.example");
    const kept = await w.remote({});
    w.serve(kept.avatar!, PNG);
    // The round holds the fetch of the during domain's avatar until the block has committed.
    const reached = deferred();
    const release = deferred();
    w.serve(during.avatar!, async () => {
      reached.resolve();
      await release.promise;
      return new Response(PNG);
    });
    const running = w.round();
    await reached.promise;
    await rejectMedia(w, "during.example");
    release.resolve();
    expect(await running).toMatchObject({ claimed: 2, stored: 1 });
    expect(w.requests).toContain(`GET ${during.avatar}`);
    expect(await slotsOf(w)).toEqual([
      `avatar ${during.id} ${during.avatar}`,
      `avatar ${kept.id} ${kept.avatar} stored`,
    ]);
    const objects = await w.objects();
    const doomed = objects.filter((o) => o.state === "doomed");
    expect(doomed).toHaveLength(1);
    expect(objects.filter((o) => o.state === "stored")).toHaveLength(1);
    // No key of the refused claim was written; its reservation stays charged as doomed until its deletion.
    expect(await env.MEDIA.list({ prefix: `remote/${doomed[0]!.token}/` })).toMatchObject({ objects: [] });
    expect((await w.usage()).doomed).toBe(doomed[0]!.charge);
    await w.exact();
  });

  it("judges an account by its stored domain alone, not by its actor host", async () => {
    const w = await mediaWorld();
    await backfillDone(w);
    // Mastodon's DomainBlock.reject_media?(account.domain): reject_media by the stored domain only (a rule naming only
    // the actor host leaves the media cached), while suspend coverage reads the actor host too.
    await blockDomain(w.t.store, "allowed.example.org", "noop");
    await rejectMedia(w, "example.org");
    await rejectMedia(w, "media.example");
    await rejectMedia(w, "rejected.example");
    const exempt = await w.remote({}, "allowed.example.org");
    const byHost = await w.remote({}, "plain.example");
    const byDomain = await w.remote({}, "rejected.example");
    for (const [account, host] of [
      [exempt, "social.example.org"],
      [byHost, "media.example"],
      [byDomain, "other.example"],
    ] as const) {
      await sql(w.t.store, "UPDATE accounts SET uri = ?2 WHERE id = ?1", account.id, `https://${host}/users/x`);
      await w.change(account.id, { avatar: account.avatar, header: null });
      await w.attach(account.id, `https://files.example/m/${account.id}.png`);
    }
    await noteEmoji(w, snapshot("https://files.example/e/x.png"), "allowed.example.org");
    await storeAll(w);
    expect((await maintain(w)).counts.retired).toBe(0);
    const owners = (await sql<{ account_id: string | null }>(w.t.store, "SELECT account_id FROM remote_media")).map(
      (slot) => slot.account_id,
    );
    expect(owners.filter((id) => id === exempt.id)).toHaveLength(2);
    expect(owners.filter((id) => id === byHost.id)).toHaveLength(2);
    expect(owners).not.toContain(byDomain.id);
    expect(await slotsOf(w)).toContain("emoji allowed.example.org https://files.example/e/x.png stored");
    // The account's stored domain changes and the walk follows it.
    await sql(w.t.store, "UPDATE accounts SET domain = 'rejected.example' WHERE id = ?1", byHost.id);
    expect((await maintain(w)).counts.retired).toBe(2);
    // Suspend coverage still reads the actor host: a suspend of it makes the account unavailable.
    await blockDomain(w.t.store, "social.example.org", "suspend");
    expect((await maintain(w)).counts.retired).toBe(2);
    expect(await sql(w.t.store, "SELECT count(*) AS n FROM remote_media WHERE account_id = ?1", exempt.id)).toEqual([
      { n: 0 },
    ]);
    await w.exact();
  });

  it("retires in the validity walk every cached file of a domain whose rule came to reject media", async () => {
    const w = await mediaWorld();
    await backfillDone(w);
    const account = await w.remote({ header: "https://files.example/h/1.png" }, "walked.example");
    const kept = await w.remote({});
    await w.attach(account.id, "https://files.example/m/w.png", { preview: "https://files.example/m/w-icon.png" });
    await noteEmoji(w, snapshot("https://files.example/e/w.png"), "walked.example");
    await storeAll(w);
    const block = await blockDomain(w.t.store, "walked.example", "noop");
    expect((await maintain(w)).counts.retired).toBe(0);
    await setRejectMedia(w.t.store, block.id, true);
    expect((await maintain(w)).counts.retired).toBe(5);
    expect(await slotsOf(w)).toEqual([`avatar ${kept.id} ${kept.avatar} stored`]);
    expect((await w.objects()).filter((o) => o.state === "doomed")).toHaveLength(5);
    await w.exact();
  });

  it("decides by the nearest block: a child without reject_media is exempt, a child with it rejects under a noop parent", async () => {
    const w = await mediaWorld();
    await backfillDone(w);
    await w.remote({}, "parent.example");
    const exempt = await w.remote({}, "a.parent.example");
    const deeper = await w.remote({}, "x.a.parent.example");
    const other = await w.remote({}, "other.example");
    await w.remote({}, "b.other.example");
    await storeAll(w);
    // The child first: a create under a stricter ruling block is refused (DomainBlock#stricter_than?), but a parent
    // block may come later, or gain reject_media by an update.
    await blockDomain(w.t.store, "a.parent.example", "noop");
    await rejectMedia(w, "parent.example");
    await blockDomain(w.t.store, "other.example", "noop");
    await rejectMedia(w, "b.other.example");
    expect((await maintain(w)).counts.retired).toBe(2);
    const owners = (await w.slots()).map((s) => s.owner_id).sort();
    expect(owners).toEqual([exempt.id, deeper.id, other.id].sort());
    await w.exact();
  });

  it("rejects an emoji by its slot’s domain, keeping the same URL cached for another domain", async () => {
    const w = await mediaWorld();
    await backfillDone(w);
    const shared = snapshot("https://files.example/e/shared.png");
    await noteEmoji(w, shared, "one.example");
    await noteEmoji(w, shared, "two.example");
    await storeAll(w);
    await rejectMedia(w, "one.example");
    expect((await maintain(w)).counts.retired).toBe(1);
    await noteEmoji(w, shared, "one.example");
    await noteEmoji(w, shared, "two.example");
    expect(await slotsOf(w)).toEqual(["emoji two.example https://files.example/e/shared.png stored"]);
    await w.exact();
  });

  it(
    "seeks the reject_media rule by domain for each slot the validity walk reads, however many blocks, after ANALYZE and growth",
    { timeout: 300_000 },
    async () => {
      const w = await mediaWorld();
      await backfillDone(w);
      // The deepest walk: a host past MAX_BLOCK_LABELS labels whose only block is its 2-label suffix, a noop without
      // reject_media, so every suffix of 2 to MAX_BLOCK_LABELS labels is sought and the slot stays eligible.
      const deep = [...Array.from({ length: MAX_BLOCK_LABELS + 2 }, (_, i) => `l${i}`), "far", "example"].join(".");
      const accounts = async (n: number) => {
        for (let i = 0; i < n; i++) {
          await w.remote({}, deep);
        }
      };
      await accounts(10);
      await blockDomain(w.t.store, "far.example", "noop");
      const capture = async () => {
        const { result, plans } = await plannedRun(
          w.t,
          /FROM remote_media WHERE id > \?1 ORDER BY id/,
          maintainRemoteMedia,
          { now: w.clock.now, restoredAt: null, cap: CAP },
          true,
        );
        expect(result.counts.retired).toBe(0);
        expect(plans).toHaveLength(1);
        const [cursor] = await sql<{ value: string }>(
          w.t.store,
          "SELECT value FROM kopje_state WHERE name = 'remote_media_walk'",
        );
        return { ...plans[0]!, ids: (await w.slots()).map((slot) => slot.id), cursor: cursor?.value };
      };
      const { before, after } = await staleStatistics(w.t, {
        capture,
        grow: async () => {
          await accounts(VALIDITY_WALK + 40);
          // Blocks of other domains, half with reject_media, none on any suffix of the walked host.
          await sql(
            w.t.store,
            `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3000)
						INSERT INTO instance_domain_blocks (domain, severity, reject_media, created_at, updated_at)
						SELECT 'g' || i || '.example', 'noop', i % 2, 'x', 'x' FROM n`,
          );
        },
      });
      // Before growth the walk reads all 10 slots and wraps; after it, past its cap, it reads VALIDITY_WALK of them, each
      // at the deepest walk, and continues after the last it read.
      expect([before.ids.length, after.ids.length]).toEqual([10, VALIDITY_WALK + 50]);
      expect(before.cursor).toBe("0");
      expect(after.cursor).toBe(String(after.ids[VALIDITY_WALK - 1]));
      for (const { plan } of [before, after]) {
        // The rule walks seek by domain; the only scan of the blocks is availability's guard, an EXISTS over the
        // partial index of the suspend blocks (audience.ts SUSPEND_BLOCKS_SQL).
        expect(scansOf(plan, ["pn", "pr"]), plan.join("\n")).toEqual([]);
        expect(
          scansOf(plan, ["instance_domain_blocks"]).every((scan) => scan.endsWith("instance_domain_blocks_suspend")),
          plan.join("\n"),
        ).toBe(true);
      }
      // Rows read grow with the slots walked, not with the blocks.
      expect(after.rows / VALIDITY_WALK).toBeLessThanOrEqual(before.rows / 10 + 1);
      // The next round walks the remaining 50 and wraps.
      expect((await maintain(w)).counts.retired).toBe(0);
      expect(await sql(w.t.store, "SELECT value FROM kopje_state WHERE name = 'remote_media_walk'")).toEqual([
        { value: "0" },
      ]);
      await w.exact();
    },
  );
});
