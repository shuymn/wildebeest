import { fixedColumns, selectSql } from "../db/columns";
import {
  ACCOUNTS_ID_INDEX,
  INSTANCE_DOMAIN_BLOCKS_DOMAIN_INDEX,
  POLL_VOTES_KEY_INDEX,
  POLLS_STATUS_INDEX,
  STATUSES_ID_INDEX,
} from "../db/indexes";
import type { Db } from "../db/sql";
import { isoTimeSql } from "../platform/stored-bounds";
import type { QuoteState } from "./quotes";

// Audience and visibility (Mastodon 4.7.3; docs/visibility.md). One module decides
// who may see a status or an account, for every read path, who is notified, whom an author may address, and how an
// audience is written to and read from ActivityPub addressing:
//
//   - the policy (visibleSql, listableSql, homeFilterSql, canView, the account predicates and shownSql): the read rule
//     (Mastodon's StatusPolicy#show? and StatusFilter) and the rules built on it. It exists only as SQL, so feeds
//     filter before LIMIT and no read path keeps a second copy of the rule in TypeScript.
//   - interpretAddressing: inbound to/cc/tag → visibility and silent mentions.
//   - addressingOf / audienceOf: a local status's to/cc and the accounts that must receive it.
//   - recipientsFor / addresses: whom an outbound activity reaches and names, by what it does (outboundKind).
//
// Visibilities are Mastodon's internal set. limited is Misskey's `specified` (and Mastodon's own limited): addressed
// recipients who are not mentioned in the text. Those recipients are status_mentions rows with silent = 1: they may
// see the status, but they are not shown in `mentions` and are not notified. The API shows limited as private.

export type Visibility = "public" | "unlisted" | "private" | "direct" | "limited";

// What the API accepts and shows.
export type ApiVisibility = Exclude<Visibility, "limited">;

export const API_VISIBILITIES: readonly ApiVisibility[] = ["public", "unlisted", "private", "direct"];

export function apiVisibility(visibility: Visibility): ApiVisibility {
  return visibility === "limited" ? "private" : visibility;
}

// direct and limited are seen by the author and the mentioned (silent included) only.
export function requiresMention(visibility: Visibility): boolean {
  return visibility === "direct" || visibility === "limited";
}

// Public and unlisted statuses reach beyond the author's followers (reblogs, reply counts, interactors).
export function isDistributable(visibility: Visibility): boolean {
  return visibility === "public" || visibility === "unlisted";
}

// ---------------------------------------------------------------------------------------------------------------
// The policy, as SQL fragments (docs/visibility.md): who may be seen, who sees what, what a viewer filters out, who is
// notified, and whom an author may address. This is the only module that reads blocks, mutes, domain_blocks or
// suspended_at to decide any of that, and the only one that spells a set of visibilities in SQL
// (test-node/policy-boundary.test.ts).
//
// Fragments take SQL expressions, normally numbered parameters: `s` is the alias of a statuses row, `x` an account id,
// `viewer` the viewer's account id (NULL for an anonymous viewer), and `now` the time the viewer's time-bound choices
// (a mute's expiry) are judged at. An operation binds them from its ViewerContext.
// ---------------------------------------------------------------------------------------------------------------

// Who reads, and when: the viewer's account id (null for an anonymous viewer or an app token) and the request time, as
// an ISO 8601 UTC time like the stored expires_at. Only the auth wrappers (auth.ts) build one, from the credential.
export type ViewerContext = { readonly accountId: string | null; readonly now: string };

// Every visibility, in the order the schema lists them, and the sets the rules use as SQL lists (`visibility IN ...`).
const VISIBILITIES: readonly Visibility[] = ["public", "unlisted", "private", "direct", "limited"];

function visibilitySetSql(member: (visibility: Visibility) => boolean): string {
  return `(${VISIBILITIES.filter(member)
    .map((visibility) => `'${visibility}'`)
    .join(", ")})`;
}

// public and unlisted (isDistributable).
export const DISTRIBUTABLE_SQL = visibilitySetSql(isDistributable);
// direct and limited (requiresMention).
export const REQUIRES_MENTION_SQL = visibilitySetSql(requiresMention);
// public, unlisted and private: what reaches the author's followers. The partial index statuses_feed declares this
// list, in this order, and SQLite uses it only for the same list.
export const REACHES_FOLLOWERS_SQL = visibilitySetSql((visibility) => !requiresMention(visibility));

// status_tags.public of a hashtag of the status `id`: whether the status is public, the only visibility hashtag timelines
// and a tag's history count (publicConditions in timelines.ts). A status's visibility is fixed when it is written, so
// the writers of status_tags set it with each row, and the partial index status_tags_public holds just those rows.
export function tagPublicSql(id: string): string {
  return `(SELECT tp.visibility = 'public' FROM main.statuses tp WHERE tp.id = ${id})`;
}

// status_cards.public of the card of the status `id` (migration 0071_link_trends): whether the status is public, the
// only visibility link trends count. The card's writers (link-cards.ts recordCard and its donor copy) set it from the
// status, never from another row, and only on a card with a final URL; enqueue clears it. The triggers refuse it on any
// other row, so the partial index status_cards_public_link holds public statuses' attached copies only.
export function cardPublicSql(id: string): string {
  return `coalesce((SELECT cp.visibility = 'public' FROM main.statuses cp WHERE cp.id = ${id}), 0)`;
}

// The columns of status_mentions copied from the mention's status, for its writers: requires_mention, whether the
// status is direct or limited (the only statuses home reads from the viewer's mentions), and author_id, the status's
// author. A status never changes author, and its visibility stays in or out of that set once written (a direct status
// gaining a recipient becomes limited), so the writers set both with each row, and the partial index
// status_mentions_requires_mention holds the marked rows by recipient and author.
export const MENTION_STATUS_COLUMNS = "requires_mention, author_id";

// The values of MENTION_STATUS_COLUMNS for a mention in the status `id`.
export function mentionStatusSql(id: string): string {
  return `(SELECT mr.visibility IN ${REQUIRES_MENTION_SQL} FROM main.statuses mr WHERE mr.id = ${id}),
		(SELECT ma.account_id FROM main.statuses ma WHERE ma.id = ${id})`;
}

// ---- Accounts. `x` is an expression for an account id, never a status or edge alias.

// R1 (Account#unavailable?): a suspended local account, a remote account the instance suspended (R38: accounts.
// suspended_at with suspension_source 'account', set in the suspension's transaction), a remote account whose deletion
// has started (accounts.deleted_at, set in the first transaction of its purge), and a remote account an instance domain
// block covers (R38, domainCoveredSql: read live, never from a mark: suspension_source 'domain' is not read), is seen
// by nobody, and nothing of it is shown or delivered. Three seeks: the local_accounts row, and the partial indexes of
// the suspended accounts (the row read only for an entry) and of the accounts being deleted, which hold no entry for
// any other account (INDEXED BY keeps the plan from reading the account's row instead). Domain
// coverage costs one constant seek per emitted predicate while the instance has no suspend block (guardedSql), so the
// rule then reads no row of an available account but its local_accounts row; otherwise it also reads the account's
// row by its key and seeks at most 4 × (MAX_BLOCK_LABELS - 1) blocks (coveredSql). An unknown id is available.
export function availableSql(x: string): string {
  return `(NOT EXISTS (SELECT 1 FROM main.local_accounts pl WHERE pl.account_id = ${x} AND pl.suspended_at IS NOT NULL
		UNION ALL SELECT 1 FROM main.accounts pa INDEXED BY accounts_deleted WHERE pa.id = ${x} AND pa.deleted_at IS NOT NULL
		UNION ALL SELECT 1 FROM main.accounts ps INDEXED BY accounts_suspended
			WHERE ps.id = ${x} AND ${individuallySuspendedSql("ps")})
		AND NOT ${guardedSql(accountCoveredSql(x))})`;
}

// The same rule for a local account whose local_accounts row `l` is already joined, so a query that has the row does
// not look it up again. A local account is never deleted or suspended through its accounts row (the schema refuses
// deleted_at and suspension_source on it).
export function availableLocalSql(l: string): string {
  return `${l}.suspended_at IS NULL`;
}

// The same rule for an account `a` with its local_accounts row `l` LEFT JOINed (NULL for a remote account), read from
// the two rows without another lookup of the account (domain coverage seeks the blocks only): account presentation
// (account-columns.ts ACCOUNT_COLUMN_MAP) and the admin's list of accounts (admin-accounts.ts) read both rows anyway.
export function availableJoinedSql(a: string, l: string): string {
  return `(${availableLocalSql(l)} AND ${a}.deleted_at IS NULL AND NOT ${individuallySuspendedSql(a)}
		AND NOT ${guardedSql(domainCoveredSql(a))})`;
}

// The remote accounts whose deletion has started, the entries of the partial index accounts_deleted: its range in id
// order is what the admin's list of suspended accounts reads of them.
export function deletingSql(a: string): string {
  return `${a}.deleted_at IS NOT NULL`;
}

// The remote accounts the instance suspended or a domain block's job marked (R38: suspension_source 'account' or
// 'domain'), the entries of the partial index accounts_suspended (migration 0045_remote_suspension): its range in id
// order is what the admin's list of suspended accounts reads of them, and what the domain job's clearing walks.
export function suspendedSql(a: string): string {
  return `${a}.suspended_at IS NOT NULL`;
}

// The accounts neither suspended by the instance (nor marked by a domain block's job) nor being deleted, the entries of
// the partial index accounts_active (migration 0045_remote_suspension): its range in id order is what the admin's list
// of active accounts walks. Marks lag the blocks, so the list answers 503 while the domain job runs (R38).
export function activeSql(a: string): string {
  return `(${a}.deleted_at IS NULL AND ${a}.suspended_at IS NULL)`;
}

// R38: the remote account `a` is suspended by the admin's own decision (suspension_source 'account'), which its job
// requires each round (remote-suspension.ts), and which a verified routing refresh may still update (inbox.ts).
export function individuallySuspendedSql(a: string): string {
  return `(${a}.suspended_at IS NOT NULL AND ${a}.suspension_source = 'account')`;
}

// R38: the remote account `a` is held by a domain mark (suspension_source 'domain'), which the domain job and the
// conversion write (remote-suspension.ts) and only the admin's lists and those jobs read: availability never does.
export function domainMarkedSql(a: string): string {
  return `(${a}.suspended_at IS NOT NULL AND ${a}.suspension_source = 'domain')`;
}

// Whether `owner` blocks the account `x`.
export function blocksSql(owner: string, x: string): string {
  return `EXISTS (SELECT 1 FROM main.blocks pb WHERE pb.account_id = ${owner} AND pb.target_account_id = ${x})`;
}

// Whether the mute row `m` applies at `now`: an indefinite mute, or one that has not expired yet. An expired mute stops
// applying at its time, whether or not it has been removed yet.
export function activeMuteSql(m: string, now: string): string {
  return `(${m}.expires_at IS NULL OR ${m}.expires_at > ${now})`;
}

// The mute of the account `x` by `owner` that applies at `now`, as `m`, LEFT JOINed (its options in a relationship).
export function activeMuteJoinSql(m: string, owner: string, x: string, now: string): string {
  return `LEFT JOIN main.mutes ${m} ON ${m}.account_id = ${owner} AND ${m}.target_account_id = ${x} AND ${activeMuteSql(m, now)}`;
}

// Whether `owner` mutes the account `x` at `now`; with `notifications`, only a mute that also hides notifications.
export function mutesSql(owner: string, x: string, now: string, notifications = false): string {
  return `EXISTS (SELECT 1 FROM main.mutes pm WHERE pm.account_id = ${owner} AND pm.target_account_id = ${x}
		${notifications ? "AND pm.hide_notifications = 1" : ""} AND ${activeMuteSql("pm", now)})`;
}

// The host of an actor id as hostDomain (platform/domain-name.ts) reads it, in SQL: scheme, path and port dropped,
// lowercased, without a trailing dot. Stored ids are URL hrefs, so an IDN host is already punycode.
function uriHostSql(uri: string): string {
  const rest = `substr(${uri}, instr(${uri}, '://') + 3)`;
  const hostPort = `substr(${rest}, 1, instr(${rest} || '/', '/') - 1)`;
  return `rtrim(lower(substr(${hostPort}, 1, instr(${hostPort} || ':', ':') - 1)), '.')`;
}

// Whether the remote account row `a` lives on `domain`, an expression for a normalized domain (lowercase, punycode, no
// trailing dot: how domain blocks are stored): by its stored domain (its canonical address's) or by the host of its
// actor id, so neither a confirmed domain elsewhere nor another spelling of the host lets an account escape a block of
// the server it lives on. Exactly, without subdomains (Mastodon's AccountDomainBlock). Only the account's side is
// normalized, so a stored domain is compared as it is and found through its index.
export function inDomainSql(a: string, domain: string): string {
  return `(${a}.domain IS NOT NULL AND ${domain} IN (rtrim(${a}.domain, '.'), ${uriHostSql(`${a}.uri`)}))`;
}

// ---- Instance domain blocks (R38, VIS-30; migration 0046_instance_domain_blocks)

// Labels a stored instance domain block has at most (the table's CHECK; instance-domain-blocks.ts refuses a deeper
// one), so a host's rule is always among its suffixes of at most this many labels, and a deeper host is still matched.
export const MAX_BLOCK_LABELS = 8;

// Whether the instance has a suspend block at all: one seek of a partial index holding the suspend blocks only. It
// names no outer column, so SQLite evaluates each occurrence once per statement (a statement that emits the predicate
// twice reads it twice), and guardedSql skips the per-account rule on an instance without one.
export const SUSPEND_BLOCKS_SQL = `EXISTS (SELECT 1 FROM main.instance_domain_blocks INDEXED BY instance_domain_blocks_suspend
	WHERE severity = 'suspend')`;

// `covered`, an account's coverage, only while a suspend block exists. A CASE, not an AND: SQLite evaluates both
// operands of an AND in a result column (account presentation's `available`), so only the CASE skips the walk there.
function guardedSql(covered: string): string {
  return `(CASE WHEN ${SUSPEND_BLOCKS_SQL} THEN ${covered} ELSE 0 END)`;
}

// Whether the rule of one of `keys`, a SELECT of normalized domains (column d: hostDomain or blockedDomain,
// platform/domain-name.ts), satisfies `rule`, a condition on its block `pr`. The rule that matches a domain is the
// block on the domain itself or on its nearest parent, the longest match (Mastodon's DomainBlock.rule_for,
// app/models/domain_block.rb:68), so a nearer block that does not satisfy `rule` exempts its subdomain tree from a
// parent's that does (a child noop from a parent's suspend; one without reject_media from a parent's). Each key's
// suffixes are walked from the longest, and the walk stops at the first one a block names (the nearest), so the rule
// is that block's; only suffixes of 2 to MAX_BLOCK_LABELS labels are sought, at most two unique seeks each (the walk's
// and the match's; CROSS JOIN and INDEXED BY keep each a seek by domain for each suffix, whatever the statistics say
// of the blocks: a rule no partial index serves was otherwise planned as a scan of the blocks). The keys and the walk
// are CTEs, whose expressions do not add to the depth of the expression that holds this one (SQLite limits it to 100
// in workerd).
function ruledSql(keys: string, rule: string): string {
  const sought = `BETWEEN 1 AND ${MAX_BLOCK_LABELS - 1}`;
  return `EXISTS (WITH RECURSIVE pk(d) AS (${keys}),
			ps(d, dots) AS (SELECT d, length(d) - length(replace(d, '.', '')) FROM pk
				UNION ALL SELECT substr(d, instr(d, '.') + 1), dots - 1 FROM ps WHERE dots > 1
					AND NOT EXISTS (SELECT 1 FROM main.instance_domain_blocks pn INDEXED BY ${INSTANCE_DOMAIN_BLOCKS_DOMAIN_INDEX}
						WHERE ps.dots ${sought} AND pn.domain = ps.d))
		SELECT 1 FROM ps CROSS JOIN main.instance_domain_blocks pr INDEXED BY ${INSTANCE_DOMAIN_BLOCKS_DOMAIN_INDEX}
			ON pr.domain = ps.d
		WHERE ps.dots ${sought} AND ${rule})`;
}

