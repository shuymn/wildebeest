import { threadOf, type World, type WorldStatus } from './policy-world'
import type { NotificationType } from '../src/domain/notifications'

// The policy rules as docs/visibility.md states them, in plain TypeScript over a generated world
// (test/policy-world.ts). Written from the documented rules, not from src/domain/audience.ts, so
// test/policy-oracle.test.ts compares two independent statements of each rule. Accounts and statuses are indices; a
// viewer of null is anonymous.

export type Viewer = number | null

// What an outbound activity does to its audience (R23): content carries a status or a boost to it, a retraction
// withdraws what was sent, and anything else is neither.
export type OutboundKind = 'content' | 'retraction' | 'other'

// Content is a Create, an Update of a status (not of an actor) or an Announce; a retraction is a Delete or an Undo of
// anything (a Reject that ends an accepted follow too, which the write properties do not send).
export function outboundKindOf(activity: { type?: unknown; object?: unknown }): OutboundKind {
	const objectType =
		typeof activity.object === 'object' && activity.object !== null
			? (activity.object as { type?: unknown }).type
			: undefined
	switch (activity.type) {
		case 'Create':
		case 'Announce':
			return 'content'
		case 'Update':
			return ['Person', 'Service', 'Group', 'Application', 'Organization'].includes(String(objectType))
				? 'other'
				: 'content'
		case 'Delete':
		case 'Undo':
			return 'retraction'
		default:
			return 'other'
	}
}

// A Web Push subscription as R16 reads it: the alerts it has on, its policy, and its token's expiry.
export type ModelSubscription = {
	recipient: number
	alerts: readonly string[]
	policy: 'all' | 'followed' | 'follower' | 'none'
	tokenExpiresAt: string | null
}

// Every notification type the server writes; the type below fails to compile when it misses one.
export const NOTIFICATION_TYPES = [
	'mention',
	'status',
	'reblog',
	'favourite',
	'follow',
	'follow_request',
	'update',
	'poll',
	'quote',
	'quoted_update',
	'admin.report',
	'moderation_warning',
] as const satisfies readonly NotificationType[]
const EVERY_TYPE: Exclude<NotificationType, (typeof NOTIFICATION_TYPES)[number]> extends never ? true : false = true
void EVERY_TYPE

// A conversation (Mastodon's AccountConversation): its owner, thread and participants (account indices in id order),
// its statuses (oldest first), and whether it is unread.
export type ModelConversation = {
	owner: number
	thread: string
	participants: number[]
	statuses: number[]
	unread: boolean
}

export class PolicyModel {
	// `admin` is the OAuth admin (R37), the only recipient shown an admin.report; null for none.
	constructor(
		readonly world: World,
		readonly admin: number | null = null
	) {}

	private account(x: number) {
		const account = this.world.accounts[x]
		if (account === undefined) {
			throw new Error(`no account ${x}`)
		}
		return account
	}

	status(s: number): WorldStatus {
		const status = this.world.statuses[s]
		if (status === undefined) {
			throw new Error(`no status ${s}`)
		}
		return status
	}

	// R1: a suspended local account, a remote account the instance suspended (R38), a remote account whose deletion
	// has started and a remote account an instance domain block covers (R38) are unavailable; every other account is
	// available.
	available(x: number): boolean {
		const account = this.account(x)
		return !account.suspended && !(!account.local && (account.deleting || this.domainCovered(x)))
	}

	// R38: an instance domain block covers `domain` (lowercase, no trailing dot) when the block that rules it is a
	// suspend: the block of the domain itself or of its nearest parent, the longest match (Mastodon's
	// DomainBlock.rule_for). A child noop exempts its subdomains from a parent's suspend.
	covered(domain: string): boolean {
		const rule = this.world.instanceBlocks
			.filter((b) => domain === b.domain || domain.endsWith(`.${b.domain}`))
			.sort((a, b) => b.domain.length - a.domain.length)[0]
		return rule?.severity === 'suspend'
	}

	// R38: a remote account is covered by its stored domain or by its actor id's host, whichever an instance domain block
	// covers.
	domainCovered(x: number): boolean {
		const account = this.account(x)
		const host = new URL(account.uri).hostname.replace(/\.$/, '')
		return !account.local && (this.covered((account.domain ?? '').replace(/\.$/, '')) || this.covered(host))
	}

