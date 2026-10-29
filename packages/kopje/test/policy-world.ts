import fc from "fast-check";
import { inject } from "vitest";

import type { Visibility } from "../src/domain/audience";
import type { RepliesPolicy } from "../src/domain/lists";

// A generated world for the policy oracle (test/policy-oracle.test.ts) and the bounds harness
// (test/policy-bounds.test.ts): local accounts (one of them may be suspended, some may hide their network), remote
// accounts on two domains (one of them may be being deleted, its statuses and edges still stored, and some may hide
// their network, as Kopje learned of them), statuses of every visibility with mentions (some silent), boosts and
// replies (some to a status never stored, and some continuing such a reply, as a purge leaves a reply to the account it
// removes), and the edges the rules read: follows (pending and accepted, local accounts following local ones more
// often), blocks both ways, mutes with and without an expiry and with and without notifications, and domain blocks in
// their stored form; and local accounts' lists, exclusive or not, with each replies_policy, whose members are their
// owner and accounts it follows, accepted or pending (whatever else the owner blocks, mutes or domain-blocks); and the
// local accounts that follow the hashtag tagged statuses carry; and quotes (R35) in every stored state, legacy or not,
// self-quotes among them, of statuses of every visibility, and quotes whose quoted status is gone; some statuses
// withdrawn (their removal under way); and each original's
// quote policy (R36), any combination of Mastodon's flags; and local accounts' dismissed suggestions (R39). Accounts,
// statuses and lists are referred to by index; writeWorld gives them fixed ids.

declare module "vitest" {
  interface ProvidedContext {
    // FC_SEED from the environment (vitest.config.ts), to replay a run fast-check reported.
    fcSeed: string;
  }
}

// fast-check's parameters for a property: its case count, and the seed FC_SEED gives, else `seed` if given (a property
// whose coverage must not depend on chance), else a random one.
export function runs(numRuns: number, seed?: number): fc.Parameters<unknown> {
  const given = inject("fcSeed");
  if (given !== "") {
    return { numRuns, seed: Number(given) };
  }
  return seed === undefined ? { numRuns } : { numRuns, seed };
}

const LOCALS = 4;
const INSTANCE_DOMAIN = "kopje.test";
export const REMOTE_DOMAINS = ["one.example", "two.example"] as const;
// What a domain block may name: each remote domain, the hosts some actor ids live on, the instance's own domain and a
// domain nobody lives on.
export const BLOCKABLE_DOMAINS = [
  ...REMOTE_DOMAINS,
  "social.one.example",
  "social.two.example",
  INSTANCE_DOMAIN,
  "three.example",
] as const;

const VISIBILITIES: readonly Visibility[] = ["public", "unlisted", "private", "direct", "limited"];
const REPLIES_POLICIES: readonly RepliesPolicy[] = ["followed", "list", "none"];
// The times a world may be judged at, an hour apart, so a mute's expiry falls before, at or after them.
const TIMES = ["2026-10-12T00:00:00.000Z", "2026-10-12T01:00:00.000Z", "2026-10-12T02:00:00.000Z"] as const;
const HOUR_MS = 3_600_000;

type WorldAccount = {
  name: string;
  local: boolean;
  // A local account's suspension, or the instance's suspension of a remote account (R38: accounts.suspended_at).
  suspended: boolean;
  // Remote accounts only: a domain mark (R38: suspension_source 'domain'), current or left from a lifted block. The
  // model never reads it: availability reads the blocks live (instanceBlocks), and only the admin's lists read marks.
  domainMarked?: boolean;
  // Remote accounts only: its deletion has started (accounts.deleted_at), and its purge has removed nothing yet.
  deleting: boolean;
  // hide_collections: a local account's setting, or what Kopje learned of a remote account's.
  hidesCollections: boolean;
  // Remote accounts only: the stored domain. The actor id's host may differ from it (see HOSTS).
  domain: string | null;
  uri: string;
};