// Whether an instance domain block covers one of `keys` (ruledSql): the rule of one is a suspend.
function coveredSql(keys: string): string {
  return ruledSql(keys, "pr.severity = 'suspend'");
}

// R38 reject_media (Mastodon's DomainBlock.reject_media?, app/models/domain_block.rb:58-60): the rule of one of `keys`
// (ruledSql) has reject_media, so no remote media of it is cached (domain/remote-media.ts slotEligibleSql). Not
// guarded as coverage is (guardedSql): no index holds the reject_media blocks alone, and its readers are the cache's
// own bounded walks and enqueues.
function mediaRejectedSql(keys: string): string {
  return ruledSql(keys, "pr.reject_media = 1");
}

// Whether an instance domain block covers `host`, an expression for a normalized domain.
export function hostCoveredSql(host: string): string {
  return coveredSql(`SELECT ${host}`);
}

// The keys inDomainSql compares of the remote account row `a`, from `from` (which names `a`): its stored domain and
// its actor id's host, once each. None for a local account.
function accountKeysSql(a: string, from: string): string {
  return `SELECT DISTINCT CASE pv.n WHEN 1 THEN rtrim(${a}.domain, '.') ELSE ${uriHostSql(`${a}.uri`)} END
		FROM ${from} (SELECT 1 AS n UNION ALL SELECT 2) pv WHERE ${a}.domain IS NOT NULL`;
}

// Whether an instance domain block covers the account row `a`, already in scope, by either key.
export function domainCoveredSql(a: string): string {
  return coveredSql(accountKeysSql(a, ""));
}

// Whether an instance domain block covers the account `x` by either key: its row read once by its key.
function accountCoveredSql(x: string): string {
  return coveredSql(
    `${accountKeysSql("pc", `main.accounts pc INDEXED BY ${ACCOUNTS_ID_INDEX} CROSS JOIN`)} AND pc.id = ${x}`,
  );
}

// Whether the media of `host`, an expression for a normalized domain, is rejected (mediaRejectedSql): an emoji slot's
// domain (remote-media.ts), or hostMediaRejected's (instance-domain-blocks.ts).
export function hostMediaRejectedSql(host: string): string {
  return mediaRejectedSql(`SELECT ${host}`);
}

// Whether the media of the remote account row `a`, already in scope, is rejected (mediaRejectedSql). reject_media is
// judged by the account's stored domain only, as Mastodon's DomainBlock.reject_media?(account.domain) and as an emoji
// slot of its objects is keyed (remote-media.ts noteEmojiSnapshot), while suspend coverage judges both the stored
// domain and the actor host (accountKeysSql): a reject_media rule naming only the actor's host does not keep the
// account's media uncached, and a request to a suspended host is still refused by coverage at every hop. None for a
// local account.
export function domainMediaRejectedSql(a: string): string {
  return mediaRejectedSql(`SELECT rtrim(${a}.domain, '.') WHERE ${a}.domain IS NOT NULL`);
}

// The same rule, by the stored domain only, for the account `x`: its row read once by its key, then at most
// 2 × (MAX_BLOCK_LABELS - 1) block seeks. An unknown or local account's media is not rejected.
export function accountMediaRejectedSql(x: string): string {
  return mediaRejectedSql(`SELECT rtrim(pm.domain, '.') FROM main.accounts pm INDEXED BY ${ACCOUNTS_ID_INDEX}
		WHERE pm.id = ${x} AND pm.domain IS NOT NULL`);
}

// Whether `owner` blocks the domain of the account `x`: two seeks of the (account_id, domain) index, however many
// domains the owner blocks.
export function domainBlocksSql(owner: string, x: string): string {
  return `EXISTS (SELECT 1 FROM main.accounts pda INDEXED BY ${ACCOUNTS_ID_INDEX}
		CROSS JOIN main.domain_blocks pdb ON pdb.account_id = ${owner} AND ${inDomainSql("pda", "pdb.domain")}
		WHERE pda.id = ${x})`;
}

// Whether `owner` blocks the account `x` or its domain. Such an account is never a recipient of the owner's content
// (R17, R23: Mastodon's ProcessMentionsService drops the mention).
export function blockedSql(owner: string, x: string): string {
  return `(${blocksSql(owner, x)} OR ${domainBlocksSql(owner, x)})`;
}

// R7 (StatusFilter): whether `viewer` filters the account `x` out of lists at `now`: it blocks or mutes it (while the
// mute applies), or blocks its domain. Nobody filters themselves; an anonymous viewer filters nothing.
export function filteredForSql(x: string, viewer: string, now: string): string {
  return `(${viewer} IS NOT NULL AND ${x} IS NOT ${viewer}
		AND (${blocksSql(viewer, x)} OR ${mutesSql(viewer, x, now)} OR ${domainBlocksSql(viewer, x)}))`;
}

// R12: whether the account `x` may be listed to `viewer` among others (who favourited or boosted): it is available,
// the viewer does not filter it, and it does not block the viewer.
export function listedForSql(x: string, viewer: string, now: string): string {
  return `(${availableSql(x)} AND NOT ${filteredForSql(x, viewer, now)} AND NOT ${blocksSql(x, viewer)})`;
}

// R17: whether `author` may mention or address the account `x`: it is available, and the author blocks neither it nor
// its domain.
export function mentionableBySql(x: string, author: string): string {
  return `(${availableSql(x)} AND NOT ${blockedSql(author, x)})`;
}

// R21 (FollowService): whether `viewer` may follow the account `x`: it is available and someone else, neither blocks
// the other, and the viewer does not block its domain.
export function followableBySql(x: string, viewer: string): string {
  return `(${availableSql(x)} AND ${x} <> ${viewer} AND NOT ${blocksSql(x, viewer)} AND NOT ${blockedSql(viewer, x)})`;
}

// R14 (Account::Search): whether `viewer` finds the account `x` by account search or by search resolution: it is
// available, and the viewer does not block its domain. Mastodon's search leaves out suspended accounts only; Kopje
// also leaves out what the viewer's domain block hides everywhere else.
export function findableBySql(x: string, viewer: string): string {
  return `(${availableSql(x)} AND NOT ${domainBlocksSql(viewer, x)})`;
}

// Whether the account `x` hides its network (Account#hide_collections): a local account's setting
// (local_accounts.hide_collections), or what Kopje learned of a remote account's (accounts.hide_collections, migration
// 0025_remote_collections; a remote account it has not learned hides nothing). Two key lookups.
export function hidesCollectionsSql(x: string): string {
  return `(EXISTS (SELECT 1 FROM main.local_accounts ph WHERE ph.account_id = ${x} AND ph.hide_collections = 1)
		OR EXISTS (SELECT 1 FROM main.accounts pha INDEXED BY ${ACCOUNTS_ID_INDEX} WHERE pha.id = ${x} AND pha.hide_collections = 1))`;
}

// R13 (FollowerAccountsController#hide_results?): whether `viewer` (NULL: anonymous) is shown the followers and
// following of `owner`: the owner is available and, unless the viewer is the owner, neither hides its network nor
// blocks the viewer.
export function followListsShownSql(owner: string, viewer: string): string {
  return `(${availableSql(owner)}
		AND (${owner} IS ${viewer} OR (NOT ${hidesCollectionsSql(owner)} AND NOT ${blocksSql(owner, viewer)})))`;
}

// R13 (Account#excluded_from_timeline_account_ids): whether the account `x` is listed among the followers or following
// of `owner` to `viewer` at `now`. An anonymous viewer and the owner see every entry; anyone else does not see an
// account they block or mute (while the mute applies), or one that blocks them. An unavailable account stays listed
// (and is presented redacted), as Mastodon lists a suspended one, until a purge removes its follows.
export function followListedSql(x: string, owner: string, viewer: string, now: string): string {
  return `(${viewer} IS NULL OR ${viewer} IS ${owner}
		OR NOT (${blocksSql(viewer, x)} OR ${blocksSql(x, viewer)} OR ${mutesSql(viewer, x, now)}))`;
}

// R39 (AccountSuggestions::FriendsOfFriendsSource): whether the viewer's follow of `owner` brings the accounts the
// owner follows into the viewer's suggestions: R13 shows the viewer the owner's following. Mastodon asks only that the
// owner does not hide its network; Kopje also asks R13's availability and no block of the viewer (VIS-8).
export function suggestionSourceSql(owner: string, viewer: string): string {
  return followListsShownSql(owner, viewer);
}

// R39: whether the account `x`, with its accounts row `a` in scope, is a candidate for the suggestions of `viewer`:
// someone else, discoverable (accounts.discoverable = 1), neither followed nor requested by the viewer (a follow in
// either state, one seek of follows_pair), and not dismissed by them (follow_recommendation_mutes). R12
// (listedForSql) judges each candidate after this.
export function suggestionCandidateSql(x: string, a: string, viewer: string): string {
  return `(${x} <> ${viewer} AND ${a}.discoverable = 1
		AND NOT EXISTS (SELECT 1 FROM main.follows pf WHERE pf.account_id = ${viewer} AND pf.target_account_id = ${x})
		AND NOT EXISTS (SELECT 1 FROM main.follow_recommendation_mutes pr
			WHERE pr.account_id = ${viewer} AND pr.target_account_id = ${x}))`;
}

// R28 (Accounts::EndorsementsController#set_endorsed_accounts): whether the accounts `owner` endorses are listed. They
// are public: to anyone, the owner itself included, while the owner is available (an unavailable one lists none).
export function endorsementsShownSql(owner: string): string {
  return availableSql(owner);
}

// R28 (`endorsed_accounts.without_suspended`): whether the endorsed account `x` is listed: while it is available.
export function endorsementListedSql(x: string): string {
  return availableSql(x);
}

// R40 (Announcement.published): whether the announcement row `a` is shown, to every signed-in local user alike, and its
// dismissal and reactions are accepted; otherwise it answers 404. Its tables are announcements.ts's alone.
export function announcementShownSql(a: string): string {
  return `${a}.published = 1`;
}

// ---- Statuses. `s` is the alias of a statuses row.

// Whether `viewer` is a remote account (accounts.domain is set). It does not depend on a status, so SQLite evaluates
// it once per query, and a local viewer pays one row for it however many statuses are judged. A rule guards a lookup
// with it in a CASE, which skips the lookup when it is false (an AND may evaluate both operands).
function remoteSql(viewer: string): string {
  return `EXISTS (SELECT 1 FROM main.accounts pv INDEXED BY ${ACCOUNTS_ID_INDEX} WHERE pv.id = ${viewer} AND pv.domain IS NOT NULL)`;
}

// R41 (Trends::Statuses#eligible?, app/models/trends/statuses.rb:91-115): whether the status row `s` may trend at `now`
// (an ISO time), `langs` a JSON array of the languages Mastodon supports (trend-languages.ts TREND_LANGUAGES): a public
// original that is not a reply (an unresolved reply too), without a content warning (ASCII-trimmed) and not sensitive,
// in a supported language, published by `now` (its published_at read as the 24-byte ISO form, isoTimeSql), by an
// available and discoverable author whom anyone may see (R2 with no viewer), and quoting nothing or a status its quote
// lets through (Quote#acceptable?: accepted, or not legacy) that is present, public, by an available and discoverable
// author, not sensitive and without a content warning. Every such status is on the anonymous public timeline, so a
// trend list shows nothing a public read would not. Whether a trend is allowed (reviews) is trends.ts's.
export function trendableStatusSql(s: string, now: string, langs: string): string {
  const plain = (r: string) =>
    `${r}.sensitive = 0 AND trim(${r}.spoiler_text, ' ' || char(9, 10, 11, 12, 13)) = ''
		AND EXISTS (SELECT 1 FROM main.accounts ${r}_ta WHERE ${r}_ta.id = ${r}.account_id AND ${r}_ta.discoverable = 1)`;
  return `(${s}.visibility = 'public' AND ${s}.reblog_of_id IS NULL AND ${s}.in_reply_to_uri IS NULL AND ${plain(s)}
		AND ${s}.language IN (SELECT value FROM json_each(${langs}))
		AND ${isoTimeSql(`${s}.published_at`)} <= ${now}
		AND ${visibleSql(s, "NULL")}
		AND (NOT EXISTS (SELECT 1 FROM main.quotes ${s}_tq WHERE ${s}_tq.status_id = ${s}.id)
			OR EXISTS (SELECT 1 FROM main.quotes ${s}_tq CROSS JOIN main.statuses ${s}_tqs ON ${s}_tqs.id = ${s}_tq.quoted_status_id
				WHERE ${s}_tq.status_id = ${s}.id AND (${s}_tq.state = 'accepted' OR ${s}_tq.legacy = 0)
					AND ${s}_tqs.visibility = 'public' AND ${plain(`${s}_tqs`)} AND ${availableSql(`${s}_tqs.account_id`)})))`;
}

// R43 (Mastodon's FetchLinkCardService, app/services/fetch_link_card_service.rb:22): whether the status `id` may
// hold a card and have its link fetched (link-cards.ts, at enqueue, at claim and at record): an original, public or
// unlisted (Mastodon fetches every visibility), by an available author (R1), with no shown attachment (with_media?,
// the current ones) and no quote row in any state (quote.present?). Each read by key.
export function cardEligibleSql(id: string): string {
  return `EXISTS (SELECT 1 FROM main.statuses ce INDEXED BY ${STATUSES_ID_INDEX} WHERE ce.id = ${id}
		AND ce.reblog_of_id IS NULL AND ce.visibility IN ${DISTRIBUTABLE_SQL} AND ${availableSql("ce.account_id")}
		AND NOT EXISTS (SELECT 1 FROM main.media_attachments cm WHERE cm.status_id = ce.id AND cm.shown = 1)
		AND NOT EXISTS (SELECT 1 FROM main.quotes cq WHERE cq.status_id = ce.id))`;
}

// R2 (StatusPolicy#show?): whether `viewer` may see the row itself.
//   - a status of an unavailable author is seen by nobody;
//   - a withdrawn status (statuses.withdrawn: its removal under way, its retraction recorded unless its identity is
//     past its bound) is seen by nobody, its author included, as Mastodon's kept scope leaves out a discarded status;
//   - the author sees everything else of their own;
//   - an author who blocks the viewer hides everything from them;
//   - public and unlisted are seen by everyone else but a remote account on a domain the author blocks
//     (author_blocking_domain?);
//   - private is seen by accepted followers and the mentioned (silent included);
//   - direct and limited are seen by the mentioned (silent included) only.
// It has no time: nothing the viewer chose changes what they may see.
export function visibleSql(s: string, viewer: string): string {
  return `(${availableSql(`${s}.account_id`)} AND ${s}.withdrawn = 0
		AND (${s}.account_id IS ${viewer}
			OR (NOT ${blocksSql(`${s}.account_id`, viewer)} AND ${audienceCaseSql(s, viewer)})))`;
}

