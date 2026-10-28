import type { SQLInputValue } from "node:sqlite";

import type { Node } from "oxc-parser";
import { describe, expect, it } from "vitest";

import { createKopjeDatabase, readCatalog } from "../cli/lib/cutover/kopje-db.js";
import { splitStatements } from "../cli/lib/cutover/sql-script.js";
import { CATEGORIES } from "../cli/lib/cutover/verify-actual.js";
import { parse as parseSource, sources, walk } from "./source-scan.js";

// Every table and column of the migrated Store schema against the cutover tools that name them by hand: the converter
// (convert.js) writes columns of the Store schema, and the actual side of verify-conversion (verify-actual.js) reads
// them back from a dump. A migration that adds a table or column fails here until each tool handles it or a list below
// says why that tool leaves it alone. The dump, import and backup read their catalog from the live schema
// (src/platform/dump-catalog.ts, and its copy for the converter in cli/lib/cutover/kopje-db.js); both run here, so a
// table either leaves out must be in NOT_DUMPED.

// Tables neither dump catalog includes, each with why (the other tables are dumped and restored whole).
const NOT_DUMPED: Record<string, string> = {
  backup_media: "the backup's media index for one bucket; a restored Store starts a fresh media baseline",
  card_images: "card images re-encoded with no original kept; a restored Store shows its cards without them",
  kopje_migrations: "the dump header carries the applied migrations; the target records its own",
  media_orphans: "tombstones of R2 objects to delete; a restored Store must not delete what it restores",
  remote_media: "a cache of remote files; an imported or restored Store starts it empty and fills it again",
  remote_media_objects: "the cache's R2 ledger; remote/ is not backed up, and an empty ledger's orphans are swept",
  remote_media_usage: "the cache's sums, one row the migration inserts; an empty cache counts nothing",
  stream_conversation_marks:
    "the streaming conversation marks of one object; a restored Store makes them again from the conversations' stream_seq",
  stream_cursor: "the streaming fan-out's position, over the journal of one object",
  stream_delete_tombstones: "captures of the streaming journal of one object, which a restored Store does not send",
  stream_delete_viewers: "captures of the streaming journal of one object, which a restored Store does not send",
  stream_events: "the streaming journal of one object; a restored Store has no sockets to send it to",
  stream_subscriptions: "the streaming registry, derived from the open sockets of one object",
};

