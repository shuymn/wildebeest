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
	constructor(readonly world: World) {}

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

	// R1: a suspended local account and a remote account whose deletion has started are unavailable; every other
	// account is available.
	available(x: number): boolean {
		const account = this.account(x)
		return !(account.local && account.suspended) && !(!account.local && account.deleting)
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
		return (
			this.available(owner) &&
			(owner === viewer || (!(account.local && account.hidesCollections) && !this.blocks(owner, viewer)))
		)
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

	// R15 as notify writes a notification: shown, and its status (if any) not in a conversation the recipient mutes.
	notified(r: number, type: NotificationType, from: number, s: number | null): boolean {
		return (s === null || !this.conversationMuted(r, s)) && this.shown(r, type, from, s)
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
	// the recipient (but for the end of their own poll), is available, is neither blocked (either way), muted with notifications nor domain-blocked by the
	// recipient, and the recipient may see the status. A reblog needs the sender's boost of it to be visible to the
	// recipient. A mention is left out when its status mentions (not silently) or replies to an account the recipient
	// blocks or mutes with notifications. A post notification is shown only for a status that is not a reply, or is one
	// in the author's own conversation (a known partner that is the author), and that home's filter passes.
	shown(r: number, type: NotificationType, from: number, s: number | null): boolean {
		if (
			(from === r && type !== 'poll') ||
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
			default:
				return true
		}
	}

	// R16: a push of a notification of `type` from `from` about `s` is recorded for the subscription: the notification
	// is shown (R15) to a local, available recipient, the subscription's token is still valid, its alert for the type
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
			(sub.tokenExpiresAt === null || sub.tokenExpiresAt > this.world.now) &&
			sub.alerts.includes(type) &&
			policy
		)
	}

	// The audience of an activity about the local status s (Create, Update, Delete): its followers unless only the
	// mentioned may see it, and its mentions (silent included), with, for a public or unlisted status, the remote
	// accounts that boosted it and the remote author of the status it replies to.
	statusAudience(s: number): { followers: boolean; accounts: number[] } {
		const status = this.status(s)
		const distributable = status.visibility === 'public' || status.visibility === 'unlisted'
		const reached = distributable
			? [
					...this.world.statuses.flatMap((b) => (b.reblogOf === s && !this.account(b.author).local ? [b.author] : [])),
					...(status.replyTo !== null && !this.account(this.status(status.replyTo).author).local
						? [this.status(status.replyTo).author]
						: []),
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