	// VIS-30, the public block list (docs/visibility.md, "Instance domain blocks"): a suspended local viewer's token is
	// refused whatever the settings; show_domain_blocks lists to anyone at `all`, to a signed-in viewer at `users`, and
	// to no one otherwise (an absent setting included). The list is the suspend blocks, never a noop, in domain order;
	// each carries its public comment when show_domain_blocks_rationale shows it to the viewer by the same rule.
	publicDomainBlocks(
		viewer: Viewer,
		list: string | null,
		rationale: string | null
	): 'refused' | 'hidden' | { domain: string; comment: boolean }[] {
		if (viewer !== null && this.account(viewer).suspended) {
			return 'refused'
		}
		const shown = (setting: string | null) => setting === 'all' || (setting === 'users' && viewer !== null)
		if (!shown(list)) {
			return 'hidden'
		}
		return this.world.instanceBlocks
			.filter((b) => b.severity === 'suspend')
			.map((b) => b.domain)
			.sort()
			.map((domain) => ({ domain, comment: shown(rationale) }))
	}

	// The account lives on `domain`: its stored domain or the host of its actor id, exactly. Local accounts live nowhere
	// a domain block can name.
	inDomain(x: number, domain: string): boolean {
		const account = this.account(x)
		// The host of the actor id, lowercased, without a port or a trailing dot.
		const host = new URL(account.uri).hostname.replace(/\.$/, '')
		return !account.local && (account.domain === domain || host === domain)
	}

	blocks(owner: Viewer, x: Viewer): boolean {
		return owner !== null && x !== null && this.world.blocks.some((b) => b.from === owner && b.to === x)
	}

	domainBlocks(owner: Viewer, x: number): boolean {
		return owner !== null && this.world.domainBlocks.some((d) => d.owner === owner && this.inDomain(x, d.domain))
	}

	blocked(owner: Viewer, x: number): boolean {
		return this.blocks(owner, x) || this.domainBlocks(owner, x)
	}

	// A mute applies while it has no expiry or its expiry is later than now; `notifications` asks for a mute that also
	// hides notifications.
	mutes(owner: Viewer, x: number, notifications = false): boolean {
		return this.world.mutes.some(
			(m) =>
				m.from === owner &&
				m.to === x &&
				(m.expiresAt === null || m.expiresAt > this.world.now) &&
				(!notifications || m.hideNotifications)
		)
	}

	// R7: the viewer blocks, mutes (while the mute applies) or domain-blocks x. Nobody filters themselves; an anonymous
	// viewer filters nothing.
	filteredFor(x: number, viewer: Viewer): boolean {
		return (
			viewer !== null &&
			x !== viewer &&
			(this.blocks(viewer, x) || this.mutes(viewer, x) || this.domainBlocks(viewer, x))
		)
	}

	// R12: x may be listed among others: available, not filtered, and not blocking the viewer.
	listedFor(x: number, viewer: Viewer): boolean {
		return this.available(x) && !this.filteredFor(x, viewer) && !this.blocks(x, viewer)
	}

	// R13: the owner's followers and following are shown to the viewer: the owner is available and, unless the viewer is
	// the owner, neither hides its network nor blocks the viewer.
	followListsShown(owner: number, viewer: Viewer): boolean {
		const account = this.account(owner)
		return this.available(owner) && (owner === viewer || (!account.hidesCollections && !this.blocks(owner, viewer)))
	}

	// R13: x is listed among the owner's followers or following to the viewer: an anonymous viewer and the owner see
	// every entry; anyone else does not see an account they block or mute, or one that blocks them.
	followListed(x: number, owner: number, viewer: Viewer): boolean {
		return (
			viewer === null ||
			viewer === owner ||
			!(this.blocks(viewer, x) || this.blocks(x, viewer) || this.mutes(viewer, x))
		)
	}