// Tables the cutover never carries: the converter writes nothing to them (docs/cutover.md, "Clients and settings").
const NOT_CARRIED: Record<string, string> = {
  account_invitations: "the Access admin invites from the target; legacy Wildebeest has no invitations",
  account_notes:
    "legacy never wrote its account_notes table, and a legacy row there stops the conversion (UNUSED_LEGACY_TABLES)",
  activity_counts: "the instance activity counted from the upgrade on; legacy Wildebeest tracks no activity",
  activity_logins: "the instance activity counted from the upgrade on; legacy Wildebeest tracks no activity",
  account_pins:
    "legacy never wrote its endorsements table, and a legacy row there stops the conversion (UNUSED_LEGACY_TABLES)",
  admin_actions: "the moderation log of Kopje; legacy Wildebeest has no admin API and logs no moderation",
  announcement_dismissals: "dismissals of announcements, which legacy Wildebeest does not have",
  announcement_reactions: "reactions to announcements, which legacy Wildebeest does not have",
  announcements: "announcements of the Access admin; legacy Wildebeest has none",
  account_trend_reviews: "the Access admin’s trends reviews of accounts; legacy Wildebeest has no trends review",
  account_warnings: "warnings of an admin account action; legacy Wildebeest has no moderation warnings",
  backup_media: "the backup media index of one bucket; a converted Store starts a fresh baseline",
  card_images: "card images Kopje's image round stores; legacy Wildebeest has none, and a carried status gets no card",
  card_oembed_endpoints: "oEmbed endpoints Kopje's card round discovers; legacy Wildebeest has none",
  collection_syncs: "work Kopje asks for when it stores a remote account's document; legacy has none",
  collection_pins_pending: "pinned statuses a sync of Kopje has yet to fetch; legacy has none",
  conversation_mutes:
    "legacy never wrote its conversation_mutes table, and a legacy row there stops the conversion (UNUSED_LEGACY_TABLES)",
  custom_emojis: "local custom emoji of Kopje; legacy Wildebeest has none (verify-actual fails on any row)",
  deliveries: "outbound queue; legacy queues are not carried",
  domain_block_cleanups: "pending work of a domain block made in Kopje",
  favourite_likes:
    "a remote favourite's outstanding Like ids; legacy keeps none for a remote favourite, so a carried one tracks none",
  fedify_kv: "federation cache",
  follow_recommendation_mutes: "dismissed follow suggestions; legacy Wildebeest has no suggestions",
  filter_keywords:
    "legacy never wrote filters (its filter_keywords is in UNUSED_LEGACY_TABLES, which stops the conversion)",
  filter_statuses:
    "legacy never wrote filters (its filter_statuses is in UNUSED_LEGACY_TABLES, which stops the conversion)",
  filters: "legacy never wrote filters (its filters is in UNUSED_LEGACY_TABLES, which stops the conversion)",
  inbound_jobs: "inbound queue; legacy queues are not carried",
  inbound_retractions: "inbound queue state",
  inbound_spool: "inbound queue state",
  instance_domain_blocks: "instance domain blocks made in Kopje; legacy Wildebeest has no instance-wide block",
  kopje_migrations: "the target Store records its own migrations",
  markers: "legacy never wrote its markers table, and a legacy row there stops the conversion (UNUSED_LEGACY_TABLES)",
  media_orphans: "tombstones of R2 objects; a converted Store has none",
  moderation_jobs: "pending work of a suspension made in Kopje; legacy has no suspension",
  moderation_reach: "the audience a moderation job of Kopje stages; legacy has none",
  remote_moderation_jobs: "pending work of a remote suspension made in Kopje; legacy has no suspension",
  retraction_stagings: "the staging of a retraction made in Kopje; legacy has none",
  retraction_reach: "the targets a retraction made in Kopje stages; legacy has none",
  notification_clears: "work of notifications cleared in Kopje; legacy deleted them at once",
  notification_dismissals: "work of notification groups dismissed in Kopje; legacy has no groups",
  notification_permissions: "legacy has no notification requests to accept: a converted Store has no permission",
  notification_policies: "legacy has no notification policy: every converted account has the defaults",
  notification_request_jobs: "work of requests answered in Kopje",
  notification_requests: "legacy never filtered a notification, so a converted Store has no request",
  oauth_tokens: "access tokens are not carried: users sign in again",
  outbound_activities: "outbound queue; legacy queues are not carried",
  outbound_receipts: "records of deliveries made by Kopje",
  outbound_targets: "outbound queue; legacy queues are not carried",
  poll_votes: "votes cast in Kopje; legacy never wrote its poll_votes table (UNUSED_LEGACY_TABLES)",
  polls:
    "polls of Kopje; legacy never wrote its polls table, and a legacy row there stops the conversion (UNUSED_LEGACY_TABLES)",
  push_deliveries: "push queue; legacy has no such data",
  push_subscriptions: "push subscriptions are not carried: clients register again",
  quote_requests: "quote requests Kopje answered; legacy has no quotes",
  quote_revocations: "stamps revoked while Kopje stored quotes; legacy has no quotes",
  quotes: "quotes Kopje received; legacy has no quotes, and a carried status's quote properties stay in raw",
  remote_field_links:
    "remote profile link checks Kopje's round makes; legacy Wildebeest has none, and a carried account is armed at its next store",
  remote_keys: "fetched again on demand",
  remote_media: "Kopje's cache of remote files; legacy Wildebeest has none, and a converted Store fills it again",
  remote_media_objects: "the cache's R2 ledger; legacy Wildebeest has none",
  remote_media_usage: "the cache's sums; the migration inserts the one row a converted Store starts from",
  reports: "reports made in Kopje; legacy Wildebeest has no reports",
  scheduled_statuses: "posts scheduled in Kopje; legacy Wildebeest has no scheduled statuses",
  status_cards: "link cards Kopje's round fetches; legacy Wildebeest has none, and a carried status gets none",
  status_pins:
    "legacy never wrote its status_pins table, and a legacy row there stops the conversion (UNUSED_LEGACY_TABLES)",
  stream_conversation_marks: "streaming state of one object; legacy has no streaming",
  stream_cursor: "streaming state of one object; legacy has no streaming",
  stream_delete_tombstones: "streaming state of one object; legacy has no streaming",
  stream_delete_viewers: "streaming state of one object; legacy has no streaming",
  stream_events: "streaming state of one object; legacy has no streaming",
  stream_subscriptions: "streaming state of one object; legacy has no streaming",
  link_provider_reviews: "the Access admin’s reviews of link publishers; legacy Wildebeest has no trends review",
  link_trend_reviews: "the Access admin’s reviews of trending links; legacy Wildebeest has no trends review",
  status_trend_reviews: "the Access admin’s trends reviews of statuses; legacy Wildebeest has no trends review",
  tag_trend_reviews:
    "the Access admin’s trends reviews of hashtags; legacy tags.trendable defaults to 1 and was never reviewed",
  trend_statuses: "scores the cron works out again from stored statuses; legacy keeps none",
  trend_links: "scores the cron works out again from stored cards; legacy keeps none",
  trend_tags: "scores the cron works out again from stored statuses; legacy keeps none",
  tag_follows:
    "legacy never wrote its followed_tags table, and a legacy row there stops the conversion (UNUSED_LEGACY_TABLES)",
  featured_tags:
    "legacy never wrote its featured_tags table, and a legacy row there stops the conversion (UNUSED_LEGACY_TABLES)",
};