// R2's terms on the row's visibility and audience: public and unlisted to everyone but a remote account on a domain
// the author blocks, private to accepted followers and the mentioned, direct and limited to the mentioned.
function audienceCaseSql(s: string, viewer: string): string {
  return `(CASE WHEN ${s}.visibility IN ${DISTRIBUTABLE_SQL}
		THEN CASE WHEN ${remoteSql(viewer)} THEN NOT ${domainBlocksSql(`${s}.account_id`, viewer)} ELSE 1 END
		ELSE (${s}.visibility = 'private' AND EXISTS (SELECT 1 FROM main.follows fo
				WHERE fo.account_id IS ${viewer} AND fo.target_account_id = ${s}.account_id AND fo.state = 'accepted'))
			OR EXISTS (SELECT 1 FROM main.status_mentions sm WHERE sm.status_id = ${s}.id AND sm.account_id IS ${viewer})
		END)`;
}

// The part of R2 a candidate window keeps (windows.ts, docs/visibility.md "Read bounds"): the row is the viewer's own,
// or it is not withdrawn and its visibility and audience let the viewer see it, and so for a boost's original.
// Availability, the author's block of the viewer, the viewer's own filters and the withdrawal of the viewer's own row
// are left to the rule over the candidates, so a window skips only rows hidden for those reasons (the viewer knows the
// ids of their own rows), and a row the viewer may not see by its visibility or withdrawal never supplies a cursor.
export function audienceSql(s: string, viewer: string): string {
  const row = (r: string) => `(${r}.account_id IS ${viewer} OR (${r}.withdrawn = 0 AND ${audienceCaseSql(r, viewer)}))`;
  return `(${row(s)} AND (${s}.reblog_of_id IS NULL
		OR EXISTS (SELECT 1 FROM main.statuses ${s}_ao WHERE ${s}_ao.id = ${s}.reblog_of_id AND ${row(`${s}_ao`)})))`;
}

// R3: a status may be shown by itself (GET /statuses/:id): the row is visible and, for a reblog, so is the original.
function viewableSql(s: string, viewer: string): string {
  return `(${visibleSql(s, viewer)} AND (${s}.reblog_of_id IS NULL OR EXISTS (SELECT 1 FROM main.statuses ${s}_o
		WHERE ${s}_o.id = ${s}.reblog_of_id AND ${visibleSql(`${s}_o`, viewer)})))`;
}

// R8: a status may be listed (feeds, context, bookmarks, favourites, search): viewable, and the viewer filters neither
// its author nor a reblogged original's at `now`.
export function listableSql(s: string, viewer: string, now: string): string {
  return `(${visibleSql(s, viewer)} AND NOT ${filteredForSql(`${s}.account_id`, viewer, now)}
		AND (${s}.reblog_of_id IS NULL OR EXISTS (SELECT 1 FROM main.statuses ${s}_o WHERE ${s}_o.id = ${s}.reblog_of_id
			AND ${visibleSql(`${s}_o`, viewer)} AND NOT ${filteredForSql(`${s}_o.account_id`, viewer, now)})))`;
}

// R9, what home hides of a status for the viewer's choices (FeedManager#filter_from_home): what the list rule hides,
// and a status or boosted original that mentions (not silently) an account the viewer blocks or mutes at `now`; the
// viewer's own statuses always pass. Home applies it, and so does a post notification: FeedInsertWorker notifies only
// of a status home shows. Home's membership and the follow's options (boosts, replies, languages) are home's own.
// For the public statuses home shows by a followed hashtag, it is FeedManager#filter_from_tags?: the author or an
// active mention blocked or muted by the viewer, an author blocking the viewer and the author's domain blocked by the
// viewer each leave a status out (the viewer's own are home's anyway).
export function homeFilterSql(s: string, viewer: string, now: string): string {
  return `(${listableSql(s, viewer, now)}
		AND (${s}.account_id IS ${viewer} OR NOT EXISTS (SELECT 1 FROM main.status_mentions phm
			WHERE phm.status_id IN (${s}.id, ${s}.reblog_of_id) AND phm.silent = 0
			AND (${blocksSql(viewer, "phm.account_id")} OR ${mutesSql(viewer, "phm.account_id", now)}))))`;
}

// What the `public*` and `hashtag*` streams leave out beyond their timelines' rule (R33; Mastodon's streaming server
// filters each connection's statuses, streaming/index.js streamFrom): whether the status `statusId` mentions (not
// silently, as its `mentions` show them) an account the viewer blocks or mutes at `now`. The status's mentions are
// read by its key, each checked by the (account_id, target_account_id) keys, so the work does not grow with the
// viewer's blocks or mutes.
export function mentionsFilteredFor(db: Db, viewerId: string, now: string, statusId: string): boolean {
  return (
    db.first(
      `SELECT 1 AS x FROM main.status_mentions fm WHERE fm.status_id = ?2 AND fm.silent = 0
				AND (${blocksSql("?1", "fm.account_id")} OR ${mutesSql("?1", "fm.account_id", "?3")})
			LIMIT 1`,
      viewerId,
      statusId,
      now,
    ) !== undefined
  );
}

// The rule for one status: whether `viewerId` (null: anonymous) may see it by itself.
export function canView(db: Db, viewerId: string | null, statusId: string): boolean {
  return (
    db.first(
      `SELECT 1 AS ok FROM main.statuses s WHERE s.id = ?2 AND ${viewableSql("s", "?1")}`,
      viewerId,
      statusId,
    ) !== undefined
  );
}

// ---- Status ids the presenter accepts (status-presenter.ts). Types only: a brand costs nothing at run time, and only
// the functions below make one: from the rows of a query they wrote with the rule in it, or after canView or the
// author's check. test-node/policy-boundary.test.ts keeps every other module from making one (no cast, type argument
// or type predicate names a brand).

declare const visibleStatus: unique symbol;
declare const ownStatus: unique symbol;

// A status the read rule passed for the viewer: a query statusReads wrote with visibleSql, listableSql, homeFilterSql
// or shownSql, or canView (viewableStatusId). A boost's original is judged again by the presenter.
export type VisibleStatusId = string & { readonly [visibleStatus]: true };

// A status of the viewer's own, for the response to their own write (post, edit, delete, boost): the author sees all of
// their own (R2), but not necessarily a boosted original, which the presenter judges for them.
export type OwnStatusId = string & { readonly [ownStatus]: true };

type Visible<T> = T extends string ? VisibleStatusId : T;

// Rows whose column `K` holds the ids (or null) a rule passed, as StatusReads returns them.
export type WithVisibleStatus<Row, K extends keyof Row> = { [P in keyof Row]: P extends K ? Visible<Row[P]> : Row[P] };

// The read rule a status query applies: R2, R8 or R9.
export type StatusRule = "visible" | "listable" | "homeFilter";

// One SELECT of statuses as StatusReads writes it, from the caller's parts:
//   SELECT s.id AS id FROM <from> main.statuses s <join> WHERE (<where>) AND (<rule over s>) AND (<and>) <tail>
// The rule is a conjunct of the SELECT's own WHERE, over the `statuses s` it selects the id of; the caller's conditions
// go before or after it, so the terms keep the order (and the plan) a hand-written query would give them.
export type StatusSelect = {
  // Tables before `statuses s`, ending with the join to it (`bookmarks e JOIN`).
  readonly from?: string | undefined;
  // What follows `statuses s`: the ON of that join, and further joins.
  readonly join?: string | undefined;
  // Conditions before the rule, and after it.
  readonly where?: string;
  readonly and?: string | undefined;
  // ORDER BY, LIMIT and OFFSET.
  readonly tail?: string;
};

// A window of each author's statuses, for a feed of whole authors (home, a list), as StatusReads writes it:
//   SELECT w.id AS id FROM (SELECT wa.account_id FROM (<authors>) wa WHERE <rule over the author>) a
//     CROSS JOIN main.statuses w ON w.id IN (SELECT s.id FROM <from> main.statuses s <join>
//     WHERE (<author> = a.account_id AND <where>) AND (<rule over s>) AND (<and>) <tail>)
// <author> is s.account_id unless given: a window read from another index (the viewer's mentions by author) names the
// column of the author there, with the tables before statuses in <from> and the join after it in <join>, as a
// StatusSelect has them.
// <authors> selects each author once, as account_id, and <tail> orders each author's statuses by id and cuts them to a
// page: so a status of a merged page is within its author's window, the page is the one a single SELECT over all the
// authors' statuses gives, and an author costs a window however many statuses they have. The rule over the author is
// the part of the rule that holds for all of an author's statuses or none (authorRuleSql): an author it rejects has no
// window, rather than one that walks their whole history finding nothing.
export type AuthorWindows = {
  readonly authors: string;
  readonly from?: string;
  readonly join?: string;
  readonly author?: string;
  readonly where?: string;
  readonly and?: string;
  readonly tail: string;
};

// A window of each of a set of hashtags' statuses, for a feed of whole hashtags (home's followed hashtags), as
// StatusReads writes it:
//   SELECT w.id AS id FROM (<tags>) g CROSS JOIN main.statuses w ON w.id IN (SELECT s.id FROM <from> main.statuses s
//     <join> WHERE (<tag> = g.name AND <where>) AND (<rule over s>) AND (<and>) <tail>)
// <tags> selects each hashtag once, as name; <tag> is the column of the hashtag in the index the window reads (in
// <from>), and <tail> orders each hashtag's statuses by id and cuts them to a page, as an AuthorWindows' does: a
// hashtag costs a window however many statuses carry it. A hashtag has no rule of its own, so every status of the
// window is judged by the rule.
export type TagWindows = {
  readonly tags: string;
  readonly tag: string;
  readonly from: string;
  readonly join: string;
  readonly where?: string;
  readonly and?: string;
  readonly tail: string;
};

// Further columns, name: expression. A name is a plain identifier, never the id column the reader selects.
type Columns<Extra, Id extends string> = { readonly [K in keyof Extra]: string } & { readonly [K in Id]?: never };

type Row = Record<string, SqlStorageValue>;

// The status queries of one viewer. The viewer and the time are the numbered parameters `at.viewer` and `at.now` of
// each query (a viewer with no time, the web pages', has only `viewer` and no rule that takes a time); a query runs only
// with them bound to the viewer's account id and time. Every query is written here: the caller gives the parts of a
// StatusSelect, and the ids it returns are ones the rule passed for the viewer. Nothing is parsed.
// With `at.only` (a parameter holding a status id x), each status read is narrowed to x, for the streaming API's
// positioned reads (R33, streaming.ts): every SELECT and window gets `s.id = x`, an AuthorWindows' authors are cut to
// x's author and a TagWindows' hashtags to x's own, each a seek. The caller sets its cursor at x, so with the cursor's
// windows and bounds the narrowed read returns x exactly when the read positioned at x does; the conjuncts remove
// only rows other than x.
export type StatusReads = {
  // One SELECT, after an optional WITH clause its parts may read, with further columns (name: expression) after the id.
  // oxlint-disable-next-line typescript/no-generated-empty-object-type -- no further columns unless named
  select<Extra extends Row = Record<never, never>>(
    db: Db,
    rule: StatusRule,
    query: StatusSelect & { readonly with?: string; readonly columns?: Columns<Extra, "id"> },
    ...params: SqlStorageValue[]
  ): (Extra & { id: VisibleStatusId })[];
  // SELECTs combined, each a StatusSelect, AuthorWindows or TagWindows under the same rule, selecting the id only:
  //   SELECT id FROM (SELECT * FROM (<branch>) UNION [ALL] SELECT * FROM (<branch>) ...) <tail>
  union(
    db: Db,
    rule: StatusRule,
    query: {
      readonly all: boolean;
      readonly branches: readonly (StatusSelect | AuthorWindows | TagWindows)[];
      readonly tail: string;
    },
    ...params: SqlStorageValue[]
  ): { id: VisibleStatusId }[];
  // Whether the rule passes the author `author` (an expression over the parameters) as a whole, and `and`: when it
  // does not, no status of theirs passes, so a read of their statuses alone can return nothing without reading them.
  //   SELECT 1 WHERE (<rule over the author>) AND (<and>)
  authorShown(
    db: Db,
    rule: StatusRule,
    query: { readonly author: string; readonly and?: string },
    ...params: SqlStorageValue[]
  ): boolean;
  // The same part of the rule over the author `author` as SQL, over the viewer's and the time's parameters, for a
  // candidate window's author-level exclusion (windows.ts): an author it rejects contributes no candidates. A window
  // selects candidates only; the rule is applied to them by a query of this reader.
  authorRule(rule: StatusRule, author: string): string;
  // The viewer's notifications the notification rule (R15) shows them, which shows a status only if they may view it,
  // and a report's only while `admin` (the OAuth admin's account id, adminAccountIdOnce) is the viewer (R37),
  // and, unless `includeFiltered`, only those the recipient's policy did not filter (Notification.browserable), above
  // the viewer's last clear and their group's last dismissal (keptFloorSql). `range` is the page's cursor, `max` and
  // `min` exclusive (expressions over the parameters, as edgeRangeSql's), and `group` the one group read (an
  // expression over the parameters); the read starts above the clear (and the group's dismissal) whatever the cursor:
  //   SELECT n.status_id AS status_id, <columns> FROM main.notifications n
  //   WHERE (n.account_id = <viewer>) AND (<range above the floor>) AND (<the group, or above its dismissal>)
  //     AND (<where>) [AND (n.filtered = 0)] AND (<rule>) <tail>
  // With `within` (a parameter holding a window's candidates, windows.ts), the read is of those candidates alone, each
  // by its key, and the range is theirs.
  notifications<Extra extends Row>(
    db: Db,
    query: NotificationQuery & {
      readonly columns: Columns<Extra, "status_id">;
      readonly admin: string | null;
      readonly within?: string;
    },
    ...params: SqlStorageValue[]
  ): (Extra & { status_id: VisibleStatusId | null })[];
  // The candidates of a window of that read (windows.ts): the same rows but for the rule and, reading every group,
  // each row's group dismissal, which the read of the candidates applies. Ids as TEXT, in the order of `tail`.
  notificationWindow(db: Db, query: NotificationQuery, ...params: SqlStorageValue[]): { id: string }[];
};

export type NotificationQuery = {
  readonly where: string;
  readonly tail?: string;
  readonly includeFiltered: boolean;
  readonly range?: { readonly max: string; readonly min: string };
  readonly group?: string;
};