	// R39: the viewer's suggestions, friends of friends over the windows of the Store (docs/visibility.md,
	// "Suggestions"). A follow's id follows its place in world.follows. The sources are the viewer's `sources` newest
	// accepted follows, those whose following R13 shows the viewer (followListsShown) bringing each its
	// `edgesPerSource` newest accepted follows, source after source, newest first, of which the first `edges` count.
	// A candidate is someone else, discoverable (`discoverable`, accounts.discoverable by index), neither followed nor
	// requested by the viewer, not dismissed by them, and listed to them (R12). The candidates are ranked by how many
	// counted edges reach them, then by follower count (none is stored in a world: 0 each), then newest first; the
	// first `kept` are the answer.
	suggestions(
		viewer: number,
		discoverable: (x: number) => boolean,
		windows: { sources: number; edgesPerSource: number; edges: number; kept: number }
	): number[] {
		const newest = (from: number, count: number) =>
			this.world.follows
				.filter((f) => f.from === from && f.accepted)
				.slice(-count)
				.reverse()
				.map((f) => f.to)
		const counted = newest(viewer, windows.sources)
			.filter((source) => this.followListsShown(source, viewer))
			.flatMap((source) => newest(source, windows.edgesPerSource))
			.slice(0, windows.edges)
		const candidate = (x: number) =>
			x !== viewer &&
			discoverable(x) &&
			!this.world.follows.some((f) => f.from === viewer && f.to === x) &&
			!this.world.dismissals.some((d) => d.owner === viewer && d.target === x) &&
			this.listedFor(x, viewer)
		const frequency = new Map<number, number>()
		for (const x of counted.filter(candidate)) {
			frequency.set(x, (frequency.get(x) ?? 0) + 1)
		}
		return [...frequency]
			.sort(([a, fa], [b, fb]) => fb - fa || b - a)
			.slice(0, windows.kept)
			.map(([x]) => x)
	}

	// R28: the accounts an owner endorses are listed to anyone, the owner included, while the owner is available; no
	// block, mute or hidden network changes that.
	endorsementsShown(owner: number): boolean {
		return this.available(owner)
	}

	// R28: an endorsed account is listed while it is available, whoever endorses it and whoever asks.
	endorsementListed(x: number): boolean {
		return this.available(x)
	}

	// R14: the viewer finds x by account search or search resolution: available, and not on a domain the viewer blocks.
	findableBy(x: number, viewer: Viewer): boolean {
		return this.available(x) && !this.domainBlocks(viewer, x)
	}

	// R17: the author may mention x: available, and the author blocks neither it nor its domain.
	mentionableBy(x: number, author: number): boolean {
		return this.available(x) && !this.blocked(author, x)
	}

	// R21: the viewer may follow x: available, someone else, no block either way, no domain block by the viewer.
	followableBy(x: number, viewer: number): boolean {
		return this.available(x) && x !== viewer && !this.blocks(x, viewer) && !this.blocked(viewer, x)
	}

	private follows(from: Viewer, to: number): boolean {
		return this.world.follows.some((f) => f.from === from && f.to === to && f.accepted)
	}

	private mentioned(s: number, x: Viewer): boolean {
		return this.status(s).mentions.some((m) => m.account === x)
	}

	// R2: an available author; the author sees all of their own; an author who blocks the viewer hides everything from
	// them; public and unlisted are seen by everyone else but a remote viewer on a domain the author blocks, private by
	// accepted followers and the mentioned, direct and limited by the mentioned only (silent mentions included).
	visible(s: number, viewer: Viewer): boolean {
		const { author, visibility } = this.status(s)
		if (!this.available(author)) {
			return false
		}
		if (author === viewer) {
			return true
		}
		if (this.blocks(author, viewer)) {
			return false
		}
		switch (visibility) {
			case 'public':
			case 'unlisted':
				return viewer === null || !this.domainBlocks(author, viewer)
			case 'private':
				return this.follows(viewer, author) || this.mentioned(s, viewer)
			case 'direct':
			case 'limited':
				return this.mentioned(s, viewer)
		}
	}

	// R3: visible, and so is a reblogged original.
	viewable(s: number, viewer: Viewer): boolean {
		const { reblogOf } = this.status(s)
		return this.visible(s, viewer) && (reblogOf === null || this.visible(reblogOf, viewer))
	}

	// R8: viewable, and the viewer filters neither the author nor a reblogged original's author.
	listable(s: number, viewer: Viewer): boolean {
		const { author, reblogOf } = this.status(s)
		return (
			this.viewable(s, viewer) &&
			!this.filteredFor(author, viewer) &&
			(reblogOf === null || !this.filteredFor(this.status(reblogOf).author, viewer))
		)
	}

	// R9: what the list rule hides, and a status or boosted original that mentions (not silently) an account the viewer
	// blocks or mutes. The viewer's own statuses pass the mention part.
	homeFilter(s: number, viewer: Viewer): boolean {
		const { author, reblogOf } = this.status(s)
		if (!this.listable(s, viewer)) {
			return false
		}
		if (author === viewer) {
			return true
		}
		const mentions = [...this.status(s).mentions, ...(reblogOf === null ? [] : this.status(reblogOf).mentions)]
		return !mentions.some((m) => !m.silent && (this.blocks(viewer, m.account) || this.mutes(viewer, m.account)))
	}