// Tables the converter fills through Kopje's own code, over the rows it carried, rather than with SQL of its own: the
// function named, called in convert.js, writes every column.
const DERIVED: Record<string, { by: string; why: string }> = {
  conversation_statuses: {
    by: "backfillConversations",
    why: "the conversations of the direct statuses carried, as migration 0009_conversations backfills them",
  },
  conversations: {
    by: "backfillConversations",
    why: "the conversations of the direct statuses carried, as migration 0009_conversations backfills them",
  },
};

const ASSIGNED = "INTEGER PRIMARY KEY, assigned on insert";
const DEFAULT = "left at its default by the converter (NOT_CONVERTED)";

// Columns of carried tables the converter leaves at their schema defaults.
const NOT_CONVERTED: Record<string, string> = {
  "accounts.confirmed_username": "set when Kopje confirms a WebFinger domain; legacy has none",
  "accounts.emojis": "legacy has no custom emoji",
  "accounts.indexable": "legacy has no indexable setting: NULL, presented as false",
  "accounts.moved_to_account_id": "legacy keeps no account move: NULL, no pointer",
  "accounts.avatar_static_url": "legacy keeps no still image: NULL, the static is the avatar",
  "accounts.header_static_url": "legacy keeps no still image: NULL, the static is the header",
  "accounts.deleted_at": "set when a remote actor deletes itself in Kopje; legacy has no account being deleted",
  "accounts.document_revision": "0: Kopje issues a remote actor's revision when it stores its next document",
  "accounts.suspended_at": "set when the admin suspends a remote account in Kopje; legacy has no such suspension",
  "accounts.suspension_source": "set with accounts.suspended_at; legacy has no such suspension",
  "accounts.hide_collections": "learned when Kopje reads a remote account's collections; legacy learned none",
  "accounts.last_status_id": "written by the triggers of 0021_directory as the carried statuses are inserted",
  "blocks.id": ASSIGNED,
  "bookmarks.id": ASSIGNED,
  "domain_blocks.id": ASSIGNED,
  "favourites.id": ASSIGNED,
  "follows.id": ASSIGNED,
  "local_accounts.attribution_domains": "legacy has no attribution domains",
  "local_accounts.featured_announced":
    "0: other servers stored a converted actor without its featured collections, so its first Add or Remove sends it again",
  "local_accounts.fields": "legacy has no profile fields",
  "local_accounts.hide_collections": "legacy has no setting to hide the network: every account shows it",
  "local_accounts.suspended_at": "legacy has no suspension",
  "local_accounts.credential_epoch": "the credential epoch a suspension in Kopje moves; legacy has no suspension",
  "local_accounts.accept_requests_after": "the unlock acceptance cursor; legacy has no job running",
  "local_accounts.active_on": "legacy keeps no activity record: NULL, never recorded",
  "local_accounts.default_quote_policy":
    "legacy has no quote policy setting: a carried account gets Mastodon's default",
  "local_accounts.links_due_at": "legacy has no profile fields: no link check is due",
  "local_accounts.links_hold_until": "legacy has no profile fields: no link check was claimed",
  "local_accounts.links_claim": "legacy has no profile fields: no link check was claimed",
  "local_accounts.links_attempts": "legacy has no profile fields: no link check was claimed",
  "local_accounts.verified_links": "legacy has no profile fields: none is verified",
  "local_accounts.unverified_links": "legacy has no profile fields: none was checked",
  "media_attachments.blurhash": "legacy keeps no BlurHash of an attachment: NULL, none sent",
  "media_attachments.focus_x": "legacy has no focal point",
  "media_attachments.focus_y": "legacy has no focal point",
  "media_attachments.gc_at": "converted media is kept: attached, or a profile or earlier-version image",
  "media_attachments.scheduled_status_id": "held by a scheduled status of Kopje; legacy has none",
  "mutes.expires_at": "legacy mutes never expire",
  "mutes.id": ASSIGNED,
  "notifications.filtered": "legacy never filtered a notification: carried ones are shown, as stored ones are in 0020",
  "notifications.group_key":
    "legacy never grouped notifications: carried ones stay ungrouped, as stored ones do in 0017",
  "notifications.report_id": "legacy never notified of a report: carried ones name none, as stored ones do in 0040",
  "notifications.account_warning_id":
    "legacy never warned an account: carried ones name no warning, as stored ones do in 0062",
  "oauth_clients.authorized":
    "legacy carries no code or token: 0, marked when a user signs in through the app, as 0086 marks none without one",
  "status_edits.id": ASSIGNED,
  "status_edits.emojis": "legacy has no custom emoji",
  "status_edits.poll_options": "legacy has no polls",
  "statuses.application_id": "legacy records no app on a status: NULL, posted through no app",
  "statuses.emojis": "legacy has no custom emoji",
  "statuses.filter_text_units":
    "a measure of the filter text Kopje writers store; a carried status is unmeasured (NULL) and its level reads the bound",
  "statuses.quotes_count": "counts accepted quotes, which legacy has none of",
  "statuses.quote_policy":
    "legacy has no quote policies: a carried status stays unquotable, as 0037_quote_policy leaves it",
  "statuses.thread": "written by the trigger statuses_thread and given again by backfillConversations (DERIVED)",
  "statuses.withdrawn":
    "marks a retraction Kopje recorded (a local boost's Undo, a remote status's Delete); legacy has none",
};