export type WorldStatus = {
  name: string;
  author: number;
  visibility: Visibility;
  mentions: { account: number; silent: boolean }[];
  reblogOf: number | null;
  replyTo: number | null;
  // A reply to a status the server never stored (replyTo is null): its parent and partner are unknown.
  replyToUnknown: boolean;
  tagged: boolean;
  // statuses.quote_policy: Mastodon's flags, automatic in the high 16 bits (0 for a boost, as Kopje stores them).
  // None is 0, as for the statuses a write property reads back.
  quotePolicy?: number;
  // statuses.withdrawn: its retraction is recorded and its removal under way (a local status's DELETE, a remote
  // status's Delete, a local boost's Undo). Absent is false, as for the statuses a write property reads back.
  withdrawn?: boolean;
};

// How an actor id's host relates to the account's stored domain: the same, a subdomain, with a port, with a trailing
// dot (alone or with a subdomain and a port), or the other remote domain (a domain confirmed elsewhere).
const HOSTS = ["same", "subdomain", "port", "dotted", "subdomain-dotted-port", "elsewhere"] as const;

function actorHost(form: (typeof HOSTS)[number], domain: string): string {
  switch (form) {
    case "same":
      return domain;
    case "subdomain":
      return `social.${domain}`;
    case "port":
      return `${domain}:8443`;
    case "dotted":
      return `${domain}.`;
    case "subdomain-dotted-port":
      return `social.${domain}.:8443`;
    case "elsewhere":
      return REMOTE_DOMAINS.find((other) => other !== domain) ?? domain;
  }
}

// The stored states of a quote (migration 0033_quotes).
export const QUOTE_STATES = ["pending", "accepted", "rejected", "revoked", "deleted"] as const;

// A quote by the status `status` of the status `quoted` (an original, never itself; null: the quoted status is gone,
// as a detach leaves it, never accepted). legacy: the Note had no `quote` property.
export type WorldQuote = {
  status: number;
  quoted: number | null;
  state: (typeof QUOTE_STATES)[number];
  legacy: boolean;
};

// A list of a local account. Its members are the owner or accounts the owner follows (in either state): a Store holds
// no other (migration 0007_list_members, the converter), so the world has none.
export type WorldList = {
  owner: number;
  repliesPolicy: RepliesPolicy;
  exclusive: boolean;
  members: number[];
};

export type World = {
  accounts: WorldAccount[];
  statuses: WorldStatus[];
  follows: { from: number; to: number; accepted: boolean; showReblogs: boolean; notify: boolean }[];
  blocks: { from: number; to: number }[];
  mutes: { from: number; to: number; expiresAt: string | null; hideNotifications: boolean }[];
  domainBlocks: { owner: number; domain: string }[];
  // The instance's domain blocks (R38), one per domain, as stored.
  instanceBlocks: { domain: string; severity: "suspend" | "noop" }[];
  lists: WorldList[];
  // Pins of accounts' own originals that are not direct or limited, as the API makes them for a local account and
  // Kopje learns them of a remote one.
  pins: { account: number; status: number }[];
  // Local accounts' conversation mutes, each of a thread (statuses.thread) of the world's statuses.
  conversationMutes: { account: number; thread: string }[];
  // Local accounts that follow the hashtag the world's tagged statuses carry.
  tagFollowers: number[];
  // Quotes, at most one by each status (an original).
  quotes: WorldQuote[];
  // Local accounts' dismissed follow suggestions (R39), each of an account.
  dismissals: { owner: number; target: number }[];
  now: string;
};

const ACCOUNT_BASE = 100000000000000000n;
const STATUS_BASE = 200000000000000000n;
const LIST_BASE = 600000000000000000n;

export function accountId(index: number): string {
  return String(ACCOUNT_BASE + BigInt(index));
}

export function statusId(index: number): string {
  return String(STATUS_BASE + BigInt(index));
}

export function listId(index: number): string {
  return String(LIST_BASE + BigInt(index));
}

// The publication time writeWorld gives a status (ms): a minute apart, in index order, up to the first of TIMES.
export function statusPublished(world: World, index: number): number {
  return Date.parse(TIMES[0]) - (world.statuses.length - index) * 60_000;
}

// The uri writeWorld gives a status, and the uri of the status never stored that a reply to one names.
export function statusUri(index: number): string {
  return `https://${INSTANCE_DOMAIN}/ap/o/${index}`;
}

export function unknownParentUri(index: number): string {
  return `https://elsewhere.example/objects/${index}`;
}