export function statusReads(
  viewer: ViewerContext | null,
  at: { readonly viewer: string; readonly now?: string; readonly only?: string },
): StatusReads {
  const now = () => {
    if (viewer === null || at.now === undefined) {
      throw new Error("this rule needs the time of the read");
    }
    return at.now;
  };
  const ruleSql = (rule: StatusRule) => {
    switch (rule) {
      case "visible":
        return visibleSql("s", at.viewer);
      case "listable":
        return listableSql("s", at.viewer, now());
      case "homeFilter":
        return homeFilterSql("s", at.viewer, now());
    }
  };
  const where = (...terms: (string | undefined)[]) =>
    terms.flatMap((term) => (term === undefined || term.trim() === "" ? [] : [`(${term})`])).join(" AND ");
  const columns = (extra: Record<string, string> | undefined, id: string) =>
    Object.entries(extra ?? {})
      .map(([name, expression]) => {
        if (!/^[a-z_][a-z0-9_]*$/.test(name) || name === id) {
          throw new Error(`a status query cannot select a column named ${name}`);
        }
        return `, ${expression} AS ${name}`;
      })
      .join("");
  const only = at.only === undefined ? undefined : `s.id = ${at.only}`;
  const selectSql = (rule: string, q: StatusSelect, extra?: Record<string, string>) =>
    `SELECT s.id AS id${columns(extra, "id")} FROM ${q.from ?? ""} main.statuses s ${q.join ?? ""}
		WHERE ${where(only, q.where, rule, q.and)} ${q.tail ?? ""}`;
  // The part of the rule over the author `x` alone, which every status of theirs passes if any does: the author is
  // available and, unless the viewer, does not block them; for the list and home rules, the viewer does not filter
  // them either.
  const authorRuleSql = (rule: StatusRule, x: string) => {
    const visible = `${availableSql(x)} AND (${x} IS ${at.viewer} OR NOT ${blocksSql(x, at.viewer)})`;
    return rule === "visible" ? visible : `${visible} AND NOT ${filteredForSql(x, at.viewer, now())}`;
  };
  const branchSql = (rule: StatusRule, q: StatusSelect | AuthorWindows | TagWindows) => {
    if ("tags" in q) {
      const window = selectSql(ruleSql(rule), {
        from: q.from,
        join: q.join,
        where: `${q.tag} = g.name${q.where === undefined ? "" : ` AND ${q.where}`}`,
        and: q.and,
        tail: q.tail,
      });
      const tags =
        at.only === undefined
          ? q.tags
          : `SELECT * FROM (${q.tags}) WHERE name IN (SELECT ot.name FROM main.status_tags ot WHERE ot.status_id = ${at.only})`;
      return `SELECT w.id AS id FROM (${tags}) g CROSS JOIN main.statuses w ON w.id IN (${window})`;
    }
    if (!("authors" in q)) {
      return selectSql(ruleSql(rule), q);
    }
    const window = selectSql(ruleSql(rule), {
      from: q.from,
      join: q.join,
      where: `${q.author ?? "s.account_id"} = a.account_id${q.where === undefined ? "" : ` AND ${q.where}`}`,
      and: q.and,
      tail: q.tail,
    });
    const author =
      at.only === undefined
        ? undefined
        : `wa.account_id = (SELECT oa.account_id FROM main.statuses oa WHERE oa.id = ${at.only})`;
    const authors = `SELECT wa.account_id FROM (${q.authors}) wa WHERE ${where(author, authorRuleSql(rule, "wa.account_id"))}`;
    return `SELECT w.id AS id FROM (${authors}) a CROSS JOIN main.statuses w ON w.id IN (${window})`;
  };
  // A notification read's group term: the one group, or, reading every group, each row above its group's dismissal,
  // checked by its key.
  const notificationGroupSql = (query: NotificationQuery) =>
    query.group === undefined ? `n.id > ${dismissedSql(at.viewer, "n.group_key")}` : `n.group_key = ${query.group}`;
  // A notification read's range above the floor, its group term (with `groups`: a window's candidates leave the
  // per-row dismissal to the read of them) and the filtered term.
  const notificationScope = (query: NotificationQuery, groups: boolean) => {
    // A term of its own, so the plan reads the partial index of unfiltered notifications (notifications_unfiltered).
    const unfiltered = query.includeFiltered ? undefined : UNFILTERED_SQL;
    // One lower bound on the id, the cursor's or the floor, whichever is higher, so the index walk starts above
    // what a clear or the group's dismissal hides, and one upper bound, the cursor's, only with a range: a second
    // bound on either side may be the one the plan walks by.
    const floor = keptFloorSql(at.viewer, query.group ?? null);
    const range = `n.id > max(coalesce(CAST(${query.range?.min ?? "NULL"} AS INTEGER), 0), ${floor})
			${query.range === undefined ? "" : `AND n.id < coalesce(CAST(${query.range.max} AS INTEGER), 1e19)`}`;
    const group = groups || query.group !== undefined ? notificationGroupSql(query) : undefined;
    return [range, group, unfiltered];
  };
  const run = <T extends Row>(db: Db, query: string, params: SqlStorageValue[]): T[] => {
    const bound = (placeholder: string) => {
      const index = /^\?([1-9]\d*)$/.exec(placeholder)?.[1];
      return index === undefined ? undefined : params[Number(index) - 1];
    };
    if (bound(at.viewer) !== (viewer?.accountId ?? null) || (at.now !== undefined && bound(at.now) !== viewer?.now)) {
      throw new Error("a status query must bind the viewer's account id and time");
    }
    return db.all<T>(query, ...params);
  };
  return {
    // oxlint-disable-next-line typescript/no-generated-empty-object-type -- no further columns unless named
    select<Extra extends Row = Record<never, never>>(
      db: Db,
      rule: StatusRule,
      query: StatusSelect & { readonly with?: string; readonly columns?: Columns<Extra, "id"> },
      ...params: SqlStorageValue[]
    ) {
      const sql = `${query.with ?? ""} ${selectSql(ruleSql(rule), query, query.columns)}`;
      return run<Extra & { id: VisibleStatusId }>(db, sql, params);
    },
    union(db, rule, query, ...params) {
      const branches = query.branches.map((branch) => `SELECT * FROM (${branchSql(rule, branch)})`);
      return run<{ id: VisibleStatusId }>(
        db,
        `SELECT id FROM (${branches.join(query.all ? " UNION ALL " : " UNION ")}) ${query.tail}`,
        params,
      );
    },
    authorRule(rule, author) {
      return authorRuleSql(rule, author);
    },
    authorShown(db, rule, query, ...params) {
      return (
        run<{ shown: number }>(
          db,
          `SELECT 1 AS shown WHERE ${where(authorRuleSql(rule, query.author), query.and)}`,
          params,
        ).length > 0
      );
    },
    notifications<Extra extends Row>(
      db: Db,
      query: NotificationQuery & {
        readonly columns: Columns<Extra, "status_id">;
        readonly admin: string | null;
        readonly within?: string;
      },
      ...params: SqlStorageValue[]
    ) {
      const admin =
        viewer !== null && viewer.accountId !== null && query.admin === viewer.accountId ? at.viewer : "NULL";
      const rule = shownNotificationSql("n", at.viewer, now(), admin);
      const from =
        query.within === undefined
          ? "main.notifications n"
          : `json_each(${query.within}) c CROSS JOIN main.notifications n
						ON n.id = CAST(json_extract(c.value, '$.id') AS INTEGER)`;
      const scope = query.within === undefined ? notificationScope(query, true) : [notificationGroupSql(query)];
      return run<Extra & { status_id: VisibleStatusId | null }>(
        db,
        `SELECT n.status_id AS status_id${columns(query.columns, "status_id")} FROM ${from}
				WHERE ${where(`n.account_id = ${at.viewer}`, ...scope, query.where, rule)} ${query.tail ?? ""}`,
        params,
      );
    },
    notificationWindow(db, query, ...params) {
      return db.all<{ id: string }>(
        `SELECT CAST(n.id AS TEXT) AS id FROM main.notifications n
				WHERE ${where(`n.account_id = ${at.viewer}`, ...notificationScope(query, false), query.where)} ${query.tail ?? ""}`,
        ...params,
      );
    },
  };
}

// How many of a status's boosts R32's capture reads to find each viewer's (deleteAudience); a status with more is
// read from each viewer's follows instead.
export const CAPTURE_BOOST_SCAN = 2000;

// R32 (stream delete; streaming.ts streamDelete captures it): of `viewers`, those who may view the status `statusId`
// by itself (R3: viewableSql on the status, so a boost whose booster is being purged is not viewable), each with the
// boosts of it they may view by themselves that they or an account they follow (accepted) made, oldest first, at most
// `boosts`: the boosts their home could have shown (never a withdrawn one). Each viewer's are found from the smaller
// side: the status's boosts (statuses_reblog, withdrawn ones included), read once up to `scan` with one more to tell an
// overflow, each booster checked against the viewer's follows by key; or, past `scan`, the viewer's own boost and
// follows (follows_accepted), one unique seek of statuses_account_reblogs_kept each. A status without boosts reads one
// index probe for all its viewers.
export function deleteAudience(
  db: Db,
  statusId: string,
  viewers: readonly string[],
  boosts: number,
  scan = CAPTURE_BOOST_SCAN,
): { accountId: string; boosts: string[] }[] {
  const found = db.all<{ id: string }>(
    "SELECT id FROM main.statuses INDEXED BY statuses_reblog WHERE reblog_of_id = ? AND reblog_of_id IS NOT NULL LIMIT ?",
    statusId,
    scan + 1,
  ).length;
  const candidates =
    found <= scan
      ? `SELECT r.id FROM main.statuses r INDEXED BY statuses_reblog
				WHERE r.reblog_of_id = ?2 AND r.reblog_of_id IS NOT NULL AND r.withdrawn = 0 AND (r.account_id = ?1
				OR EXISTS (SELECT 1 FROM main.follows f
					WHERE f.account_id = ?1 AND f.target_account_id = r.account_id AND f.state = 'accepted'))`
      : `SELECT r.id FROM main.statuses r INDEXED BY statuses_account_reblogs_kept
				WHERE r.account_id = ?1 AND r.reblog_of_id = ?2 AND r.reblog_of_id IS NOT NULL AND r.withdrawn = 0
				UNION SELECT r.id FROM main.follows f CROSS JOIN main.statuses r INDEXED BY statuses_account_reblogs_kept
					ON r.account_id = f.target_account_id AND r.reblog_of_id = ?2 AND r.reblog_of_id IS NOT NULL
						AND r.withdrawn = 0
				WHERE f.account_id = ?1 AND f.state = 'accepted'`;
  return viewers.flatMap((viewerId) => {
    if (!canView(db, viewerId, statusId)) {
      return [];
    }
    const ids =
      found === 0
        ? []
        : db
            .all<{ id: string }>(
              `SELECT b.id FROM (${candidates}) b
							WHERE EXISTS (SELECT 1 FROM main.statuses s INDEXED BY ${STATUSES_ID_INDEX} WHERE s.id = b.id AND ${viewableSql("s", "?1")})
							ORDER BY b.id LIMIT ?3`,
              viewerId,
              statusId,
              boosts,
            )
            .map((row) => row.id);
    return [{ accountId: viewerId, boosts: ids }];
  });
}

// The statuses among `statusIds` that `viewerId` (null: anonymous) may see by themselves, as viewableStatusId judges
// each, in one read by key: at most the ids given, each once.
export function viewableStatusIds(db: Db, viewerId: string | null, statusIds: readonly string[]): VisibleStatusId[] {
  if (statusIds.length === 0) {
    return [];
  }
  return db
    .all<{ id: string }>(
      `SELECT s.id FROM json_each(?2) c CROSS JOIN main.statuses s INDEXED BY ${STATUSES_ID_INDEX} ON s.id = c.value
			WHERE ${viewableSql("s", "?1")}`,
      viewerId,
      JSON.stringify([...new Set(statusIds)]),
    )
    .map((row) => row.id as VisibleStatusId);
}

// The status `statusId`, if `viewerId` (null: anonymous) may see it by itself (canView).
export function viewableStatusId(db: Db, viewerId: string | null, statusId: string): VisibleStatusId | null {
  return canView(db, viewerId, statusId) ? (statusId as VisibleStatusId) : null;
}

// The status `statusId`, if it is `authorId`'s own and not withdrawn (R2: its author no longer sees it either).
export function ownStatusId(db: Db, authorId: string, statusId: string): OwnStatusId | null {
  return db.first(
    "SELECT 1 AS own FROM main.statuses WHERE id = ? AND account_id = ? AND withdrawn = 0",
    statusId,
    authorId,
  ) === undefined
    ? null
    : (statusId as OwnStatusId);
}

// ---- Quotes (R35, VIS-27; Mastodon 4.5's REST::BaseQuoteSerializer and StatusFilter#filter_state_for_quote).

// What a viewer is shown of a quote: Mastodon's stored states (pending, accepted, rejected, revoked, deleted), and,
// for an accepted quote, the state the quoted status has for the viewer.
export type ApiQuoteState = QuoteState | "unauthorized" | "blocked_domain" | "blocked_account" | "muted_account";

export type QuoteRead = { status_id: string; state: ApiQuoteState; quoted_status_id: VisibleStatusId | null };

// R35: the quotes of statuses, read for one viewer. The presenter reads quotes only through this
// (test-node/policy-boundary.test.ts).
export type QuoteReads = {
  // One key lookup per quoting status, in status id order. States, their precedence and Mastodon's
  // Quote#acceptable?: docs/visibility.md (R35). `source` lists the statuses deleted in this response: their quote
  // shows its quoted status in any stored state when R2 permits it, for redrafting.
  of(db: Db, statusIds: readonly string[], source?: readonly string[]): QuoteRead[];
};

// A quote read: the quoting status's id, the state (at most 15 bytes, 'blocked_account') and the quoted status's id.
export const QUOTE_READ_COLUMNS = fixedColumns(
  {
    status_id: "r.status_id",
    state: "r.state",
    quoted_status_id: `CASE WHEN r.state IN ('accepted', 'blocked_domain', 'blocked_account', 'muted_account')
			OR (r.stored <> 'accepted' AND r.visible AND r.status_id IN (SELECT value FROM json_each(?4)))
		THEN r.quoted END`,
  },
  { status_id: 18, state: 15, quoted_status_id: 18 },
);

// The status a stored quote by `status` names, whatever its state, or NULL: what the presenter may embed, for the
// bound of the rows it reads (statusRowBoundSql in status-rows.ts), never shown by itself.
export function quotedStatusIdSql(status: string): string {
  return `(SELECT q.quoted_status_id FROM main.quotes q WHERE q.status_id = ${status})`;
}

export function quoteReads(viewer: ViewerContext): QuoteReads {
  return {
    of(db, statusIds, source = []) {
      if (statusIds.length === 0) {
        return [];
      }
      // visible is R2 for the quoted status, read once; the state uses it where StatusFilter checks show?. A withdrawn
      // quoted status is gone at once, as a discarded one is to Mastodon's serializer (base_quote_serializer.rb:10):
      // deleted, with no id, for its author too.
      return db.all<QuoteRead>(
        `SELECT ${selectSql(QUOTE_READ_COLUMNS.columns)}
				FROM (SELECT v.status_id, v.stored, v.quoted, v.visible,
						CASE WHEN v.stored <> 'accepted' THEN v.stored
							WHEN v.quoted IS NULL THEN 'deleted'
							WHEN v.author IS ?2 THEN 'accepted'
							WHEN NOT v.visible THEN 'unauthorized'
							WHEN ?2 IS NOT NULL AND ${domainBlocksSql("?2", "v.author")} THEN 'blocked_domain'
							WHEN ?2 IS NOT NULL AND ${blocksSql("?2", "v.author")} THEN 'blocked_account'
							WHEN ?2 IS NOT NULL AND ${mutesSql("?2", "v.author", "?3")} THEN 'muted_account'
							ELSE 'accepted' END AS state
					FROM (SELECT q.status_id, q.state AS stored, t.id AS quoted, t.account_id AS author,
							CASE WHEN t.id IS NULL THEN 0 ELSE ${visibleSql("t", "?2")} END AS visible
						FROM main.quotes q LEFT JOIN main.statuses t INDEXED BY ${STATUSES_ID_INDEX}
							ON t.id = q.quoted_status_id AND t.withdrawn = 0
						WHERE q.status_id IN (SELECT value FROM json_each(?1)) AND (q.legacy = 0 OR q.state = 'accepted')) v) r
				ORDER BY r.status_id`,
        JSON.stringify(statusIds),
        viewer.accountId,
        viewer.now,
        JSON.stringify(source),
      );
    },
  };
}

// ---- Quote policies (R36, the policy part; Mastodon 4.5's Status::InteractionPolicyConcern).
//
// statuses.quote_policy holds Mastodon's bit flags (migration 0037_quote_policy): automatic approval in the high 16
// bits, manual approval in the low ones, each of these flags. Kopje writes automatic policies only, for local statuses.

export const QUOTE_POLICY_FLAGS = { unsupported_policy: 1, public: 2, followers: 4, following: 8 } as const;