	// R34, the remote reporter rule (remoteReportStatusIds): a status a reporter on `domain` may attach to a report of
	// `target` is the target's own original, of an available author, public or unlisted; private while an account
	// stored on `domain` follows the target (accepted); and of any visibility when it mentions (silently too) an account
	// stored on `domain`.
	remoteReportable(s: number, target: number, domain: string): boolean {
		const { author, visibility, reblogOf, mentions } = this.status(s)
		if (author !== target || reblogOf !== null || !this.available(author)) {
			return false
		}
		const onDomain = (x: number) => this.account(x).domain === domain
		return (
			visibility === 'public' ||
			visibility === 'unlisted' ||
			(visibility === 'private' && this.world.follows.some((f) => f.to === target && f.accepted && onDomain(f.from))) ||
			mentions.some((m) => onDomain(m.account))
		)
	}

	// R41 (Trends::Statuses#eligible?, trendableStatusSql), over a world whose statuses carry no content warning, are
	// not sensitive, are published before its time and are in a supported language (as policy-endpoints seeds them):
	// a public original that is not a reply (an unresolved one included) by an available, discoverable author, quoting
	// nothing or, through a quote that is accepted or not legacy, a present public status by an available,
	// discoverable author.
	trendable(s: number, discoverable: (x: number) => boolean): boolean {
		const status = this.status(s)
		const plain = (x: number) => this.available(x) && discoverable(x)
		if (
			status.visibility !== 'public' ||
			status.reblogOf !== null ||
			status.replyTo !== null ||
			status.replyToUnknown ||
			!plain(status.author)
		) {
			return false
		}
		const quote = this.world.quotes.find((q) => q.status === s)
		if (quote === undefined) {
			return true
		}
		if ((quote.state !== 'accepted' && quote.legacy) || quote.quoted === null) {
			return false
		}
		const quoted = this.status(quote.quoted)
		return quoted.visibility === 'public' && plain(quoted.author)
	}

	// R41's list (StatusTrend.allowed, trendingStatuses): of the stored trend rows, each author's top-scoring ones (the
	// maximum over every stored row of the author, taken before allowance), allowed (the status's review, else the
	// author's, else `byDefault`) and trendable, by score then id (newest first), the first 200; then for `viewer`,
	// those the list rule passes (R8).
	trending(
		rows: readonly { status: number; score: number }[],
		reviews: { status: ReadonlyMap<number, boolean>; account: ReadonlyMap<number, boolean>; byDefault: boolean },
		discoverable: (x: number) => boolean,
		viewer: Viewer
	): number[] {
		const top = new Map<number, number>()
		for (const row of rows) {
			const author = this.status(row.status).author
			top.set(author, Math.max(top.get(author) ?? -Infinity, row.score))
		}
		return rows
			.filter((row) => {
				const author = this.status(row.status).author
				const allowed = reviews.status.get(row.status) ?? reviews.account.get(author) ?? reviews.byDefault
				return row.score === top.get(author) && allowed && this.trendable(row.status, discoverable)
			})
			.sort((a, b) => b.score - a.score || b.status - a.status)
			.slice(0, 200)
			.map((row) => row.status)
			.filter((s) => this.listable(s, viewer))
	}

	// Whether the status is a reply, to a stored status or to one never stored.
	isReply(s: number): boolean {
		const { replyTo, replyToUnknown } = this.status(s)
		return replyTo !== null || replyToUnknown
	}

	// The account a reply answers: the parent's author, except that an author continuing their own reply keeps
	// talking to that reply's partner. Null when the status is not a reply or its partner is unknown (a reply to a
	// status never stored, or one continuing such a reply).
	partner(s: number): number | null {
		const { author, replyTo } = this.status(s)
		if (replyTo === null) {
			return null
		}
		const parent = this.status(replyTo)
		return parent.author === author && this.isReply(replyTo) ? this.partner(replyTo) : parent.author
	}

	// Whether the list `l` holds the account x (as a member of any kind: the owner, active or pending).
	listMember(l: number, x: number | null): boolean {
		return x !== null && (this.world.lists[l]?.members.includes(x) ?? false)
	}

	// Whether x is in one of the viewer's exclusive lists.
	exclusiveMember(viewer: number, x: number): boolean {
		return this.world.lists.some((list, l) => list.owner === viewer && list.exclusive && this.listMember(l, x))
	}