const ID = "assigned by the converter; records are keyed by AP URIs, never by assigned ids";
const TIME = "row time (legacy cdate or the base time); only published_at is compared";
const COUNTER = "recomputed from carried rows, which are compared";
const ACCOUNT_COUNTER = `local: ${COUNTER}; remote: 0 until its collection sync learns it (the totalItems it reports)`;
const SEARCH = "search text derived from compared columns";
const FROM_RAW = "remote: read from raw, which is compared byte for byte; local: NULL";

// Columns of carried tables verify-conversion does not compare.
const NOT_VERIFIED: Record<string, string> = {
  "accounts.confirmed_username": DEFAULT,
  "accounts.created_at": TIME,
  "accounts.deleted_at": DEFAULT,
  "accounts.document_revision": DEFAULT,
  "accounts.fetched_at": TIME,
  "accounts.followers_count": ACCOUNT_COUNTER,
  "accounts.following_count": ACCOUNT_COUNTER,
  "accounts.hide_collections": DEFAULT,
  "accounts.indexable": DEFAULT,
  "accounts.moved_to_account_id": DEFAULT,
  "accounts.avatar_static_url": DEFAULT,
  "accounts.header_static_url": DEFAULT,
  "accounts.suspended_at": DEFAULT,
  "accounts.suspension_source": DEFAULT,
  "accounts.inbox_url": FROM_RAW,
  "accounts.last_status_id": "derived by triggers from the statuses, which are compared",
  "accounts.search_text": SEARCH,
  "accounts.shared_inbox_url": FROM_RAW,
  "accounts.statuses_count": ACCOUNT_COUNTER,
  "blocks.created_at": TIME,
  "conversations.stream_seq": "the streaming change sequence, 0 until the owner subscribes to `direct`",
  "blocks.id": DEFAULT,
  "bookmarks.created_at": TIME,
  "bookmarks.id": DEFAULT,
  "domain_blocks.created_at": TIME,
  "domain_blocks.id": DEFAULT,
  "favourites.created_at": TIME,
  "favourites.id": DEFAULT,
  "follows.created_at": TIME,
  "follows.id": DEFAULT,
  "lists.created_at": TIME,
  "local_accounts.created_at": TIME,
  "local_accounts.attribution_domains": DEFAULT,
  "local_accounts.featured_announced": DEFAULT,
  "local_accounts.fields": DEFAULT,
  "local_accounts.hide_collections": DEFAULT,
  "local_accounts.suspended_at": DEFAULT,
  "local_accounts.credential_epoch": DEFAULT,
  "local_accounts.accept_requests_after": DEFAULT,
  "local_accounts.active_on": DEFAULT,
  "local_accounts.default_quote_policy": DEFAULT,
  "local_accounts.links_due_at": DEFAULT,
  "local_accounts.links_hold_until": DEFAULT,
  "local_accounts.links_claim": DEFAULT,
  "local_accounts.links_attempts": DEFAULT,
  "local_accounts.verified_links": DEFAULT,
  "local_accounts.unverified_links": DEFAULT,
  "media_attachments.blurhash": DEFAULT,
  "media_attachments.created_at": TIME,
  "media_attachments.focus_x": DEFAULT,
  "media_attachments.focus_y": DEFAULT,
  "media_attachments.gc_at": DEFAULT,
  "media_attachments.id": ID,
  "media_attachments.processed": "always 1: converted media needs no processing",
  "media_attachments.scheduled_status_id": DEFAULT,
  "media_attachments.type":
    "classified from an attachment's type and mediaType, which legacy kept no class of; URL and description are compared",
  "mutes.created_at": TIME,
  "mutes.id": DEFAULT,
  "notifications.created_at": TIME,
  "notifications.filtered": DEFAULT,
  "notifications.group_key": DEFAULT,
  "notifications.report_id": DEFAULT,
  "notifications.account_warning_id": DEFAULT,
  "oauth_clients.authorized": DEFAULT,
  "oauth_clients.created_at": TIME,
  "status_edits.created_at": TIME,
  "status_edits.id": DEFAULT,
  "status_edits.poll_options": DEFAULT,
  "statuses.application_id": DEFAULT,
  "statuses.client_key": "Idempotency-Key, read only to answer a client's retried post with the status it made",
  "statuses.created_at": TIME,
  "statuses.favourites_count": COUNTER,
  "statuses.filter_text_units": DEFAULT,
  "statuses.in_reply_to_account_id": "derived from the reply links and authors, which are compared",
  "statuses.reblogs_count": COUNTER,
  "statuses.quotes_count": DEFAULT,
  "statuses.quote_policy": DEFAULT,
  "statuses.remote_version": "remote: published_at, or edited_at when edited; local: NULL",
  "statuses.replies_count": COUNTER,
  "statuses.search_text": SEARCH,
  "statuses.withdrawn": DEFAULT,
};