export type QuotePolicyFlag = keyof typeof QUOTE_POLICY_FLAGS;

// The flags in Mastodon's order (QUOTE_APPROVAL_POLICY_FLAGS), which quote_approval lists them in.
const QUOTE_POLICY_FLAG_ORDER = Object.keys(QUOTE_POLICY_FLAGS) as QuotePolicyFlag[];

// What a local author chooses (quote_approval_policy, source[quote_policy], local_accounts.default_quote_policy).
export type QuotePolicyName = "public" | "followers" | "nobody";

export const QUOTE_POLICY_NAMES: readonly QuotePolicyName[] = ["public", "followers", "nobody"];

// Api::InteractionPoliciesConcern#quote_approval_policy and Status#downgrade_quote_policy: the stored policy of a local
// status of `visibility` whose author chose `name`. A status that is not public or unlisted gets 0, nobody, whatever
// was chosen.
export function storedQuotePolicy(name: QuotePolicyName, visibility: Visibility): number {
  if (!isDistributable(visibility)) {
    return 0;
  }
  switch (name) {
    case "public":
      return QUOTE_POLICY_FLAGS.public << 16;
    case "followers":
      return QUOTE_POLICY_FLAGS.followers << 16;
    case "nobody":
      return 0;
  }
}

// Status#quote_policy_as_keys: the flags of a stored policy's automatic or manual half, in Mastodon's order.
export function quotePolicyFlags(policy: number, kind: "automatic" | "manual"): QuotePolicyFlag[] {
  const half = kind === "automatic" ? policy >> 16 : policy & 0xffff;
  return QUOTE_POLICY_FLAG_ORDER.filter((flag) => (half & QUOTE_POLICY_FLAGS[flag]) !== 0);
}

// R36, the policy part (Status#quote_policy_for_account, by the policy alone): what the policy of the status `t`
// answers `quoter` (NULL: anonymous, denied). In order: `automatic` when the automatic half allows public, or followers
// and the quoter follows t's author (an accepted follow), or following and t's author follows the quoter; `manual`
// when the manual half allows the same; `unknown` when either half sets unsupported_policy; `denied` otherwise.
// mayQuoteSql checks the rest of R36: t's author, t's visibility, a boost and blocks.
export function quotePolicySql(t: string, quoter: string): string {
  const { unsupported_policy, public: everyone, followers, following } = QUOTE_POLICY_FLAGS;
  const follower = `EXISTS (SELECT 1 FROM main.follows qpf
		WHERE qpf.account_id = ${quoter} AND qpf.target_account_id = ${t}.account_id AND qpf.state = 'accepted')`;
  const followed = `EXISTS (SELECT 1 FROM main.follows qpg
		WHERE qpg.account_id = ${t}.account_id AND qpg.target_account_id = ${quoter} AND qpg.state = 'accepted')`;
  const allows = (half: string) => `((${half}) & ${everyone} <> 0
		OR ((${half}) & ${followers} <> 0 AND ${follower})
		OR ((${half}) & ${following} <> 0 AND ${followed}))`;
  const automatic = `(${t}.quote_policy >> 16)`;
  const manual = `(${t}.quote_policy & 65535)`;
  return `(CASE WHEN ${quoter} IS NULL THEN 'denied'
		WHEN ${allows(automatic)} THEN 'automatic'
		WHEN ${allows(manual)} THEN 'manual'
		WHEN (${automatic} | ${manual}) & ${unsupported_policy} <> 0 THEN 'unknown'
		ELSE 'denied' END)`;
}

// R36 (StatusPolicy#quote? with Quote's validations): whether `quoter` may quote the status `t`: t is not a boost, the
// quoter may see it by itself (R3, so an author who blocks the quoter or its domain refuses), the quoter blocks neither
// t's author nor its domain (as R27 for votes), and either t is the quoter's own and neither direct nor limited, or t
// is public or unlisted and its policy does not deny the quoter (quotePolicySql: automatic, manual or unknown pass).
// An inbound QuoteRequest for a local status is decided by it alone (quotes.ts answerQuoteRequest).
export function mayQuoteSql(t: string, quoter: string): string {
  return `(${t}.reblog_of_id IS NULL AND ${viewableSql(t, quoter)} AND NOT ${blockedSql(quoter, `${t}.account_id`)}
		AND ((${t}.account_id = ${quoter} AND ${t}.visibility IN ${REACHES_FOLLOWERS_SQL})
			OR (${t}.visibility IN ${DISTRIBUTABLE_SQL} AND ${quotePolicySql(t, quoter)} <> 'denied')))`;
}

// Mastodon's quote_approval.current_user (Status#quote_policy_for_account) for one viewer, read as R36 decides it:
// `denied` whenever R36 refuses (anonymous, a boost, a status the viewer may not see by itself, blocks either way, a
// direct or limited status), `automatic` for the viewer's own, and otherwise what the policy answers them
// (quotePolicySql). Stricter than Mastodon, which reads the policy alone, so a client never offers a quote that the
// post would refuse. A stale answer costs a 404 from the post, which decides again.
export type QuoteApprovalReads = {
  // One row per status, in no order.
  of(db: Db, statusIds: readonly string[]): Map<string, "automatic" | "manual" | "unknown" | "denied">;
};

// The viewer's answer of a status's quote policy: its id and one of four words (at most 9 bytes, 'automatic').
export const QUOTE_APPROVAL_COLUMNS = fixedColumns(
  {
    id: "t.id",
    current_user: `CASE WHEN ${mayQuoteSql("t", "?2")}
			THEN CASE WHEN t.account_id = ?2 THEN 'automatic' ELSE ${quotePolicySql("t", "?2")} END
			ELSE 'denied' END`,
  },
  { id: 18, current_user: 9 },
);

export function quoteApprovalReads(viewer: ViewerContext): QuoteApprovalReads {
  return {
    of(db, statusIds) {
      if (viewer.accountId === null || statusIds.length === 0) {
        return new Map();
      }
      const rows = db.all<{ id: string; current_user: "automatic" | "manual" | "unknown" | "denied" }>(
        `SELECT ${selectSql(QUOTE_APPROVAL_COLUMNS.columns)} FROM main.statuses t INDEXED BY ${STATUSES_ID_INDEX}
				WHERE t.id IN (SELECT value FROM json_each(?1))`,
        JSON.stringify(statusIds),
        viewer.accountId,
      );
      return new Map(rows.map((row) => [row.id, row.current_user]));
    },
  };
}

// R26: a scheduled status (scheduled_statuses row `ss`) is its owner's alone. It is not a status: no other rule
// reads it, nothing lists, notifies or delivers it, and anyone else's is not found, until its publication writes an
// ordinary status, which the rules above then govern.
export function scheduledOwnSql(ss: string, viewer: string): string {
  return `${ss}.account_id = ${viewer}`;
}

// R27 (PollPolicy#vote?): whether `voter` may vote in the poll of the status `s`: may see the status by itself (R3),
// and blocks neither its author (an author who blocks the voter hides the status already) nor the author's domain, to
// which a remote poll's vote would not be delivered (R23 leaves such an account out). Votes are their voters' own:
// polls.ts alone reads poll_votes (poll-presenter.ts only presents a viewer's own, and status-rows.ts counts them for
// R), and shows a poll's counts and a viewer's own votes, never who voted.
export function mayVoteSql(s: string, voter: string): string {
  return `(${viewableSql(s, voter)} AND NOT ${blockedSql(voter, `${s}.account_id`)})`;
}

// ---- Notifications.

// Status.without_replies: not a reply, or a reply in the author's own conversation (in_reply_to_account_id carries
// the partner through self-replies, so continuing a reply to someone else is still a reply to them).
export const NOT_A_REPLY_TO_OTHERS = "(s.in_reply_to_uri IS NULL OR s.in_reply_to_account_id = s.account_id)";

// Whether `r` blocks the account `a`, or mutes it with notifications at `now`.
function silencedSql(r: string, a: string, now: string): string {
  return `(${blocksSql(r, a)} OR ${mutesSql(r, a, now, true)})`;
}

// R15: whether the recipient `r` is shown a notification of `type` from `from` about `status` at `now`. One rule
// decides whether a notification is written, listed and pushed (notifications.ts, push.ts): the sender is not the
// recipient (but for the end of the recipient's own poll and a moderation_warning, whose sender is its recipient:
// NotifyService::DropCondition#drop? exempts both from from_self?), is available (so a suspended recipient is not
// shown its moderation_warning), is not blocked (either way), muted with notifications or domain-blocked by the
// recipient, and the recipient may see the status. A moderation_warning is shown only when its sender is its recipient
// and `warning` (its account_warning_id) names a warning of that recipient (R42), by the warning's key, so a restored
// row linked to another account's warning, or to none, is in no read or count. A reblog notification names the
// original; the boost itself (the sender's one boost of it) must be visible to the recipient too, so a followers-only
// or direct boost is not revealed to an author outside its audience. A mention is left out when its status mentions or
// replies to an account the recipient silences (FeedManager#filter_from_mentions), and a post notification (`status`)
// when its status is a reply other than in the author's own conversation (a partner that is someone else or unknown, as
// FeedInsertWorker#notify?) or when home would leave it out (homeFilterSql, which also hides a sender the recipient
// mutes without notifications). A quoted_update (about the recipient's own quoting status) is shown while its quote is
// accepted and the recipient may see the quoted status by itself (R35, VIS-27: Mastodon checks neither). An
// admin.report is shown only while its recipient is `admin`, the OAuth admin's account id (R37; NULL for none), so it
// leaves every read, push and stream when the admin changes; it goes with its report (notifications.report_id, ON
// DELETE CASCADE).
export function shownSql(
  r: string,
  type: string,
  from: string,
  status: string,
  now: string,
  admin: string,
  warning: string,
): string {
  return `((${from} <> ${r} OR ${type} IN ('poll', 'moderation_warning'))
		AND (${type} <> 'moderation_warning' OR (${from} = ${r}
			AND EXISTS (SELECT 1 FROM main.account_warnings aw WHERE aw.id = ${warning} AND aw.target_account_id = ${r})))
		AND (${type} <> 'admin.report' OR ${r} IS ${admin})
		AND ${availableSql(from)}
		AND NOT ${silencedSql(r, from, now)}
		AND NOT ${blocksSql(from, r)}
		AND NOT ${domainBlocksSql(r, from)}
		AND (${status} IS NULL OR EXISTS (SELECT 1 FROM main.statuses s WHERE s.id = ${status} AND ${viewableSql("s", r)}))
		AND (${type} <> 'reblog' OR EXISTS (SELECT 1 FROM main.statuses nr
			WHERE nr.account_id = ${from} AND nr.reblog_of_id = ${status} AND ${visibleSql("nr", r)}))
		AND (${type} <> 'mention' OR NOT EXISTS (SELECT 1 FROM main.statuses mt WHERE mt.id = ${status}
			AND (EXISTS (SELECT 1 FROM main.status_mentions mm WHERE mm.status_id = mt.id AND mm.silent = 0
					AND ${silencedSql(r, "mm.account_id", now)})
				OR (mt.in_reply_to_account_id IS NOT NULL AND ${silencedSql(r, "mt.in_reply_to_account_id", now)}))))
		AND (${type} <> 'status' OR EXISTS (SELECT 1 FROM main.statuses s WHERE s.id = ${status}
			AND ${NOT_A_REPLY_TO_OTHERS} AND ${homeFilterSql("s", r, now)}))
		AND (${type} <> 'quoted_update' OR EXISTS (SELECT 1 FROM main.quotes nq JOIN main.statuses nt ON nt.id = nq.quoted_status_id
			WHERE nq.status_id = ${status} AND nq.state = 'accepted' AND ${viewableSql("nt", r)})))`;
}

// R15 for the stored notification row `n` (an alias) of recipient `r`: shownSql over its own columns, as the reads
// and the pushes of stored notifications judge them.
export function shownNotificationSql(n: string, r: string, now: string, admin: string): string {
  return shownSql(r, `${n}.type`, `${n}.from_account_id`, `${n}.status_id`, now, admin, `${n}.account_warning_id`);
}

// R31 (Account#muting_conversation?): whether `owner` mutes the conversation `thread`, an expression for a status's
// thread (statuses.thread, Mastodon's conversation_id). A mute is its owner's alone: only this module reads
// conversation_mutes, for the status's `muted` and for notify.
export function conversationMutedSql(owner: string, thread: string): string {
  return `EXISTS (SELECT 1 FROM main.conversation_mutes pcm WHERE pcm.account_id = ${owner} AND pcm.thread = ${thread})`;
}

// R15 as notify writes a notification (NotifyService#drop?): what shownSql shows, unless its status is in a
// conversation the recipient mutes (R31, NotifyService::DropCondition#conversation_muted?: a reblog notification
// names the original, whose conversation counts). Mastodon drops only the notifications it would create: one written
// before the mute stays listed and pushed, so listing and pushes apply shownSql alone.
export function notifiedSql(
  r: string,
  type: string,
  from: string,
  status: string,
  now: string,
  admin: string,
  warning: string,
): string {
  return `((${status} IS NULL OR NOT EXISTS (SELECT 1 FROM main.statuses nc WHERE nc.id = ${status}
			AND ${conversationMutedSql(r, "nc.thread")}))
		AND ${shownSql(r, type, from, status, now, admin, warning)})`;
}

// ---- Notification policies (R15 as notify writes; Mastodon 4.5's NotifyService::DropCondition and FilterCondition).

// A notification the recipient's policy filtered (notifications.filtered) is written but left out of every list, count
// and push unless the request asks for filtered ones (Notification.browserable: include_filtered, or account_id in
// v1). statusReads(...).notifications adds this term unless asked; push.ts adds it to the push target.
export const UNFILTERED_SQL = "n.filtered = 0";

// ---- Cleared notifications and dismissed groups (R15; migration 0023_notification_clears).

// The id at or below which the notifications of the recipient `r` are hidden: the highest id when they last cleared
// them (POST /api/v1/notifications/clear) and, with `group`, the highest of that group when they last dismissed it
// (POST /api/v2/notifications/:group_key/dismiss); 0 for neither. Each is a key lookup. With `r` and `group` naming no
// column of the notification read (parameters), it is a constant, so `n.id > <floor>` is a lower bound in the
// (account_id, id) and group indexes: a read starts above what is hidden and never walks it. notifications.ts deletes
// the rows hidden in batches, after.
export function keptFloorSql(r: string, group: string | null): string {
  const cleared = `coalesce((SELECT kc.max_id FROM main.notification_clears kc WHERE kc.account_id = ${r}), 0)`;
  return group === null ? cleared : `max(${cleared}, ${dismissedSql(r, group)})`;
}

// The highest id of the group `group` of the recipient `r` when they last dismissed it (0 for none), a key lookup.
function dismissedSql(r: string, group: string): string {
  return `coalesce((SELECT kd.max_id FROM main.notification_dismissals kd
		WHERE kd.account_id = ${r} AND kd.group_key = ${group}), 0)`;
}

// Whether notification `n` (a table alias) is above its recipient's clear and its group's dismissal, by its own
// columns: two key lookups, for a read of single notifications whatever their recipients (the push target, an
// accepted request's job). statusReads(...).notifications applies the same as a bound.
export function keptSql(n: string): string {
  return `(${n}.id > ${keptFloorSql(`${n}.account_id`, null)}
		AND ${n}.id > ${dismissedSql(`${n}.account_id`, `${n}.group_key`)})`;
}

// The types a policy may filter or drop (Notification::PROPERTIES, app/models/notification.rb:37-83: `filterable`):
// mention, reblog, follow, follow_request, favourite and quote. A post notification (`status`), an edit (`update`) and
// a poll's end are never filtered.
export const FILTERABLE_TYPES: readonly string[] = [
  "mention",
  "reblog",
  "follow",
  "follow_request",
  "favourite",
  "quote",
];