	// R9, the statuses home shows by a hashtag the viewer follows (FanOutOnWriteService#deliver_to_hashtag_followers!
	// when broadcastable?, then FeedManager#filter_from_tags?): public originals with the hashtag, by an available
	// author, unless the viewer blocks, mutes or domain-blocks the author, the author blocks the viewer, or a mention
	// (not silent) names an account the viewer blocks or mutes. None of the follow's options or exclusive lists apply.
	byFollowedTag(s: number, viewer: number): boolean {
		const { author, visibility, reblogOf, tagged, mentions } = this.status(s)
		return (
			this.world.tagFollowers.includes(viewer) &&
			tagged &&
			visibility === 'public' &&
			reblogOf === null &&
			this.available(author) &&
			(author === viewer ||
				(!this.blocks(viewer, author) &&
					!this.mutes(viewer, author) &&
					!this.domainBlocks(viewer, author) &&
					!this.blocks(author, viewer) &&
					!mentions.some((m) => !m.silent && (this.blocks(viewer, m.account) || this.mutes(viewer, m.account)))))
		)
	}

	// R9, home as a whole: the viewer's own statuses; public, unlisted and private statuses of accounts the viewer
	// follows (accepted); direct and limited statuses of followed accounts that mention the viewer (silently or not).
	// Of others' statuses, none whose author is in one of the viewer's exclusive lists; a boost needs the follow's
	// show_reblogs, and a reply passes only when its partner is known and is the author, the viewer or an account the
	// viewer follows. Then homeFilter. (The world's statuses have no language, so a follow's languages filter nothing.)
	// And the statuses of the viewer's followed hashtags (byFollowedTag).
	home(s: number, viewer: number): boolean {
		return this.homeByFollow(s, viewer) || this.byFollowedTag(s, viewer)
	}

	// R9 without the followed hashtags.
	homeByFollow(s: number, viewer: number): boolean {
		const { author, visibility, reblogOf } = this.status(s)
		if (author !== viewer) {
			const follow = this.world.follows.find((f) => f.from === viewer && f.to === author && f.accepted)
			if (
				follow === undefined ||
				this.exclusiveMember(viewer, author) ||
				((visibility === 'direct' || visibility === 'limited') && !this.mentioned(s, viewer))
			) {
				return false
			}
			if (reblogOf !== null && !follow.showReblogs) {
				return false
			}
			const partner = this.partner(s)
			if (
				this.isReply(s) &&
				(partner === null || (partner !== author && partner !== viewer && !this.follows(viewer, partner)))
			) {
				return false
			}
		}
		return this.homeFilter(s, viewer)
	}

	// A list's timeline: the public, unlisted and private statuses (and boosts) of its active members, the owner (when a
	// member) and the members the owner follows (accepted). Of others' statuses, a boost needs the follow's
	// show_reblogs. A reply passes when its partner is known and is the author or the owner, or by the list's
	// replies_policy: followed, any reply of the owner's own and one to an account the owner follows (accepted); list,
	// one to a member of the list (pending included); none, nothing more. Then homeFilter for the owner. Exclusive
	// changes nothing here.
	listTimeline(l: number, s: number): boolean {
		const list = this.world.lists[l]
		if (list === undefined) {
			return false
		}
		const { owner, repliesPolicy } = list
		const { author, visibility, reblogOf } = this.status(s)
		if (
			!this.listMember(l, author) ||
			(visibility !== 'public' && visibility !== 'unlisted' && visibility !== 'private')
		) {
			return false
		}
		if (author !== owner) {
			const follow = this.world.follows.find((f) => f.from === owner && f.to === author && f.accepted)
			if (follow === undefined || (reblogOf !== null && !follow.showReblogs)) {
				return false
			}
		}
		if (this.isReply(s)) {
			const partner = this.partner(s)
			const passes =
				(partner !== null && (partner === author || partner === owner)) ||
				(repliesPolicy === 'followed' && (author === owner || (partner !== null && this.follows(owner, partner)))) ||
				(repliesPolicy === 'list' && this.listMember(l, partner))
			if (!passes) {
				return false
			}
		}
		return this.homeFilter(s, owner)
	}

	// The thread of a status (Mastodon's conversation_id, which a reply takes from its parent): the uri of the status its
	// reply chain starts at, or, when that one replies to a status never stored, the uri it names.
	thread(s: number): string {
		this.status(s)
		return threadOf(this.world.statuses, s)
	}

	// R31: the recipient mutes the conversation (thread) of the status.
	conversationMuted(r: number, s: number): boolean {
		const thread = this.thread(s)
		return this.world.conversationMutes.some((m) => m.account === r && m.thread === thread)
	}