// Table name to its visible columns, as a Store migrated by every shipped migration has them.
function schemaColumns(): Map<string, string[]> {
  const db = createKopjeDatabase();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
    name: string;
  }[];
  const columns = new Map(
    tables.map(({ name }) => {
      const info = db.prepare("SELECT name FROM pragma_table_xinfo(?) WHERE hidden = 0 ORDER BY cid").all(name);
      return [name, (info as { name: string }[]).map((c) => c.name)] as const;
    }),
  );
  db.close();
  return columns;
}

function add(into: Map<string, Set<string>>, table: string, columns: Iterable<string>) {
  const set = into.get(table) ?? new Set<string>();
  for (const column of columns) {
    set.add(column);
  }
  into.set(table, set);
}

// A JavaScript source (source-scan.ts): each node with its ancestors, nearest first.
type Parsed = { text: string; nodes: { node: Node; parents: Node[] }[] };

function parse<Name extends string>(sources: Record<Name, string>): Record<Name, Parsed> {
  const parsed = Object.entries<string>(sources).map(([name, text]) => {
    const nodes: Parsed["nodes"] = [];
    walk(parseSource({ path: `${name}.js`, text }).program, (node, parents) => nodes.push({ node, parents }));
    return [name, { text, nodes }] as const;
  });
  return Object.fromEntries(parsed) as Record<Name, Parsed>;
}

const literal = (node: Node | null | undefined) =>
  node?.type === "Literal" && typeof node.value === "string"
    ? node.value
    : node?.type === "TemplateLiteral" && node.expressions.length === 0
      ? (node.quasis[0]?.value.cooked ?? undefined)
      : undefined;
const named = (node: Node | null | undefined, name: string) => node?.type === "Identifier" && node.name === name;
const declaredIn = (parents: Node[], name: string) =>
  parents.some((p) => p.type === "VariableDeclarator" && named(p.id, name));

// The assigned columns of an UPDATE's SET clause, up to its WHERE or end; null when an assignment has another form.
function assignedColumns(clause: string): string[] | null {
  const assigned: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= clause.length; i++) {
    const c = clause[i];
    if (c === "'") {
      i = clause.indexOf("'", i + 1);
      if (i === -1) {
        return null;
      }
      continue;
    }
    depth += c === "(" ? 1 : c === ")" ? -1 : 0;
    const end = depth === 0 && (c === undefined || /^\sWHERE\s/.test(clause.slice(i, i + 7)));
    if (depth === 0 && (c === "," || end)) {
      const column = /^\s*(\w+)\s*=/.exec(clause.slice(start, i))?.[1];
      if (column === undefined) {
        return null;
      }
      assigned.push(column);
      start = i + 1;
    }
    if (end) {
      return assigned;
    }
  }
  return null;
}