// The thread of a status (statuses.thread, which a reply takes from its parent when it is stored): the uri of the
// status its reply chain starts at, or, when that one replies to a status never stored, the uri it names.
export function threadOf(statuses: readonly WorldStatus[], s: number): string {
  let at = s;
  for (let parent = statuses[at]?.replyTo ?? null; parent !== null; parent = statuses[at]?.replyTo ?? null) {
    at = parent;
  }
  return statuses[at]?.replyToUnknown === true ? unknownParentUri(at) : statusUri(at);
}

// Keeps the first of each key.
function unique<T>(items: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    return seen.has(k) ? false : (seen.add(k), true);
  });
}

const remoteArb = fc.record({
  domain: fc.constantFrom(...REMOTE_DOMAINS),
  host: fc.constantFrom(...HOSTS),
});

const statusArb = fc.record({
  author: fc.nat(),
  visibility: fc.constantFrom(...VISIBILITIES),
  mentions: fc.array(fc.record({ account: fc.nat(), silent: fc.boolean() }), { maxLength: 3 }),
  // thread: a reply to one of the author's own statuses, preferably one of their replies (continuing a thread).
  kind: fc.constantFrom("original", "reply", "thread", "boost"),
  target: fc.nat(),
  tagged: fc.boolean(),
});

const edgeArb = fc.record({ from: fc.nat(), to: fc.nat() });