	// R35: what the viewer is shown of the quote by the status s, or null when s has no quote or has a legacy quote
	// that is not accepted. A stored state other than accepted is shown as it is, with the quoted status only when its
	// source is asked for and the viewer may see the quoted status (R2). An accepted quote is accepted for the quoted
	// author; unauthorized when the viewer may not see the quoted status; then, for a signed-in viewer, blocked_domain
	// when they block its author's domain, blocked_account when they block its author, muted_account when they mute it;
	// accepted otherwise. The quoted status goes with every state but unauthorized.
	quote(s: number, viewer: Viewer, source = false): { state: string; quoted: number | null } | null {
		this.status(s)
		const q = this.world.quotes.find((quote) => quote.status === s)
		if (q === undefined || (q.legacy && q.state !== 'accepted')) {
			return null
		}
		if (q.state !== 'accepted' || q.quoted === null) {
			return {
				state: q.state === 'accepted' ? 'deleted' : q.state,
				quoted: source && q.quoted !== null && this.visible(q.quoted, viewer) ? q.quoted : null,
			}
		}
		const author = this.status(q.quoted).author
		const state =
			author === viewer
				? 'accepted'
				: !this.visible(q.quoted, viewer)
					? 'unauthorized'
					: viewer !== null && this.domainBlocks(viewer, author)
						? 'blocked_domain'
						: viewer !== null && this.blocks(viewer, author)
							? 'blocked_account'
							: viewer !== null && this.mutes(viewer, author)
								? 'muted_account'
								: 'accepted'
		return { state, quoted: state === 'unauthorized' ? null : q.quoted }
	}

	// R36, the policy part: what the quote policy of the status s answers the quoter (anonymous: denied), by its flags
	// alone. automatic when the automatic half allows public, or followers and the quoter follows the author (accepted),
	// or following and the author follows the quoter; manual when the manual half allows the same; unknown when either
	// half sets unsupported_policy; denied otherwise.
	quotePolicy(s: number, quoter: Viewer): 'automatic' | 'manual' | 'unknown' | 'denied' {
		const { author, quotePolicy = 0 } = this.status(s)
		if (quoter === null) {
			return 'denied'
		}
		const halves = { automatic: quotePolicy >> 16, manual: quotePolicy & 0xffff }
		const allows = (half: number) =>
			(half & 2) !== 0 ||
			((half & 4) !== 0 && this.follows(quoter, author)) ||
			((half & 8) !== 0 && this.follows(author, quoter))
		if (allows(halves.automatic)) {
			return 'automatic'
		}
		if (allows(halves.manual)) {
			return 'manual'
		}
		return ((halves.automatic | halves.manual) & 1) !== 0 ? 'unknown' : 'denied'
	}

	// R15 as notify writes a notification: shown, and its status (if any) not in a conversation the recipient mutes.
	notified(r: number, type: NotificationType, from: number, s: number | null, warned: number | null = null): boolean {
		return (s === null || !this.conversationMuted(r, s)) && this.shown(r, type, from, s, warned)
	}

	// R15's policy part (NotifyService::FilterCondition) for a recipient with Mastodon's default policy and no
	// permission, as every recipient of a generated world has (the worlds hold no notification_policies or
	// notification_permissions rows; test/notification-policy.test.ts checks the other choices): a mention in a direct
	// status from an account the recipient does not follow is filtered, unless it answers a private mention of the
	// sender by the recipient. Walking up from the parent, the parent counts when it mentions the sender (not silently),
	// an ancestor above it when the recipient wrote it and it mentions the sender; the first that counts answers when
	// it is the recipient's direct status. The walk reads the parent and at most 100 statuses above it. Nothing is
	// dropped by default.
	filtered(r: number, type: NotificationType, from: number, s: number | null): boolean {
		if (type !== 'mention' || s === null || this.follows(r, from) || this.status(s).visibility !== 'direct') {
			return false
		}
		let parent = this.status(s).replyTo
		for (let depth = 0; parent !== null && depth <= 100; depth++) {
			const status = this.status(parent)
			const mentionsSender = status.mentions.some((m) => m.account === from && !m.silent)
			if (mentionsSender && (depth === 0 || status.author === r)) {
				return !(status.author === r && status.visibility === 'direct')
			}
			parent = status.replyTo
		}
		return true
	}

	// The participants of a status for the owner of a conversation (AccountConversation.participants_from_status): its
	// author and the accounts it mentions, not silently, less the owner, in id order.
	participants(s: number, owner: number): number[] {
		const { author, mentions } = this.status(s)
		const all = new Set([author, ...mentions.filter((m) => !m.silent).map((m) => m.account)])
		all.delete(owner)
		return [...all].sort((a, b) => a - b)
	}