// What convert.js writes to the Kopje database. Its SQL runs through insert(sql), kopje.exec(sql) and
// kopje.prepare(sql) (insert wraps the last); the SQL must be one literal, split into statements by the cutover's own
// splitter. An INSERT or UPDATE adds its columns, an INSERT into kopje_state its one literal name; any other argument,
// statement or kopje_state row is unparsed.
function converterWrites({ text, nodes }: Parsed) {
  const columns = new Map<string, Set<string>>();
  const stateNames: string[] = [];
  const unparsed: string[] = [];
  for (const { node, parents } of nodes) {
    if (node.type !== "CallExpression" || declaredIn(parents, "insert")) {
      continue;
    }
    const { callee } = node;
    const onKopje = callee.type === "MemberExpression" && named(callee.object, "kopje");
    const computed = onKopje && callee.computed;
    const runs =
      named(callee, "insert") || (onKopje && (named(callee.property, "exec") || named(callee.property, "prepare")));
    const sql = runs && !computed ? literal(node.arguments[0]) : undefined;
    if (computed || (runs && sql === undefined)) {
      unparsed.push(text.slice(node.start, node.end));
    }
    for (const statement of sql === undefined ? [] : splitStatements(sql)) {
      const insert = /^INSERT\s+(?:OR\s+\w+\s+)?INTO\s+(\w+)\s*\(([^)]*)\)\s*VALUES\s*([\s\S]*)$/.exec(statement);
      const update = /^UPDATE\s+(\w+)\s+SET\s+([\s\S]*)$/.exec(statement);
      const inserted = insert?.[2]?.split(",").map((c) => c.trim());
      const assigned = update === null ? null : assignedColumns(update[2] ?? "");
      const state =
        insert?.[1] === "kopje_state" && inserted?.join() === "name,value"
          ? /^\(\s*'(\w+)'\s*,\s*\?\s*\)$/.exec(insert[3] ?? "")?.[1]
          : undefined;
      if (insert !== null && inserted?.every((c) => /^\w+$/.test(c)) && (insert[1] !== "kopje_state" || state)) {
        add(columns, insert[1] ?? "", inserted);
        if (state !== undefined) {
          stateNames.push(state);
        }
      } else if (update !== null && assigned !== null && update[1] !== "kopje_state") {
        add(columns, update[1] ?? "", assigned);
      } else if (!/^(?:SELECT|DELETE|PRAGMA|BEGIN|COMMIT)\b/.test(statement)) {
        unparsed.push(statement);
      }
    }
  }
  return { columns, stateNames, unparsed };
}

const isTableOfStatement = (node: Node) =>
  node.type === "MemberExpression" && named(node.object, "statement") && named(node.property, "table");

// The table a node of verify-actual.js reads for: the case clause of `switch (statement.table)` around it, or the
// block of `if (statement.table === 'table')` around it.
function tableOf(chain: Node[]): string | undefined {
  for (const [i, at] of chain.entries()) {
    const up = chain[i + 1];
    if (at.type === "SwitchCase" && up?.type === "SwitchStatement" && isTableOfStatement(up.discriminant)) {
      return literal(at.test);
    }
    if (up?.type === "IfStatement" && up.consequent === at && up.test.type === "BinaryExpression") {
      if (isTableOfStatement(up.test.left)) {
        return up.test.operator === "===" ? literal(up.test.right) : undefined;
      }
    }
  }
  return undefined;
}

// The columns verify-actual.js reads per table: t('column'), row.column, row['column'], and c === 'column' (a link
// statement's columns). A read outside a case clause or link block, or row[...] by a variable other than where the row
// is built (row[column] = ...) and in t itself, is unattributed. Also the categories its put(category, ...) calls
// record, which must be literal (else unattributed).
function verifierReads({ text, nodes }: Parsed) {
  const columns = new Map<string, Set<string>>();
  const unattributed: string[] = [];
  const categories = new Set<string>();
  for (const { node, parents } of nodes) {
    let column: string | undefined;
    if (node.type === "CallExpression" && named(node.callee, "put")) {
      const category = literal(node.arguments[0]);
      if (category === undefined) {
        unattributed.push(text.slice(node.start, node.end).replace(/\s+/g, " "));
      } else {
        categories.add(category);
      }
      continue;
    } else if (node.type === "CallExpression" && named(node.callee, "t")) {
      column = literal(node.arguments[0]);
    } else if (node.type === "MemberExpression" && named(node.object, "row")) {
      column = node.computed
        ? literal(node.property)
        : node.property.type === "Identifier"
          ? node.property.name
          : undefined;
      const parent = parents[0];
      const built = parent?.type === "AssignmentExpression" && parent.left === node;
      if (column === undefined && node.computed && (built || declaredIn(parents, "t"))) {
        continue;
      }
    } else if (node.type === "BinaryExpression" && named(node.left, "c")) {
      column = literal(node.right);
    } else {
      continue;
    }
    const table = column === undefined ? undefined : tableOf([node, ...parents]);
    if (column === undefined || table === undefined) {
      unattributed.push(text.slice(node.start, node.end).replace(/\s+/g, " "));
    } else {
      add(columns, table, [column]);
    }
  }
  return { columns, unattributed, categories };
}

// The `table.column` names where a dump catalog's columns differ from the schema's, missing or extra, in every table it
// dumps: a dumped table is dumped whole.
function catalogGaps(schema: Map<string, string[]>, catalog: { name: string; columns: string[] }[]): string[] {
  return catalog.flatMap(({ name, columns }) => {
    const all = schema.get(name) ?? [];
    const differ = [...all.filter((c) => !columns.includes(c)), ...columns.filter((c) => !all.includes(c))];
    return differ.map((c) => `${name}.${c}`);
  });
}