// A policy's choice for a condition (NotificationPolicy's enums, app/models/notification_policy.rb:34-38).
export type PolicyChoice = "accept" | "filter" | "drop";

// The policy's columns and Mastodon's defaults (the schema's, app/models/notification_policy.rb:11-15), which an
// account without a notification_policies row has.
export const POLICY_DEFAULTS = {
  for_not_following: "accept",
  for_not_followers: "accept",
  for_new_accounts: "accept",
  for_private_mentions: "filter",
  for_limited_accounts: "filter",
} as const satisfies Record<string, PolicyChoice>;

export type PolicyColumn = keyof typeof POLICY_DEFAULTS;

// BaseCondition::NEW_FOLLOWER_THRESHOLD and NEW_ACCOUNT_THRESHOLD (app/services/notify_service.rb:20-22).
const NEW_FOLLOWER_DAYS = 3;
const NEW_ACCOUNT_DAYS = 30;

// How far up a private mention's thread the reply exemption walks: the parent and this many statuses above it
// (statuses_that_mention_sender's depth_limit, app/services/notify_service.rb:90 and :102).
export const PRIVATE_MENTION_WALK = 100;

// The recipient `r`'s choice for `column`, or its default.
function policyChoiceSql(r: string, column: PolicyColumn): string {
  return `coalesce((SELECT pp.${column} FROM main.notification_policies pp WHERE pp.account_id = ${r}), '${POLICY_DEFAULTS[column]}')`;
}

// The time `days` days before `now` (an ISO time), in the form the rows' times are stored in.
function daysBeforeSql(now: string, days: number): string {
  return `strftime('%Y-%m-%dT%H:%M:%fZ', ${now}, '-${days} days')`;
}

// BaseCondition#not_following? (:47-49): the recipient does not follow the sender (an accepted follow).
function notFollowingSql(r: string, from: string): string {
  return `NOT EXISTS (SELECT 1 FROM main.follows pf WHERE pf.account_id = ${r} AND pf.target_account_id = ${from}
		AND pf.state = 'accepted')`;
}

// BaseCondition#not_follower? (:51-54): the sender does not follow the recipient, or has followed for less than
// three days. Kopje keeps a follow's time from its request, so a follow accepted later counts from the request.
function notFollowerSql(r: string, from: string, now: string): string {
  return `NOT EXISTS (SELECT 1 FROM main.follows pr WHERE pr.account_id = ${from} AND pr.target_account_id = ${r}
		AND pr.state = 'accepted' AND pr.created_at <= ${daysBeforeSql(now, NEW_FOLLOWER_DAYS)})`;
}

// BaseCondition#new_account? (:56-58): the sender's account was created less than 30 days ago (a remote account's
// time is the actor's `published`, as Mastodon's ProcessAccountService takes it, or when it was first stored).
function newAccountSql(from: string, now: string): string {
  return `EXISTS (SELECT 1 FROM main.accounts pn INDEXED BY ${ACCOUNTS_ID_INDEX} WHERE pn.id = ${from}
		AND pn.created_at > ${daysBeforeSql(now, NEW_ACCOUNT_DAYS)})`;
}

// BaseCondition#private_mention_not_in_response? (:76-109): a mention in a direct status that does not answer a
// private mention of the sender by the recipient. Mastodon's statuses_that_mention_sender walks the thread up from the
// status's parent: the parent counts when it mentions the sender (not silently), whoever wrote it, and an ancestor
// above it when the recipient wrote it and it mentions the sender; the walk stops at the first that counts, or
// PRIVATE_MENTION_WALK statuses above the parent, and the status answers the recipient when what it stopped at is the
// recipient's own direct status. A status whose parent was never stored (no in_reply_to_id) answers nothing, as in
// Mastodon.
function privateMentionNotInResponseSql(r: string, type: string, from: string, status: string): string {
  const mentionsSender = (s: string) => `EXISTS (SELECT 1 FROM main.status_mentions pm WHERE pm.status_id = ${s}.id
		AND pm.account_id = ${from} AND pm.silent = 0)`;
  return `(${type} = 'mention' AND EXISTS (SELECT 1 FROM main.statuses pd WHERE pd.id = ${status}
		AND pd.visibility = 'direct' AND NOT (pd.in_reply_to_id IS NOT NULL AND EXISTS (
			WITH RECURSIVE pw(id, parent, hit, depth) AS (
				SELECT ps.id, ps.in_reply_to_id, ${mentionsSender("ps")}, 0 FROM main.statuses ps
				WHERE ps.id = pd.in_reply_to_id
				UNION ALL
				SELECT ps.id, ps.in_reply_to_id, ps.account_id = ${r} AND ${mentionsSender("ps")}, pw.depth + 1
				FROM pw JOIN main.statuses ps ON ps.id = pw.parent
				WHERE pw.hit = 0 AND pw.depth < ${PRIVATE_MENTION_WALK})
			SELECT 1 FROM pw JOIN main.statuses pa ON pa.id = pw.id
			WHERE pw.hit AND pa.account_id = ${r} AND pa.visibility = 'direct'))))`;
}

// Whether a condition of the recipient's policy chose `choice` for the notification: Mastodon's
// blocked_by_*_policy? (:154-172) for drop and filtered_by_*_policy? (:190-208) for filter. Kopje has no silenced
// (limited) accounts, so for_limited_accounts is kept and shown but never matches.
function policyMatchesSql(
  choice: Exclude<PolicyChoice, "accept">,
  r: string,
  type: string,
  from: string,
  status: string,
  now: string,
): string {
  const is = (column: PolicyColumn) => `${policyChoiceSql(r, column)} = '${choice}'`;
  return `(${notFollowingSql(r, from)} AND (${is("for_not_following")}
			OR (${is("for_new_accounts")} AND ${newAccountSql(from, now)})
			OR (${is("for_private_mentions")} AND ${privateMentionNotInResponseSql(r, type, from, status)})))
		OR (${is("for_not_followers")} AND ${notFollowerSql(r, from, now)})`;
}

// R15, the policy part (NotifyService#drop? and #filter?, app/services/notify_service.rb:113-134 and :176-186): what
// the recipient `r`'s policy makes of a notification of `type` from `from` about `status` at `now`, as 'accept',
// 'filter' or 'drop'. A type that is not filterable, or a sender the recipient accepted a request from
// (override_for_sender?, a notification_permissions row), is accepted; otherwise a condition whose choice is drop
// drops it, else one whose choice is filter filters it. The blocks, mutes, domain blocks and conversation mutes that
// drop a notification are notifiedSql's. Kopje has no staff role that bypasses blocks (from_staff? is false), and
// no silenced accounts (from_limited? is false).
export function notificationPolicySql(r: string, type: string, from: string, status: string, now: string): string {
  return `(CASE WHEN ${type} NOT IN (${FILTERABLE_TYPES.map((t) => `'${t}'`).join(", ")})
			OR EXISTS (SELECT 1 FROM main.notification_permissions pp WHERE pp.account_id = ${r} AND pp.from_account_id = ${from})
		THEN 'accept'
		WHEN ${policyMatchesSql("drop", r, type, from, status, now)} THEN 'drop'
		WHEN ${policyMatchesSql("filter", r, type, from, status, now)} THEN 'filter'
		ELSE 'accept' END)`;
}

// ---------------------------------------------------------------------------------------------------------------
// ActivityPub addressing.
// ---------------------------------------------------------------------------------------------------------------

export const PUBLIC_COLLECTION = "https://www.w3.org/ns/activitystreams#Public";

const PUBLIC_FORMS = new Set([PUBLIC_COLLECTION, "as:Public", "Public"]);

export function isPublicCollection(uri: string): boolean {
  return PUBLIC_FORMS.has(uri);
}

export type StatusMention = { accountId: string; silent: boolean };

export type InboundAddressing = {
  to: readonly string[];
  cc: readonly string[];
  // The author's followers collection, when known.
  followersUri: string | null;
  // hrefs of the object's Mention tags.
  mentionUris: readonly string[];
  // Known accounts by actor URI (local or remote). Unknown recipients are not fetched and are dropped.
  known: ReadonlyMap<string, string>;
  // The local account whose personal inbox received the activity, if it came that way.
  deliveredTo?: string | null;
};

// How a received status is classified (Mastodon's StatusParser#visibility and ProcessStatus#process_audience):
//   - Public in to → public; Public in cc → unlisted; the author's followers in to → private; otherwise direct.
//   - Mentioned known accounts are mentions. Known accounts in to/cc that are not mentioned, and the owner of the
//     personal inbox it arrived at if not addressed, are silent mentions.
//   - A direct status with silent mentions is limited (Misskey's specified).
export function interpretAddressing(input: InboundAddressing): { visibility: Visibility; mentions: StatusMention[] } {
  let visibility: Visibility;
  if (input.to.some(isPublicCollection)) {
    visibility = "public";
  } else if (input.cc.some(isPublicCollection)) {
    visibility = "unlisted";
  } else if (input.followersUri !== null && input.to.includes(input.followersUri)) {
    visibility = "private";
  } else {
    visibility = "direct";
  }
  const mentions = new Map<string, StatusMention>();
  for (const uri of input.mentionUris) {
    const accountId = input.known.get(uri);
    if (accountId !== undefined) {
      mentions.set(accountId, { accountId, silent: false });
    }
  }
  for (const uri of [...input.to, ...input.cc]) {
    const accountId = input.known.get(uri);
    if (accountId !== undefined && !mentions.has(accountId)) {
      mentions.set(accountId, { accountId, silent: true });
    }
  }
  const deliveredTo = input.deliveredTo ?? null;
  if (deliveredTo !== null && !mentions.has(deliveredTo)) {
    mentions.set(deliveredTo, { accountId: deliveredTo, silent: true });
  }
  const list = [...mentions.values()];
  if (visibility === "direct" && list.some((mention) => mention.silent)) {
    visibility = "limited";
  }
  return { visibility, mentions: list };
}

export type Recipient = { accountId: string; uri: string; silent: boolean };

// to and cc of a local status (Mastodon's ActivityPub::TagManager#to and #cc). Silent recipients are never written
// into the addressing: they receive the activity through its audience only.
export function addressingOf(
  visibility: Visibility,
  followersUri: string,
  recipients: readonly Recipient[],
): { to: string[]; cc: string[] } {
  const mentioned = recipients.filter((r) => !r.silent).map((r) => r.uri);
  switch (visibility) {
    case "public":
      return { to: [PUBLIC_COLLECTION], cc: [followersUri, ...mentioned] };
    case "unlisted":
      return { to: [followersUri], cc: [PUBLIC_COLLECTION, ...mentioned] };
    case "private":
      return { to: [followersUri], cc: mentioned };
    case "direct":
    case "limited":
      return { to: mentioned, cc: [] };
  }
}

// Who must receive an activity about a status: the author's followers (unless only the addressed may see it) and the
// addressed accounts, silent ones included. deliveries.ts expands it into inboxes; the Store serves local accounts.
// followers: the signer's followers; accounts: the addressed accounts; pollVoters: the remote voters of the signer's
// poll on the status with this id (the Update of a poll, DistributePollUpdateWorker), whom recipientsFor reaches only
// for a public or unlisted status, or for a retraction recorded with them. status and distributable: a local status's
// Delete (statuses.ts deleteStatus), whose accounts are read when its targets are staged rather than when it is
// recorded (statusAccounts): the status's id, and whether it was public or unlisted before its hide. shares: a
// forwarded Delete of a remote original (inbox.ts recordForwards), the ids of the signer's local boosts of it, whose
// reach is read when its targets are staged (shareReaches, VIS-3).
export type Audience = {
  followers: boolean;
  accounts: string[];
  pollVoters?: string;
  status?: string;
  distributable?: true;
  shares?: string[];
};

export function audienceOf(visibility: Visibility, recipients: readonly Recipient[], extra: readonly string[] = []) {
  const accounts = new Set([...recipients.map((r) => r.accountId), ...extra]);
  return { followers: !requiresMention(visibility), accounts: [...accounts] } satisfies Audience;
}

// ---------------------------------------------------------------------------------------------------------------
// Outbound recipients (R22, R23): who an activity of a local signer goes to. deliveries.ts turns them into inboxes
// and personal copies; nothing else selects the followers or the addressed accounts of an activity.
// ---------------------------------------------------------------------------------------------------------------

// What an outbound activity does, which decides whom it may reach:
//   - content carries a status, or a boost of one, to its audience: Create, an Update of a status, Announce. It goes
//     to no unavailable account (R1) and to no one the signer blocks or whose domain it blocks (VIS-13, VIS-15): an
//     addressed account the signer blocks or domain-blocks is neither named nor sent to, and a follower on a domain it
//     blocks (one the domain block's cleanup has not removed yet) is not sent to.
//   - a retraction withdraws what was sent: a Delete, an Undo of anything, a Reject that ends a follow we had accepted
//     (withdraws). It is named to and reaches its whole audience, the blocked included, and every inbox that received
//     what it withdraws (deliveries.ts).
//   - everything else (an Update of the actor, Like, Follow, Accept, a Reject of a request, Block) goes to its whole
//     audience. Mastodon 4.5 filters none of these by block or domain block: FavouriteService, FollowService,
//     BlockService and RejectFollowService send to the account's inbox, and ActivityPub::UpdateDistributionWorker to
//     followers.inboxes (AccountReachFinder); a domain block ends the follows with the domain instead
//     (AfterBlockDomainFromAccountService), as its cleanup does here.
export type OutboundKind = "content" | "retraction" | "other";

const ACTOR_TYPES = new Set(["Person", "Service", "Group", "Application", "Organization"]);

// Whether an activity's object is an actor document (an Update of a profile).
export function isActorObject(object: unknown): boolean {
  return typeof object === "object" && object !== null && ACTOR_TYPES.has(String((object as { type?: unknown }).type));
}

export function outboundKind(activity: Record<string, unknown>, withdraws = false): OutboundKind {
  switch (activity.type) {
    case "Create":
    case "Announce":
      return "content";
    case "Update":
      return isActorObject(activity.object) ? "other" : "content";
    case "Delete":
    case "Undo":
      return "retraction";
    case "Reject":
      return withdraws ? "retraction" : "other";
    default:
      return "other";
  }
}

// Whether an activity of `kind` by `signer` leaves out the account `x`: when it is unavailable; as a follower, when
// the signer blocks its domain; as an addressed account, when the signer blocks it or its domain. Only content leaves
// anyone out, so only for content does the fragment name `signer` (a caller binds it then only).
function leavesOutSql(kind: OutboundKind, as: "follower" | "addressed", signer: string, x: string): string {
  if (kind !== "content") {
    return "0";
  }
  return `(NOT ${availableSql(x)} OR ${as === "follower" ? domainBlocksSql(signer, x) : blockedSql(signer, x)})`;
}

// Whether an activity of `kind` by `signer` names and reaches the account `accountId` among its addressed accounts
// (R22): a boost names the original's author through this, so its Announce leaves out an author the booster blocks or
// domain-blocks, and its Undo names them all the same.
export function addresses(db: Db, kind: OutboundKind, signerId: string, accountId: string): boolean {
  return (
    kind !== "content" ||
    db.first(`SELECT 1 AS x WHERE NOT ${leavesOutSql(kind, "addressed", "?1", "?2")}`, signerId, accountId) !==
      undefined
  );
}