	// The conversations of the world's direct statuses (not boosts), as Mastodon's migration of them makes them: a local
	// author's for the author, and one a local account was notified of (`notified`) for that account, each added in
	// order. A conversation ends with its newest status, and is unread when that status is someone else's.
	conversations(notified: (r: number, s: number) => boolean): ModelConversation[] {
		const found = new Map<string, ModelConversation>()
		this.world.statuses.forEach((status, s) => {
			if (status.visibility !== 'direct' || status.reblogOf !== null) {
				return
			}
			const owners = this.world.accounts.flatMap((account, x) =>
				account.local && (x === status.author || notified(x, s)) ? [x] : []
			)
			for (const owner of owners) {
				const participants = this.participants(s, owner)
				const thread = this.thread(s)
				const key = JSON.stringify([owner, thread, participants])
				const conversation = found.get(key) ?? { owner, thread, participants, statuses: [], unread: false }
				conversation.statuses.push(s)
				conversation.unread = status.author !== owner
				found.set(key, conversation)
			}
		})
		return [...found.values()]
	}

	// Blocks the account, or mutes it with notifications.
	private silences(r: number, x: number): boolean {
		return this.blocks(r, x) || this.mutes(r, x, true)
	}

	// R15: whether the recipient is shown a notification of `type` from `from` about `s` (null: none). The sender is not
	// the recipient (but for the end of their own poll and a moderation_warning, whose sender is its recipient), is
	// available, is neither blocked (either way), muted with notifications nor domain-blocked by the recipient, and the
	// recipient may see the status. A reblog needs the sender's boost of it to be visible to the
	// recipient. A mention is left out when its status mentions (not silently) or replies to an account the recipient
	// blocks or mutes with notifications. A post notification is shown only for a status that is not a reply, or is one
	// in the author's own conversation (a known partner that is the author), and that home's filter passes. A
	// quoted_update is shown while its status's quote is accepted and the recipient may see the quoted status. An
	// admin.report is shown to the OAuth admin alone (R37). A moderation_warning is shown only from the recipient itself,
	// naming a warning of the recipient (`warned`: the target of the warning it names, null for none; R42).
	shown(r: number, type: NotificationType, from: number, s: number | null, warned: number | null = null): boolean {
		if (
			(from === r && type !== 'poll' && type !== 'moderation_warning') ||
			!this.available(from) ||
			this.silences(r, from) ||
			this.blocks(from, r) ||
			this.domainBlocks(r, from)
		) {
			return false
		}
		if (s !== null && !this.viewable(s, r)) {
			return false
		}
		switch (type) {
			case 'reblog':
				return (
					s !== null &&
					this.world.statuses.some((boost, b) => boost.author === from && boost.reblogOf === s && this.visible(b, r))
				)
			case 'mention': {
				if (s === null) {
					return true
				}
				const status = this.status(s)
				const partner = this.partner(s)
				return (
					!status.mentions.some((m) => !m.silent && this.silences(r, m.account)) &&
					!(partner !== null && this.silences(r, partner))
				)
			}
			case 'status':
				return s !== null && (!this.isReply(s) || this.partner(s) === this.status(s).author) && this.homeFilter(s, r)
			// About the recipient's own quoting status: shown while its quote is accepted and the recipient may see the
			// quoted status by itself.
			case 'quoted_update': {
				const q = s === null ? undefined : this.world.quotes.find((quote) => quote.status === s)
				return q !== undefined && q.state === 'accepted' && q.quoted !== null && this.viewable(q.quoted, r)
			}
			case 'admin.report':
				return r === this.admin
			case 'moderation_warning':
				return from === r && warned === r
			default:
				return true
		}
	}

	// R16: a push of a notification of `type` from `from` about `s` is recorded for the subscription: the notification
	// is shown (R15), and not filtered, to a local, available recipient, the subscription's token is still valid, its alert for the type
	// is on, and its policy lets the sender through (followed: the recipient follows the sender; follower: the sender
	// follows the recipient; none: nobody).
	pushed(sub: ModelSubscription, type: NotificationType, from: number, s: number | null): boolean {
		const r = sub.recipient
		const policy =
			sub.policy === 'all' ||
			(sub.policy === 'followed' && this.follows(r, from)) ||
			(sub.policy === 'follower' && this.follows(from, r))
		return (
			this.account(r).local &&
			this.available(r) &&
			this.shown(r, type, from, s) &&
			!this.filtered(r, type, from, s) &&
			(sub.tokenExpiresAt === null || sub.tokenExpiresAt > this.world.now) &&
			sub.alerts.includes(type) &&
			policy
		)
	}