export const worldArb: fc.Arbitrary<World> = fc
  .record({
    remotes: fc.array(remoteArb, { minLength: 2, maxLength: 3 }),
    suspended: fc.option(fc.integer({ min: 0, max: LOCALS - 1 }), { freq: 4 }),
    hidden: fc.array(fc.constantFrom(false, false, true), { minLength: LOCALS, maxLength: LOCALS }),
    statuses: fc.array(statusArb, { maxLength: 22, size: "max" }),
    follows: fc.array(
      fc.record({
        from: fc.nat(),
        to: fc.nat(),
        accepted: fc.boolean(),
        showReblogs: fc.boolean(),
        notify: fc.boolean(),
      }),
      { maxLength: 20, size: "max" },
    ),
    blocks: fc.array(edgeArb, { maxLength: 8, size: "max" }),
    mutes: fc.array(
      fc.record({
        from: fc.nat(),
        to: fc.nat(),
        expiry: fc.constantFrom(null, -HOUR_MS, 0, HOUR_MS),
        hideNotifications: fc.boolean(),
      }),
      { maxLength: 8, size: "max" },
    ),
    domainBlocks: fc.array(fc.record({ owner: fc.nat(), domain: fc.constantFrom(...BLOCKABLE_DOMAINS) }), {
      maxLength: 4,
      size: "max",
    }),
    now: fc.constantFrom(...TIMES),
    // Last, so the other fields of a seed's worlds stay as they were before it was added.
    deleting: fc.option(fc.nat(), { freq: 3 }),
    // Statuses (not boosts) made replies to a status never stored, once all statuses are drawn.
    replyToUnknown: fc.array(fc.nat(), { maxLength: 3 }),
    // Lists, each member drawn from its owner and the accounts the owner follows.
    lists: fc.array(
      fc.record({
        owner: fc.nat(),
        repliesPolicy: fc.constantFrom(...REPLIES_POLICIES),
        exclusive: fc.boolean(),
        members: fc.array(fc.nat(), { maxLength: 5 }),
      }),
      { maxLength: 4 },
    ),
    // Last, as above: pins (each a choice among the author's pinnable statuses) and conversation mutes.
    pins: fc.array(fc.record({ account: fc.nat(), status: fc.nat() }), { maxLength: 4 }),
    conversationMutes: fc.array(fc.record({ account: fc.nat(), status: fc.nat() }), { maxLength: 4 }),
    // Last, as above: instance domain blocks (R38), a parent and its child included, so precedence is drawn.
    instanceBlocks: fc.array(
      fc.record({ domain: fc.constantFrom(...BLOCKABLE_DOMAINS), severity: fc.constantFrom("suspend", "noop") }),
      { maxLength: 2 },
    ),
    // Last, as above: accepted follows by local accounts, of local accounts more often than not, so the accounts the
    // viewer's follows follow (R39) are often there; and dismissed suggestions.
    localFollows: fc.array(fc.record({ from: fc.nat(), to: fc.nat(), local: fc.constantFrom(true, true, false) }), {
      maxLength: 10,
    }),
    dismissals: fc.array(fc.record({ owner: fc.nat(), target: fc.nat() }), { maxLength: 3 }),
  })
  .map((raw): World => {
    const accounts: WorldAccount[] = [];
    for (let i = 0; i < LOCALS; i++) {
      accounts.push({
        name: `L${i}`,
        local: true,
        suspended: raw.suspended === i,
        deleting: false,
        hidesCollections: raw.hidden[i] ?? false,
        domain: null,
        uri: `https://${INSTANCE_DOMAIN}/ap/users/l${i}`,
      });
    }
    raw.remotes.forEach((remote, i) => {
      accounts.push({
        name: `R${i}`,
        local: false,
        // The instance's suspension (R38), drawn from bits already drawn, as hidesCollections below, so the worlds a
        // seed gave before stay as they were but for it: about one remote account in four.
        suspended: raw.follows[LOCALS + i + 3]?.accepted === true && raw.follows[LOCALS + i + 3]?.notify === true,
        deleting: raw.deleting !== null && raw.deleting % raw.remotes.length === i,
        // Drawn from bits already drawn, as tagFollowers below: about one remote account in four.
        hidesCollections: raw.follows[LOCALS + i]?.showReblogs === true && raw.follows[LOCALS + i]?.notify === true,
        // Drawn from bits already drawn, as above: about one remote account in four.
        domainMarked:
          raw.follows[LOCALS + i + 6]?.accepted === true && raw.follows[LOCALS + i + 6]?.showReblogs === true,
        domain: remote.domain,
        uri: `https://${actorHost(remote.host, remote.domain)}/users/r${i}`,
      });
    });
    const n = accounts.length;
    const statuses: WorldStatus[] = [];
    const boosted = new Set<string>();
    raw.statuses.forEach((raw, i) => {
      const author = raw.author % n;
      const originals = statuses.flatMap((status, index) => (status.reblogOf === null ? [index] : []));
      const target = originals.length === 0 ? null : (originals[raw.target % originals.length] ?? null);
      const own = originals.filter((index) => statuses[index]?.author === author);
      const ownReplies = own.filter((index) => statuses[index]?.replyTo !== null);
      const thread = ownReplies.length > 0 ? ownReplies : own;
      const boost = raw.kind === "boost" && target !== null && !boosted.has(`${author}:${target}`);
      if (boost) {
        boosted.add(`${author}:${target}`);
      }
      statuses.push({
        name: `S${i}`,
        author,
        visibility: raw.visibility,
        mentions: unique(
          raw.mentions.map((m) => ({ account: m.account % n, silent: m.silent })),
          (m) => String(m.account),
        ),
        reblogOf: boost ? target : null,
        replyToUnknown: false,
        // Drawn from bits already drawn (a new field would change the worlds the fixed seeds of the other
        // properties give): four automatic and four manual flags from the author's draw above what picks the author.
        quotePolicy: boost ? 0 : ((Math.floor(raw.author / 128) % 16) << 16) | (Math.floor(raw.author / 2048) % 16),
        replyTo:
          raw.kind === "reply"
            ? target
            : raw.kind === "thread"
              ? (thread[raw.target % Math.max(thread.length, 1)] ?? target)
              : null,
        tagged: !boost && raw.tagged,
        // Drawn from bits already drawn, as quotePolicy: about one status in nine.
        withdrawn: (raw.author + raw.target) % 9 === 4,
      });
    });
    for (const n of raw.replyToUnknown) {
      const status = statuses[n % Math.max(statuses.length, 1)];
      if (status !== undefined && status.reblogOf === null) {
        status.replyTo = null;
        status.replyToUnknown = true;
      }
    }
    const pair = (e: { from: number; to: number }) => `${e.from}:${e.to}`;
    const follows = unique(
      [
        ...raw.follows.map((f) => ({ ...f, from: f.from % n, to: f.to % n })),
        ...raw.localFollows.map((f) => ({
          from: f.from % LOCALS,
          to: f.to % (f.local ? LOCALS : n),
          accepted: true,
          showReblogs: true,
          notify: false,
        })),
      ].filter((f) => f.from !== f.to),
      pair,
    );
    return {
      accounts,
      statuses,
      follows,
      blocks: unique(
        raw.blocks.map((b) => ({ from: b.from % n, to: b.to % n })).filter((b) => b.from !== b.to),
        pair,
      ),
      mutes: unique(
        raw.mutes
          .map((m) => ({
            from: m.from % LOCALS,
            to: m.to % n,
            expiresAt: m.expiry === null ? null : new Date(Date.parse(raw.now) + m.expiry).toISOString(),
            hideNotifications: m.hideNotifications,
          }))
          .filter((m) => m.from !== m.to),
        pair,
      ),
      domainBlocks: unique(
        raw.domainBlocks.map((d) => ({ owner: d.owner % LOCALS, domain: d.domain })),
        (d) => `${d.owner}:${d.domain}`,
      ),
      instanceBlocks: unique(raw.instanceBlocks, (b) => b.domain),
      lists: raw.lists.map((list) => {
        const owner = list.owner % LOCALS;
        const candidates = [owner, ...follows.flatMap((f) => (f.from === owner ? [f.to] : []))];
        const members = list.members.map((m) => candidates[m % candidates.length] ?? owner);
        return { ...list, owner, members: [...new Set(members)] };
      }),
      pins: unique(
        [
          ...raw.pins.map((p) => ({ account: p.account % LOCALS, status: p.status })),
          // Remote accounts' pins, drawn from the same bits (a new field would change the worlds the fixed seeds of
          // the other properties give): each draw with an even status also pins one of a remote account's.
          ...raw.pins.flatMap((p) =>
            p.status % 2 === 0
              ? [{ account: LOCALS + (p.account % raw.remotes.length), status: Math.floor(p.status / 2) }]
              : [],
          ),
        ].flatMap((p) => {
          const account = p.account;
          const pinnable = statuses.flatMap((status, s) =>
            status.author === account &&
            status.reblogOf === null &&
            status.visibility !== "direct" &&
            status.visibility !== "limited"
              ? [s]
              : [],
          );
          const status = pinnable[p.status % Math.max(pinnable.length, 1)];
          return status === undefined ? [] : [{ account, status }];
        }),
        (p) => `${p.account}:${p.status}`,
      ),
      conversationMutes:
        statuses.length === 0
          ? []
          : unique(
              raw.conversationMutes.map((m) => ({
                account: m.account % LOCALS,
                thread: threadOf(statuses, m.status % statuses.length),
              })),
              (m) => `${m.account}:${m.thread}`,
            ),
      // Local accounts following the world's hashtag, drawn from bits already drawn (a new field would change the
      // worlds the fixed seeds of the other properties give): about one local account in four.
      tagFollowers: Array.from({ length: LOCALS }, (_, x) => x).filter(
        (x) => raw.follows[x]?.showReblogs === true && raw.follows[x]?.notify,
      ),
      // Quotes, drawn from bits already drawn (a new field would change the worlds the fixed seeds of the other
      // properties give): about one original in three quotes another original (with one bit, one of its author's own
      // when there is one) or a status that is gone, in each stored state, legacy or not.
      quotes: raw.statuses.flatMap((r, s): WorldQuote[] => {
        const k = Math.floor(r.target / 2);
        if (statuses[s]?.reblogOf !== null || k % 3 !== 0) {
          return [];
        }
        const bits = Math.floor(k / 3);
        const author = statuses[s]?.author;
        const originals = statuses.flatMap((status, o) => (status.reblogOf === null && o !== s ? [o] : []));
        const own = originals.filter((o) => statuses[o]?.author === author);
        const candidates = Math.floor(bits / 10) % 2 === 1 && own.length > 0 ? own : originals;
        const gone = Math.floor(bits / 20) % 5 === 0;
        const quoted = gone ? null : (candidates[Math.floor(bits / 100) % Math.max(candidates.length, 1)] ?? null);
        const drawn = QUOTE_STATES[bits % QUOTE_STATES.length] ?? "pending";
        // An accepted quote has its quoted status (the schema's CHECK); a detach makes it deleted.
        const state = quoted === null && drawn === "accepted" ? "deleted" : drawn;
        return [{ status: s, quoted, state, legacy: Math.floor(bits / 5) % 2 === 1 }];
      }),
      dismissals: unique(
        raw.dismissals.map((d) => ({ owner: d.owner % LOCALS, target: d.target % n })),
        (d) => `${d.owner}:${d.target}`,
      ),
      now: raw.now,
    };
  });