// R23 for a forwarded report (R34): the accounts its Flag is addressed to, as Mastodon's ReportService chooses them
// (app/services/report_service.rb:53-79) for a remote reported account `target` whose report the reporter asked to
// forward. These are the reported account when its domain is among `domains` (forward_to_origin?), and the remote
// accounts on those domains that the reported statuses `statusIds` reply to (in_reply_to_account_id), less those whose
// inbox is one of the reported account's (forward_to_replied_to!: `inboxes - [inbox_url, shared_inbox_url]`). The
// statuses are read by key, so the work is bounded by the report's statuses.
export function reportForwardees(
  db: Db,
  target: string,
  statusIds: readonly string[],
  domains: readonly string[],
): string[] {
  return db
    .all<{ id: string }>(
      `SELECT t.id FROM main.accounts t
			WHERE t.id = ?1 AND t.domain IS NOT NULL AND t.domain IN (SELECT value FROM json_each(?3))
			UNION
			SELECT a.id FROM main.accounts t CROSS JOIN main.statuses s JOIN main.accounts a ON a.id = s.in_reply_to_account_id
			WHERE t.id = ?1 AND s.id IN (SELECT value FROM json_each(?2))
				AND a.domain IS NOT NULL AND a.domain IN (SELECT value FROM json_each(?3))
				AND COALESCE(NULLIF(a.shared_inbox_url, ''), a.inbox_url) IS NOT NULLIF(t.inbox_url, '')
				AND COALESCE(NULLIF(a.shared_inbox_url, ''), a.inbox_url) IS NOT NULLIF(t.shared_inbox_url, '')
			ORDER BY 1`,
      target,
      JSON.stringify(statusIds),
      JSON.stringify(domains),
    )
    .map((row) => row.id);
}

// R34 for a remote reporter (Mastodon's ReportService#reported_status_ids for a remote source account,
// app/services/report_service.rb:84-93): whether the status `s` may be attached to a report of the account `target`
// by a reporter on `domain` (accounts.domain), with `follower` (SQL) holding when the target has a follower on that
// domain (hasFollowerOn). It is an available target's original, not withdrawn (Mastodon's kept scope), public or
// unlisted; private while it has such a
// follower; or of any visibility when it mentions (silently too) an account of the domain. Mastodon's mention term is
// not correlated to the status (any mention of the domain anywhere admits every status, report_service.rb:89); here
// it is the status's own mention.
export function remoteReportableSql(s: string, target: string, domain: string, follower: string): string {
  return `(${s}.account_id = ${target} AND ${s}.reblog_of_id IS NULL AND ${s}.withdrawn = 0
		AND ${availableSql(`${s}.account_id`)} AND (
		${s}.visibility IN ${DISTRIBUTABLE_SQL}
		OR (${s}.visibility = 'private' AND ${follower})
		OR EXISTS (SELECT 1 FROM main.status_mentions rm JOIN main.accounts ra ON ra.id = rm.account_id
			WHERE rm.status_id = ${s}.id AND ra.domain = ${domain})))`;
}

// The rows each probe of hasFollowerOn reads at most (RES-7).
export const FOLLOWER_PROBE = 1000;

// Whether `target` has an accepted follower on `domain` (Mastodon's `followers.with_domain(domain).exists?`), by two
// probes of at most FOLLOWER_PROBE rows each, either of which may find one: the target's followers (follows_target),
// each account read by key; and the domain's accounts (accounts_domain_username), each follow sought by follows_pair.
// If the target's followers and the reporter domain's accounts both exceed FOLLOWER_PROBE, a follower
// outside both windows is missed and private statuses are not attached (docs/threat-model.md RES-7).
export function hasFollowerOn(db: Db, target: string, domain: string): boolean {
  return (
    db.first(
      `SELECT 1 AS x FROM (SELECT f.account_id FROM main.follows f INDEXED BY follows_target
				WHERE f.target_account_id = ?1 AND f.state = 'accepted' LIMIT ?3) w
			JOIN main.accounts a ON a.id = w.account_id WHERE a.domain = ?2
			UNION ALL
			SELECT 1 FROM (SELECT a.id FROM main.accounts a INDEXED BY accounts_domain_username WHERE a.domain = ?2 LIMIT ?3) d
			WHERE EXISTS (SELECT 1 FROM main.follows f INDEXED BY follows_pair
				WHERE f.account_id = d.id AND f.target_account_id = ?1 AND f.state = 'accepted')
			LIMIT 1`,
      target,
      domain,
      FOLLOWER_PROBE,
    ) !== undefined
  );
}

// The statuses among `ids` that a reporter on `domain` may attach to a report of `target` (remoteReportableSql), by
// id, read by key; hasFollowerOn runs only when one of them is private. The OAuth admin is shown a remote report's
// statuses only while they still pass (R37); the ids are the presenter's then (presented with the admin as the
// viewer), as accountStatusIds' are for a local reporter.
export function remoteReportStatusIds(
  db: Db,
  domain: string,
  target: string,
  ids: readonly string[],
): { id: VisibleStatusId }[] {
  if (ids.length === 0) {
    return [];
  }
  const read = (follower: boolean) =>
    db.all<{ id: VisibleStatusId; is_private: number }>(
      `SELECT s.id, s.visibility = 'private' AS is_private FROM main.statuses s
			WHERE s.id IN (SELECT value FROM json_each(?1)) AND ${remoteReportableSql("s", "?2", "?3", follower ? "1" : "0")}
			ORDER BY s.id`,
      JSON.stringify(ids),
      target,
      domain,
    );
  const admitted = read(true);
  const rows =
    admitted.some((row) => row.is_private === 1) && !hasFollowerOn(db, target, domain) ? read(false) : admitted;
  return rows.map((row) => ({ id: row.id }));
}

// A remote recipient, as a target's provenance records it (VIS-30, deliveries.ts): its account id, and the host of
// its actor id (uriHostSql), which an inbox on another host does not reveal.
export type RemoteRecipient = { id: string; host: string };

// A remote recipient reached at `inbox`: its shared inbox when it has one, else its personal inbox (null or '' when
// it has none).
export type ReachedInbox = RemoteRecipient & { inbox: string | null };

// A remote account an activity is addressed to, with its inboxes ('' read as none).
export type AddressedAccount = RemoteRecipient & {
  uri: string;
  inbox_url: string | null;
  shared_inbox_url: string | null;
};

// The most recipients a target's provenance lists (VIS-30, deliveries.ts): above it, a target is marked `many`.
export const PROVENANCE_MAX = 16;

export type OutboundRecipients = {
  // The signer's accepted remote followers the activity reaches, when its audience has the followers: per inbox, at
  // most PROVENANCE_MAX + 1 of them in id order and the first of each of at most PROVENANCE_MAX + 1 hosts (byInbox).
  followers: ReachedInbox[];
  // The remote accounts of its audience it reaches, by id.
  accounts: AddressedAccount[];
  // The remote voters of its poll it reaches, when its audience has them, as followers are.
  voters: ReachedInbox[];
};

const RECIPIENT_COLUMNS = `a.id, ${uriHostSql("a.uri")} AS host`;

// The rows (id, host, inbox) of `query` a target's provenance can use, at most 2 × (PROVENANCE_MAX + 1) per inbox:
// the first PROVENANCE_MAX + 1 by id and the first recipient of each of the first PROVENANCE_MAX + 1 hosts, which
// tell whether there are more accounts or hosts than PROVENANCE_MAX. The query is read whole; only what it returns,
// and what staging keeps, is bounded per inbox.
function byInbox(query: string): string {
  return `SELECT id, host, inbox FROM (
		SELECT id, host, inbox, row_number() OVER (PARTITION BY inbox ORDER BY id) AS pn,
			row_number() OVER (PARTITION BY inbox, host ORDER BY id) AS hn,
			dense_rank() OVER (PARTITION BY inbox ORDER BY host) AS hr
		FROM (${query}))
	WHERE pn <= ${PROVENANCE_MAX + 1} OR (hn = 1 AND hr <= ${PROVENANCE_MAX + 1})`;
}

// R23: whom an activity by `signerId` for `audience` reaches, by its kind (outboundKind). Local accounts are not
// among them: they read the Store. withdraws: a Reject that ends a follow already accepted. The followers are read
// through follows_target, each account by id (RES-7).
export function recipientsFor(
  db: Db,
  signerId: string,
  activity: Record<string, unknown>,
  audience: Audience,
  withdraws = false,
): OutboundRecipients {
  const kind = outboundKind(activity, withdraws);
  const followers = audience.followers
    ? db.all<ReachedInbox>(
        byInbox(`SELECT ${RECIPIENT_COLUMNS}, COALESCE(NULLIF(a.shared_inbox_url, ''), a.inbox_url) AS inbox
				FROM main.follows f INDEXED BY follows_target CROSS JOIN main.accounts a INDEXED BY ${ACCOUNTS_ID_INDEX} ON a.id = f.account_id
				WHERE f.target_account_id = ?1 AND f.state = 'accepted' AND a.domain IS NOT NULL
					AND NOT ${leavesOutSql(kind, "follower", "?1", "a.id")}`),
        signerId,
      )
    : [];
  const addressed =
    audience.status === undefined
      ? audience.accounts
      : [...audience.accounts, ...statusAccounts(db, audience.status, audience.distributable === true)];
  const accounts = db.all<AddressedAccount>(
    `SELECT ${RECIPIENT_COLUMNS}, a.uri, NULLIF(a.inbox_url, '') AS inbox_url,
			NULLIF(a.shared_inbox_url, '') AS shared_inbox_url
		FROM main.accounts a
		WHERE a.id IN (SELECT value FROM json_each(?1)) AND a.domain IS NOT NULL
			AND NOT ${leavesOutSql(kind, "addressed", "?2", "a.id")}
		ORDER BY a.id`,
    JSON.stringify(addressed),
    ...signerParams(kind, signerId),
  );
  // The voters of the poll's current generation (polls.ts), of a public or unlisted status of the signer's only (the
  // others reach them as followers or addressed accounts already), without those the signer may not address. A voter
  // holds a row per choice. A retraction's audience names the voters only when the status was public or unlisted
  // before its hide (statuses.ts deleteStatus), which leaves it direct, so its visibility is not read again.
  const voters =
    audience.pollVoters === undefined
      ? []
      : db.all<ReachedInbox>(
          byInbox(`SELECT DISTINCT ${RECIPIENT_COLUMNS}, COALESCE(NULLIF(a.shared_inbox_url, ''), a.inbox_url) AS inbox
					FROM main.statuses ps JOIN main.polls pp ON pp.status_id = ps.id AND pp.removed = 0
						JOIN main.poll_votes pv ON pv.poll_id = pp.status_id AND pv.generation = pp.generation
						JOIN main.accounts a ON a.id = pv.account_id
					WHERE ps.id = ?1 AND ps.account_id = ?2
						AND ${kind === "retraction" ? "1" : `ps.visibility IN ${DISTRIBUTABLE_SQL}`}
						AND a.domain IS NOT NULL AND NOT ${leavesOutSql(kind, "addressed", "?2", "a.id")}`),
          audience.pollVoters,
          signerId,
        );
  return { followers, accounts, voters };
}

// The accounts a local status's Delete reaches beyond its followers and voters, read when its targets are staged (as
// statusFacts reads them for its other activities): every account it mentions, silent ones included, and, when it was
// public or unlisted before its hide (`distributable`), the accounts it reached (reachedAccounts). Its job keeps these
// rows until the Delete is staged (inbox.ts deleteStatusBatch).
function statusAccounts(db: Db, statusId: string, distributable: boolean): string[] {
  const mentioned = db
    .all<{ id: string }>("SELECT account_id AS id FROM main.status_mentions WHERE status_id = ?", statusId)
    .map((row) => row.id);
  return distributable ? [...mentioned, ...reachedAccounts(db, statusId)] : mentioned;
}

// The uris of the boosts among `shares` that are `signerId`'s, each sought by id (RES-7): a forwarded Delete's shares
// (Audience.shares), whose receivers it reaches with the signer's followers (deliveries.ts targetsOf). A boost being
// withdrawn still counts: its job stages the forward before it deletes the boost (inbox.ts withdrawLocalBoosts). Any
// other id is ignored.
export function shareReaches(db: Db, signerId: string, shares: readonly string[]): string[] {
  return db
    .all<{ uri: string }>(
      `SELECT s.uri FROM json_each(?1) j CROSS JOIN main.statuses s INDEXED BY ${STATUSES_ID_INDEX} ON s.id = j.value
			WHERE s.account_id = ?2 AND s.reblog_of_id IS NOT NULL`,
      JSON.stringify(shares),
      signerId,
    )
    .map((row) => row.uri);
}

// The remote accounts a public or unlisted local status reached beyond its audience (StatusReachFinder): those that
// boosted it, the author of its parent and the authors of its accepted quotes (reachQuoters). Each read drives from
// the status's own key (RES-7).
export function reachedAccounts(db: Db, statusId: string): string[] {
  const reached = db
    .all<{ id: string }>(
      `SELECT r.account_id AS id FROM main.statuses r INDEXED BY statuses_reblog
				CROSS JOIN main.accounts a INDEXED BY ${ACCOUNTS_ID_INDEX} ON a.id = r.account_id
			WHERE r.reblog_of_id = ?1 AND a.domain IS NOT NULL
			UNION
			SELECT p.account_id FROM main.statuses s INDEXED BY ${STATUSES_ID_INDEX}
				CROSS JOIN main.statuses p INDEXED BY ${STATUSES_ID_INDEX} ON p.id = s.in_reply_to_id
				CROSS JOIN main.accounts a INDEXED BY ${ACCOUNTS_ID_INDEX} ON a.id = p.account_id
			WHERE s.id = ?1 AND a.domain IS NOT NULL`,
      statusId,
    )
    .map((row) => row.id);
  return [...reached, ...reachQuoters(db, statusId)];
}

// R23 for the Update of a local actor that its suspension or unsuspension sends (AccountReachFinder, run by the
// moderation jobs in suspension.ts): its sources, each an indexed range read a page at a time, with each account's
// inbox (its shared inbox when it has one) and its domain (null: local, which reads the Store and is sent nothing).
// The Update is neither content nor a retraction, so no one is left out (as Mastodon's reach finder leaves out no one).
export type ReachedAccount = { domain: string | null; inbox: string | null };

const REACH_INBOX = "COALESCE(NULLIF(a.shared_inbox_url, ''), a.inbox_url)";

// The account's accepted followers with follows.id in (after, bound], in id order (follows_target's range). The ids,
// `after` and `bound` are decimal TEXT, bound back with CAST (DATA-6: an imported id may pass 2^53).
export function reachFollowers(
  db: Db,
  accountId: string,
  after: string,
  bound: string,
  limit: number,
): (ReachedAccount & { id: string })[] {
  return db.all<ReachedAccount & { id: string }>(
    `SELECT CAST(f.id AS TEXT) AS id, a.domain, ${REACH_INBOX} AS inbox FROM main.follows f INDEXED BY follows_target
		JOIN main.accounts a ON a.id = f.account_id
		WHERE f.target_account_id = ?1 AND f.state = 'accepted' AND f.id > CAST(?2 AS INTEGER) AND f.id <= CAST(?3 AS INTEGER)
		ORDER BY f.id LIMIT ?4`,
    accountId,
    after,
    bound,
    limit,
  );
}