	// The audience of an activity about the local status s (Create, Update, Delete): its followers unless only the
	// mentioned may see it, and its mentions (silent included), with, for a public or unlisted status, the remote
	// accounts that boosted it, the remote author of the status it replies to, and the remote authors of its accepted
	// quotes, legacy or not (quoters' reach: Mastodon's StatusReachFinder#quotes_account_ids, which takes every quote
	// of a distributable status; Kopje's reachQuoters in audience.ts takes the accepted ones).
	statusAudience(s: number): { followers: boolean; accounts: number[] } {
		const status = this.status(s)
		const distributable = status.visibility === 'public' || status.visibility === 'unlisted'
		const remoteAuthor = (x: number) => (this.account(this.status(x).author).local ? [] : [this.status(x).author])
		const reached = distributable
			? [
					...this.world.statuses.flatMap((b, x) => (b.reblogOf === s ? remoteAuthor(x) : [])),
					...(status.replyTo === null ? [] : remoteAuthor(status.replyTo)),
					...this.world.quotes.flatMap((q) => (q.quoted === s && q.state === 'accepted' ? remoteAuthor(q.status) : [])),
				]
			: []
		return {
			followers: status.visibility !== 'direct' && status.visibility !== 'limited',
			accounts: [...new Set([...status.mentions.map((m) => m.account), ...reached])],
		}
	}

	// R22: whether an activity of `kind` by `signer` names (and reaches, if available) the account x it is addressed
	// to: content names no one the signer blocks or whose domain it blocks; anything else names its whole audience.
	names(kind: OutboundKind, signer: number, x: number): boolean {
		return kind !== 'content' || !this.blocked(signer, x)
	}

	// VIS-30, the send-time check (deliveries.ts sendRefused, at the claim and at confirmation): a delivery that is not
	// a retraction is sent only while its signer is available (but for the suspension's own Update of the actor, R1)
	// and, when the recipients behind it are known (`recipients`; 'many' above PROVENANCE_MAX, "not all unavailable"),
	// while one of them exists and is available. An Announce is sent only while its original exists and its author
	// (`boosted`; 'missing' when the original is not stored) is available. The host rule (`hosts`): nothing but a
	// retraction is sent to an inbox whose host an instance domain block covers, nor through a shared inbox all of whose
	// recipient hosts (`domains`, when known) are covered. The model does not know a purged account, which is missing.
	sends(
		signer: number,
		retracts: boolean,
		recipients: readonly number[] | 'many' | null,
		ownSuspension = false,
		boosted: number | 'missing' | null = null,
		hosts: { inbox: string; domains: readonly string[] | null } | null = null
	): boolean {
		if (retracts) {
			return true
		}
		if (
			(!this.available(signer) && !ownSuspension) ||
			boosted === 'missing' ||
			(boosted !== null && !this.available(boosted))
		) {
			return false
		}
		if (
			hosts !== null &&
			(this.covered(new URL(hosts.inbox).hostname.replace(/\.$/, '')) ||
				(hosts.domains !== null && hosts.domains.length > 0 && hosts.domains.every((d) => this.covered(d))))
		) {
			return false
		}
		return recipients === null || recipients === 'many' || recipients.some((x) => this.available(x))
	}

	// R23: the remote accounts an activity of `kind` by `signer` for `audience` reaches: the accepted remote followers
	// when the audience has them, less, for content, unavailable ones and those on a domain the signer blocks; and the
	// remote accounts of the audience it names (R22), less, for content, unavailable ones. A retraction also reaches
	// every inbox that received what it withdraws (the caller's).
	reaches(
		kind: OutboundKind,
		signer: number,
		audience: { followers: boolean; accounts: readonly number[] }
	): { followers: number[]; accounts: number[] } {
		const remote = (x: number) => !this.account(x).local
		return {
			followers: audience.followers
				? this.world.accounts.flatMap((_, f) =>
						remote(f) &&
						this.follows(f, signer) &&
						!(kind === 'content' && (!this.available(f) || this.domainBlocks(signer, f)))
							? [f]
							: []
					)
				: [],
			accounts: audience.accounts.filter(
				(x) => remote(x) && this.names(kind, signer, x) && (kind !== 'content' || this.available(x))
			),
		}
	}
}