// The tables a world fills, in an order that deletes children first.
const WORLD_TABLES = [
  "trend_links",
  "link_trend_reviews",
  "card_images",
  "follow_recommendation_mutes",
  "status_pins",
  "conversation_mutes",
  "conversation_statuses",
  "conversations",
  "list_accounts",
  "lists",
  "tag_follows",
  "notifications",
  "favourites",
  "bookmarks",
  "status_tags",
  "status_mentions",
  "quotes",
  "statuses",
  "follows",
  "blocks",
  "mutes",
  "domain_blocks",
  "instance_domain_blocks",
  "local_accounts",
  "accounts",
];

// Replaces the Store's accounts, statuses and edges with the world's, so one Store serves every case of a property.
export function writeWorld(sql: SqlStorage, world: World): void {
  for (const table of WORLD_TABLES) {
    sql.exec(`DELETE FROM ${table}`);
  }
  world.accounts.forEach((account, i) => {
    const username = account.name.toLowerCase();
    // Every account's search text holds "account", so an account search for it reads them all.
    sql.exec(
      `INSERT INTO accounts (id, uri, username, domain, search_text, deleted_at, hide_collections, suspended_at,
				suspension_source)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      accountId(i),
      account.uri,
      username,
      account.domain,
      `account ${account.domain === null ? username : `${username}@${account.domain}`}`,
      account.deleting ? "2026-01-01T00:00:00.000Z" : null,
      // A remote account Kopje has not learned of hides nothing, as one that shows its network.
      account.local || !account.hidesCollections ? null : 1,
      !account.local && (account.suspended || account.domainMarked === true) ? "2026-01-01T00:00:00.000Z" : null,
      account.local ? null : account.suspended ? "account" : account.domainMarked === true ? "domain" : null,
    );
    if (account.local) {
      sql.exec(
        `INSERT INTO local_accounts (account_id, email, privkey, privkey_salt, pubkey, suspended_at, hide_collections)
				VALUES (?, ?, X'00', X'00', 'test', ?, ?)`,
        accountId(i),
        `${username}@example.com`,
        account.suspended ? "2026-01-01T00:00:00.000Z" : null,
        account.hidesCollections ? 1 : 0,
      );
    }
  });
  // in_reply_to_account_id as statuses.ts writes it (Status#carried_over_reply_to_account_id): the parent's author,
  // or, when the author continues their own reply, that reply's partner; none for a reply to a status never stored.
  const partners: (string | null)[] = [];
  world.statuses.forEach((status, i) => {
    const parent = status.replyTo === null ? undefined : world.statuses[status.replyTo];
    const parentPartner = status.replyTo === null ? null : (partners[status.replyTo] ?? null);
    partners.push(
      parent === undefined
        ? null
        : parent.author === status.author && (parent.replyTo !== null || parent.replyToUnknown)
          ? parentPartner
          : accountId(parent.author),
    );
    sql.exec(
      `INSERT INTO statuses (id, uri, account_id, reblog_of_id, in_reply_to_uri, in_reply_to_id, in_reply_to_account_id,
				visibility, content, search_text, published_at, quote_policy, withdrawn)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      statusId(i),
      statusUri(i),
      accountId(status.author),
      status.reblogOf === null ? null : statusId(status.reblogOf),
      status.replyToUnknown ? unknownParentUri(i) : status.replyTo === null ? null : statusUri(status.replyTo),
      status.replyTo === null ? null : statusId(status.replyTo),
      partners[i] ?? null,
      status.visibility,
      status.reblogOf === null ? `<p>status ${i}</p>` : "",
      status.reblogOf === null ? `status ${i}` : null,
      new Date(statusPublished(world, i)).toISOString(),
      status.quotePolicy ?? 0,
      status.withdrawn === true ? 1 : 0,
    );
    for (const mention of status.mentions) {
      sql.exec(
        "INSERT INTO status_mentions (status_id, account_id, silent, requires_mention, author_id) VALUES (?, ?, ?, ?, ?)",
        statusId(i),
        accountId(mention.account),
        mention.silent ? 1 : 0,
        status.visibility === "direct" || status.visibility === "limited" ? 1 : 0,
        accountId(status.author),
      );
    }
    if (status.tagged) {
      sql.exec(
        "INSERT INTO status_tags (status_id, name, public) VALUES (?, 'cats', ?)",
        statusId(i),
        status.visibility === "public" ? 1 : 0,
      );
    }
  });
  for (const f of world.follows) {
    sql.exec(
      "INSERT INTO follows (account_id, target_account_id, state, show_reblogs, notify) VALUES (?, ?, ?, ?, ?)",
      accountId(f.from),
      accountId(f.to),
      f.accepted ? "accepted" : "pending",
      f.showReblogs ? 1 : 0,
      f.notify ? 1 : 0,
    );
  }
  for (const b of world.blocks) {
    sql.exec("INSERT INTO blocks (account_id, target_account_id) VALUES (?, ?)", accountId(b.from), accountId(b.to));
  }
  for (const m of world.mutes) {
    sql.exec(
      "INSERT INTO mutes (account_id, target_account_id, hide_notifications, expires_at) VALUES (?, ?, ?, ?)",
      accountId(m.from),
      accountId(m.to),
      m.hideNotifications ? 1 : 0,
      m.expiresAt,
    );
  }
  for (const d of world.domainBlocks) {
    sql.exec("INSERT INTO domain_blocks (account_id, domain) VALUES (?, ?)", accountId(d.owner), d.domain);
  }
  for (const b of world.instanceBlocks) {
    sql.exec(
      `INSERT INTO instance_domain_blocks (domain, severity, created_at, updated_at) VALUES (?, ?, ?, ?)`,
      b.domain,
      b.severity,
      world.now,
      world.now,
    );
  }
  for (const d of world.dismissals) {
    sql.exec(
      "INSERT INTO follow_recommendation_mutes (account_id, target_account_id) VALUES (?, ?)",
      accountId(d.owner),
      accountId(d.target),
    );
  }
  for (const follower of world.tagFollowers) {
    sql.exec("INSERT INTO tag_follows (account_id, name) VALUES (?, 'cats')", accountId(follower));
  }
  world.lists.forEach((list, l) => {
    sql.exec(
      "INSERT INTO lists (id, account_id, title, replies_policy, exclusive) VALUES (?, ?, ?, ?, ?)",
      listId(l),
      accountId(list.owner),
      `list ${l}`,
      list.repliesPolicy,
      list.exclusive ? 1 : 0,
    );
    for (const member of list.members) {
      sql.exec("INSERT INTO list_accounts (list_id, account_id) VALUES (?, ?)", listId(l), accountId(member));
    }
  });
  // Pinned in order, a minute apart, so the newest pin is the last.
  world.pins.forEach((p, i) => {
    sql.exec(
      "INSERT INTO status_pins (account_id, status_id, created_at) VALUES (?, ?, ?)",
      accountId(p.account),
      statusId(p.status),
      new Date(Date.parse(TIMES[0]) + i * 60_000).toISOString(),
    );
  });
  for (const m of world.conversationMutes) {
    sql.exec("INSERT INTO conversation_mutes (account_id, thread) VALUES (?, ?)", accountId(m.account), m.thread);
  }
  for (const q of world.quotes) {
    const quoted = q.quoted === null ? undefined : world.statuses[q.quoted];
    sql.exec(
      `INSERT INTO quotes (status_id, quoted_uri, quoted_status_id, quoted_account_id, state, legacy, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)`,
      statusId(q.status),
      q.quoted === null ? unknownParentUri(q.status) : statusUri(q.quoted),
      q.quoted === null ? null : statusId(q.quoted),
      quoted === undefined ? null : accountId(quoted.author),
      q.state,
      q.legacy ? 1 : 0,
      TIMES[0],
    );
  }
}