// The `table.column` names in `columns` that the schema does not have.
function unknown(schema: Map<string, string[]>, columns: Map<string, Set<string>>): string[] {
  return [...columns].flatMap(([table, names]) =>
    [...names].filter((c) => !(schema.get(table) ?? []).includes(c)).map((c) => `${table}.${c}`),
  );
}

const sorted = (names: Iterable<string>) => [...names].toSorted();
// The categories put records that compareConversion does not iterate (verify-actual.js CATEGORIES).
const unregistered = (categories: Iterable<string>) => sorted(categories).filter((c) => !CATEGORIES.includes(c));

function cutover(name: string): string {
  const source = sources("cli/lib/cutover", [".js"]).find((s) => s.path === `cli/lib/cutover/${name}`);
  if (source === undefined) {
    throw new Error(`no cli/lib/cutover/${name}`);
  }
  return source.text;
}
const files = parse({
  convert: cutover("convert.js"),
  verify: cutover("verify-actual.js"),
});
const schema = schemaColumns();
const converted = converterWrites(files.convert);

describe("the source scanners", () => {
  const fixtures = parse({
    writes: [
      "const insert = (sql) => kopje.prepare(sql)",
      "kopje.exec('UPDATE statuses SET retired_column = 0')",
      "kopje.prepare(\"UPDATE accounts SET a = ?, b = (SELECT count(*) FROM f WHERE f.x = 'y,z') WHERE id = ?\")",
      "kopje.exec(`\n\tUPDATE lists SET c = 1;\n\tUPDATE mutes SET d = 2\n`)",
      "insert('INSERT OR IGNORE INTO blocks (e, f) VALUES (?, ?)')",
      "kopje.prepare(\"INSERT OR REPLACE INTO kopje_state (name, value) VALUES ('kept', ?)\")",
      "// kopje.exec('UPDATE statuses SET commented = 0')",
      "const message = 'INSERT INTO statuses (new_column) VALUES (1)'",
      "if (failed) throw new Error('UPDATE failed')",
      "kopje.exec(`INSERT INTO ${table} (a) VALUES (1)`)",
      "kopje.exec('UPDATE accounts SET ' + column + ' = 1')",
      "insert(sql)",
      "kopje.prepare(\"INSERT INTO kopje_state (name, value) VALUES ('a', ?), ('b', ?)\")",
      "kopje.prepare(\"INSERT INTO kopje_state (value, name) VALUES (?, 'c')\")",
      "kopje['prepare']('INSERT INTO hidden (a) VALUES (1)')",
    ].join("\n"),
    reads: [
      "const shared = (row) => row.some_column",
      "for (const statement of statements) {",
      "\tif (statement.table === 'statuses') {",
      "\t\tstatement.where.find(([c]) => c === 'id')",
      "\t\tcontinue",
      "\t}",
      "\tconst row = {}",
      "\tstatement.columns.forEach((column, i) => { row[column] = statement.literals[i] ?? 'NULL' })",
      "\tconst t = (column) => textOf(row[column])",
      "\tt('stray')",
      "\tswitch (statement.table) {",
      "\t\tcase 'mutes':",
      "\t\t\tput('mutes', [int(row.hide_notifications), null, // t('expires_at'),",
      "\t\t\t\t/* row.commented */ row['quoted'], \"t('in_a_string')\", row[key]])",
      "\t\t\tput('polls', 1)",
      "\t\t\tput(category, 1)",
      "\t\t\tbreak",
      "\t\tdefault:",
      "\t\t\tbreak",
      "\t}",
      "}",
    ].join("\n"),
  });

  it("take SQL only from literal arguments of the calls that run it, statement by statement", () => {
    const { columns, stateNames, unparsed } = converterWrites(fixtures.writes);
    expect(columns).toEqual(
      new Map([
        ["statuses", new Set(["retired_column"])],
        ["accounts", new Set(["a", "b"])],
        ["lists", new Set(["c"])],
        ["mutes", new Set(["d"])],
        ["blocks", new Set(["e", "f"])],
        ["kopje_state", new Set(["name", "value"])],
      ]),
    );
    expect(stateNames).toEqual(["kept"]);
    expect(unparsed).toEqual([
      "kopje.exec(`INSERT INTO ${table} (a) VALUES (1)`)",
      "kopje.exec('UPDATE accounts SET ' + column + ' = 1')",
      "insert(sql)",
      "INSERT INTO kopje_state (name, value) VALUES ('a', ?), ('b', ?)",
      "INSERT INTO kopje_state (value, name) VALUES (?, 'c')",
      "kopje['prepare']('INSERT INTO hidden (a) VALUES (1)')",
    ]);
  });

  it("attribute reads to their case clause or link block, and report every other read", () => {
    const { columns, unattributed, categories } = verifierReads(fixtures.reads);
    expect(columns).toEqual(
      new Map([
        ["statuses", new Set(["id"])],
        ["mutes", new Set(["hide_notifications", "quoted"])],
      ]),
    );
    expect(unattributed).toEqual(["row.some_column", "t('stray')", "row[key]", "put(category, 1)"]);
    // A category compareConversion does not iterate would never be compared.
    expect(unregistered(categories)).toEqual(["polls"]);
  });
});