// The account's own follows and requests after the target `after`, in target order (follows_pair), with their state
// and time, which the caller bounds, and whether their id is at most `bound` (decimal TEXT, compared in SQL: DATA-6).
export function reachFollowing(
  db: Db,
  accountId: string,
  after: string,
  bound: string,
  limit: number,
): (ReachedAccount & { bounded: number; target: string; state: string; created_at: string })[] {
  return db.all<ReachedAccount & { bounded: number; target: string; state: string; created_at: string }>(
    `SELECT f.id <= CAST(?4 AS INTEGER) AS bounded, f.target_account_id AS target, f.state, f.created_at, a.domain,
			${REACH_INBOX} AS inbox
		FROM main.follows f INDEXED BY follows_pair JOIN main.accounts a ON a.id = f.target_account_id
		WHERE f.account_id = ?1 AND f.target_account_id > ?2 ORDER BY f.target_account_id LIMIT ?3`,
    accountId,
    after,
    limit,
    bound,
  );
}

// The accounts a status mentions after the account `after`, in key order (status_mentions).
export function reachMentioned(
  db: Db,
  statusId: string,
  after: string,
  limit: number,
): (ReachedAccount & { account_id: string })[] {
  return db.all<ReachedAccount & { account_id: string }>(
    `SELECT m.account_id, a.domain, ${REACH_INBOX} AS inbox FROM main.status_mentions m
		JOIN main.accounts a ON a.id = m.account_id
		WHERE m.status_id = ?1 AND m.account_id > ?2 ORDER BY m.account_id LIMIT ?3`,
    statusId,
    after,
    limit,
  );
}

// One account's reach, by key: a reporter of the account (reports.ts reachReporters, AccountReachFinder
// #reporters_inboxes).
export function reachAccount(db: Db, accountId: string): ReachedAccount | undefined {
  return db.first<ReachedAccount>(
    `SELECT a.domain, ${REACH_INBOX} AS inbox FROM main.accounts a WHERE a.id = ?1`,
    accountId,
  );
}

// Quoters' reach (StatusReachFinder#quotes_account_ids): the remote authors of the accepted quotes of the
// status `statusId`, so its Update or Delete reaches a quoter that neither follows its author, is mentioned, boosted it
// nor received it. Read when the activity is recorded (activities.ts statusFacts), in the transaction that serializes
// it with acceptances: a quoter is either reached, or accepted later (having fetched the status to quote it). The
// accepted quotes drive, each quoting status and its author sought by id (RES-7).
export function reachQuoters(db: Db, statusId: string): string[] {
  return db
    .all<{ id: string }>(
      `SELECT DISTINCT s.account_id AS id FROM main.quotes q INDEXED BY quotes_accepted
				CROSS JOIN main.statuses s INDEXED BY ${STATUSES_ID_INDEX} ON s.id = q.status_id
				CROSS JOIN main.accounts a INDEXED BY ${ACCOUNTS_ID_INDEX} ON a.id = s.account_id
			WHERE q.quoted_status_id = ? AND q.state = 'accepted' AND a.domain IS NOT NULL`,
      statusId,
    )
    .map((row) => row.id);
}

// R23 read a page at a time, for a retraction whose targets are staged (deliveries.ts stageRetraction): the sources
// recipientsFor and statusAccounts read whole, each walked by its own index from a cursor (`after`, the walk's key of
// the last row consumed) with its LIMIT on the walk's raw candidates; whether a row is a recipient (a remote account
// the activity does not leave out, leavesOutSql) is judged outside that LIMIT, so a row that is not still moves the
// cursor. The rows come lazily (Db.iterate), so the caller stops at its byte budget. A text value is projected
// (projectedSql): over `bound` UTF-8 bytes it is read as NULL with its length, never reaching the Worker. The lists an
// envelope holds (audience.accounts, audience.shares) are read with json_each over the stored body, as forwardFallback
// reads them, and the audience's scalars are bound as SQLite reads them there.
// `key` is the walk's key; `id` the recipient's account id, NULL when the row is no recipient.
export type StagedAccount = {
  key: string;
  id: string | null;
  uri: string | null;
  uri_bytes: number | null;
  inbox_url: string | null;
  inbox_url_bytes: number | null;
  reach: string | null;
  reach_bytes: number | null;
};

// A recipient reached at its shared inbox, else its personal inbox (REACH_INBOX), as recipientsFor reads followers and
// voters.
export type StagedInbox = { key: string; id: string | null; inbox: string | null; inbox_bytes: number | null };

// `value` when it is TEXT within `bound` UTF-8 bytes, and its length when it is TEXT: a BLOB, a number or NULL is read
// as NULL with no length, as no inbox or uri (isDeliverableInbox refuses anything but text).
export function projectedSql(value: string, as: string, bound: string): string {
  return `CASE WHEN typeof(${value}) = 'text' AND length(CAST(${value} AS BLOB)) <= ${bound} THEN ${value} END AS ${as},
		CASE WHEN typeof(${value}) = 'text' THEN length(CAST(${value} AS BLOB)) END AS ${as}_bytes`;
}

// The columns of StagedAccount for the account `a` (LEFT JOINed), `signer` bound only for content (leavesOutSql): its
// uri, its personal inbox (a personal copy's) and REACH_INBOX (a neutral copy's), as recipientsFor reads them.
function stagedAccountSql(kind: OutboundKind, signer: string, bound: string): string {
  return `CASE WHEN a.domain IS NOT NULL AND NOT ${leavesOutSql(kind, "addressed", signer, "a.id")} THEN a.id END AS id,
		${projectedSql("a.uri", "uri", bound)}, ${projectedSql("NULLIF(a.inbox_url, '')", "inbox_url", bound)},
		${projectedSql(REACH_INBOX, "reach", bound)}`;
}

// The stored body of the intent ?1, sought by its key once.
const INTENT_BODY = "(SELECT o.body FROM main.outbound_activities o WHERE o.id = CAST(?1 AS INTEGER))";

function signerParams(kind: OutboundKind, signerId: string): SqlStorageValue[] {
  return kind === "content" ? [signerId] : [];
}

// A page of the list at `path` of the intent `intentId`'s stored body (json_each, as recipientsFor's IN list and
// shareReaches' list read it), `limit` from the `offset`th: SQLite parses it, and each element comes as the value an
// account or status id compares to (TEXT affinity casts an integer), only when it is one's canonical form, 18 ASCII
// digits by their bytes (length() would stop at a NUL), or NULL: no other element can equal a key. Only JSON is read.
export function stagedList(
  db: Db,
  intentId: string,
  path: "$.audience.accounts" | "$.audience.shares",
  offset: number,
  limit: number,
): Generator<{ id: string | null }> {
  return db.iterate<{ id: string | null }>(
    `SELECT CASE WHEN j.type IN ('text', 'integer') AND length(CAST(CAST(j.value AS TEXT) AS BLOB)) = 18
				AND instr(CAST(CAST(j.value AS TEXT) AS BLOB), X'00') = 0 AND CAST(j.value AS TEXT) NOT GLOB '*[^0-9]*'
			THEN CAST(j.value AS TEXT) END AS id
		FROM json_each(${INTENT_BODY}, ?2) j LIMIT ?4 OFFSET ?3`,
    intentId,
    path,
    offset,
    limit,
  );
}

// The account `id` as recipientsFor reads an addressed one, by key; key: its id.
export function stagedAccount(
  db: Db,
  kind: OutboundKind,
  signerId: string,
  id: string,
  bound: number,
): StagedAccount | undefined {
  return db.first<StagedAccount>(
    `SELECT a.id AS key, ${stagedAccountSql(kind, "?3", "?2")}
		FROM main.accounts a INDEXED BY ${ACCOUNTS_ID_INDEX} WHERE a.id = ?1`,
    id,
    bound,
    ...signerParams(kind, signerId),
  );
}

// The accounts the status mentions, silent ones included, after the account `after`, in its primary key's order.
export function stagedMentions(
  db: Db,
  kind: OutboundKind,
  signerId: string,
  statusId: SqlStorageValue,
  after: string,
  limit: number,
  bound: number,
): Generator<StagedAccount> {
  return db.iterate<StagedAccount>(
    `SELECT w.account_id AS key, ${stagedAccountSql(kind, "?5", "?4")}
		FROM (SELECT m.account_id FROM main.status_mentions m INDEXED BY sqlite_autoindex_status_mentions_1
			WHERE m.status_id = ?1 AND m.account_id > ?2 ORDER BY m.account_id LIMIT ?3) w
		LEFT JOIN main.accounts a INDEXED BY ${ACCOUNTS_ID_INDEX} ON a.id = w.account_id ORDER BY w.account_id`,
    statusId,
    after,
    limit,
    bound,
    ...signerParams(kind, signerId),
  );
}

// The author of the status's parent (reachedAccounts' second arm), by key: one row at most.
export function stagedParent(
  db: Db,
  kind: OutboundKind,
  signerId: string,
  statusId: SqlStorageValue,
  bound: number,
): Generator<StagedAccount> {
  return db.iterate<StagedAccount>(
    `SELECT p.account_id AS key, ${stagedAccountSql(kind, "?3", "?2")}
		FROM main.statuses s INDEXED BY ${STATUSES_ID_INDEX}
			CROSS JOIN main.statuses p INDEXED BY ${STATUSES_ID_INDEX} ON p.id = s.in_reply_to_id
			LEFT JOIN main.accounts a INDEXED BY ${ACCOUNTS_ID_INDEX} ON a.id = p.account_id
		WHERE s.id = ?1`,
    statusId,
    bound,
    ...signerParams(kind, signerId),
  );
}

// The boosters of the status after the account `after`, in statuses_reblog's order (reachedAccounts' first arm): an
// imported account may hold several boosts of it, each a raw candidate; the cursor passes all of them at once.
export function stagedBoosters(
  db: Db,
  kind: OutboundKind,
  signerId: string,
  statusId: SqlStorageValue,
  after: string,
  limit: number,
  bound: number,
): Generator<StagedAccount> {
  return db.iterate<StagedAccount>(
    `SELECT w.account_id AS key, ${stagedAccountSql(kind, "?5", "?4")}
		FROM (SELECT r.account_id FROM main.statuses r INDEXED BY statuses_reblog
			WHERE r.reblog_of_id = ?1 AND r.reblog_of_id IS NOT NULL AND r.account_id > ?2 ORDER BY r.account_id LIMIT ?3) w
		LEFT JOIN main.accounts a INDEXED BY ${ACCOUNTS_ID_INDEX} ON a.id = w.account_id ORDER BY w.account_id`,
    statusId,
    after,
    limit,
    bound,
    ...signerParams(kind, signerId),
  );
}

// The authors of the status's accepted quotes (reachQuoters) after the quoting status `after`, in quotes_accepted's
// order, each quoting status and its author sought by id.
export function stagedQuoters(
  db: Db,
  kind: OutboundKind,
  signerId: string,
  statusId: SqlStorageValue,
  after: string,
  limit: number,
  bound: number,
): Generator<StagedAccount> {
  return db.iterate<StagedAccount>(
    `SELECT w.status_id AS key, ${stagedAccountSql(kind, "?5", "?4")}
		FROM (SELECT q.status_id FROM main.quotes q INDEXED BY quotes_accepted
			WHERE q.quoted_status_id = ?1 AND q.state = 'accepted' AND q.status_id > ?2 ORDER BY q.status_id LIMIT ?3) w
		LEFT JOIN main.statuses s INDEXED BY ${STATUSES_ID_INDEX} ON s.id = w.status_id
		LEFT JOIN main.accounts a INDEXED BY ${ACCOUNTS_ID_INDEX} ON a.id = s.account_id ORDER BY w.status_id`,
    statusId,
    after,
    limit,
    bound,
    ...signerParams(kind, signerId),
  );
}

// The voters recipientsFor reaches (Audience.pollVoters) after the account `after`: the votes of the poll's current
// generation, compared in SQL as recipientsFor compares them, of the signer's status with a poll not removed, in the
// key's order. A vote is a row per choice (an imported one may hold many), each a raw candidate; the cursor passes an
// account's rows at once.
export function stagedVoters(
  db: Db,
  kind: OutboundKind,
  signerId: string,
  pollId: SqlStorageValue,
  after: string,
  limit: number,
  bound: number,
): Generator<StagedInbox> {
  return db.iterate<StagedInbox>(
    `SELECT w.account_id AS key,
			CASE WHEN a.domain IS NOT NULL AND NOT ${leavesOutSql(kind, "addressed", "?2", "a.id")} THEN a.id END AS id,
			${projectedSql(REACH_INBOX, "inbox", "?5")}
		FROM (SELECT v.account_id FROM main.statuses ps INDEXED BY ${STATUSES_ID_INDEX}
			CROSS JOIN main.polls pp INDEXED BY ${POLLS_STATUS_INDEX} ON pp.status_id = ps.id
			CROSS JOIN main.poll_votes v INDEXED BY ${POLL_VOTES_KEY_INDEX}
				ON v.poll_id = pp.status_id AND v.generation = pp.generation
			WHERE ps.id = ?1 AND ps.account_id = ?2 AND pp.removed = 0
				AND ${kind === "retraction" ? "1" : `ps.visibility IN ${DISTRIBUTABLE_SQL}`}
				AND v.account_id > ?3 ORDER BY v.account_id LIMIT ?4) w
		LEFT JOIN main.accounts a INDEXED BY ${ACCOUNTS_ID_INDEX} ON a.id = w.account_id ORDER BY w.account_id`,
    pollId,
    signerId,
    after,
    limit,
    bound,
  );
}

// The signer's accepted followers with follows.id in (after, bound], in id order (reachFollowers' range); key: the
// follow's id as TEXT (DATA-6).
export function stagedFollowers(
  db: Db,
  kind: OutboundKind,
  signerId: string,
  after: string | null,
  followBound: string,
  limit: number,
  bound: number,
): Generator<StagedInbox> {
  return db.iterate<StagedInbox>(
    `SELECT CAST(w.id AS TEXT) AS key,
			CASE WHEN a.domain IS NOT NULL AND NOT ${leavesOutSql(kind, "follower", "?1", "a.id")} THEN a.id END AS id,
			${projectedSql(REACH_INBOX, "inbox", "?5")}
		FROM (SELECT f.id, f.account_id FROM main.follows f INDEXED BY follows_target
			WHERE f.target_account_id = ?1 AND f.state = 'accepted' AND f.id ${after === null ? ">=" : ">"} CAST(?2 AS INTEGER)
				AND f.id <= CAST(?3 AS INTEGER) ORDER BY f.id LIMIT ?4) w
		LEFT JOIN main.accounts a INDEXED BY ${ACCOUNTS_ID_INDEX} ON a.id = w.account_id ORDER BY w.id`,
    signerId,
    after ?? "-9223372036854775808",
    followBound,
    limit,
    bound,
  );
}

// Whether the share `id` resolves by shareReaches' rule: a boost of the signer's with this id. By key.
export function stagedBoost(db: Db, signerId: string, id: string): boolean {
  return (
    db.first(
      `SELECT 1 AS x FROM main.statuses s INDEXED BY ${STATUSES_ID_INDEX}
			WHERE s.id = ?1 AND s.account_id = ?2 AND s.reblog_of_id IS NOT NULL`,
      id,
      signerId,
    ) !== undefined
  );
}

// Whether the removal of the status `status`, by the account `author`, has begun: it is hidden (statuses.withdrawn,
// set by its hide: statuses.ts deleteStatus for a local status, inbox.ts deleteStatusBatch for a remote one; its Delete
// or Undo is recorded then, or, for an identity past its bound, skipped) or its author's purge has started
// (accounts.deleted_at). Its job then withdraws its local boosts (inbox.ts withdrawLocalBoosts) and recounts nothing
// of it. Applied to an original: a boost's withdrawn says its Undo is recorded (its unboost, statuses.ts
// removeReblog, or its original's removal), and the boost is gone for everyone until its job deletes it.
export function removalBegunSql(status: string, author: string): string {
  return `(${status}.withdrawn = 1 OR ${author}.deleted_at IS NOT NULL)`;
}