describe("the dump catalogs", () => {
  // The Store's catalog code, loaded by a computed path: test-node's tsconfig lacks the Workers types it is checked
  // with (the package's own tsc run checks it). Its SqlStorage is a thin adapter over the node database.
  // oxlint-disable-next-line typescript/no-unnecessary-template-expression -- a literal path would be type-checked
  const store = import(`../src/platform/${"dump-catalog"}.ts`) as Promise<{
    readCatalog: (sql: {
      exec: (query: string, ...bindings: SQLInputValue[]) => { toArray: () => unknown[] };
    }) => unknown;
    DUMPED_STATE: readonly string[];
  }>;

  it("match, dump every column of each table, and leave out only the tables NOT_DUMPED says why for", async () => {
    const db = createKopjeDatabase();
    const exec = (query: string, ...bindings: SQLInputValue[]) => ({
      toArray: () => db.prepare(query).all(...bindings),
    });
    const catalog = readCatalog(db);
    expect((await store).readCatalog({ exec })).toEqual(catalog);
    const dumped = new Set(catalog.map((spec) => spec.name));
    const left = [...schema.keys()].filter((table) => !dumped.has(table));
    expect(sorted(left)).toEqual(sorted(Object.keys(NOT_DUMPED)));
    expect(catalogGaps(schema, catalog)).toEqual([]);
    // Both catalogs leaving out the same column match each other, and still fail.
    const withoutEmail = catalog.map((spec) =>
      spec.name === "local_accounts" ? { ...spec, columns: spec.columns.filter((c) => c !== "email") } : spec,
    );
    expect(catalogGaps(schema, withoutEmail)).toEqual(["local_accounts.email"]);
  });

  it("keep every kopje_state name the converter writes", async () => {
    const { DUMPED_STATE } = await store;
    const { stateNames, unparsed } = converted;
    expect(unparsed).toEqual([]);
    expect(stateNames.length).toBeGreaterThan(0);
    expect(stateNames.filter((name) => !DUMPED_STATE.includes(name))).toEqual([]);
  });
});

describe("the Store schema in the cutover tools", () => {
  const { columns: written, unparsed } = converted;
  const { columns: read, unattributed, categories } = verifierReads(files.verify);
  const carried = [...schema.keys()].filter((table) => !(table in NOT_CARRIED));

  it("names only tables and columns the schema has", () => {
    expect(unknown(schema, written)).toEqual([]);
    expect(unknown(schema, read)).toEqual([]);
    expect(sorted(Object.keys(NOT_CARRIED).filter((t) => !schema.has(t)))).toEqual([]);
  });

  it("convert writes each table the cutover carries, and each of its columns or says why not", () => {
    expect(unparsed).toEqual([]);
    const own = carried.filter((table) => !(table in DERIVED));
    expect(sorted(written.keys())).toEqual(sorted(own));
    // Each derived table is the schema's and is filled by a call convert.js makes.
    for (const [table, { by }] of Object.entries(DERIVED)) {
      expect([table, schema.has(table)]).toEqual([table, true]);
      const called = files.convert.nodes.some(
        ({ node }) => node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === by,
      );
      expect([table, by, called]).toEqual([table, by, true]);
    }
    const unwritten = own.flatMap((table) =>
      (schema.get(table) ?? []).filter((c) => !written.get(table)?.has(c)).map((c) => `${table}.${c}`),
    );
    expect(sorted(unwritten)).toEqual(sorted(Object.keys(NOT_CONVERTED)));
  });

  it("verify-conversion reads each column of the tables the cutover carries, or says why not", () => {
    expect(unattributed).toEqual([]);
    expect(categories.size).toBeGreaterThan(0);
    expect(unregistered(categories)).toEqual([]);
    expect(sorted([...read.keys()].filter((table) => table in NOT_CARRIED))).toEqual([]);
    const unread = carried.flatMap((table) =>
      (schema.get(table) ?? []).filter((c) => !read.get(table)?.has(c)).map((c) => `${table}.${c}`),
    );
    expect(sorted(unread)).toEqual(sorted(Object.keys(NOT_VERIFIED)));
  });
});
