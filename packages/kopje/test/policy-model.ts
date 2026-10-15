import type { World, WorldStatus } from './policy-world'
import type { NotificationType } from '../src/domain/notifications'

// The policy rules as docs/visibility.md states them, in plain TypeScript over a generated world
// (test/policy-world.ts). Written from the documented rules, not from src/domain/audience.ts, so
// test/policy-oracle.test.ts compares two independent statements of each rule. Accounts and statuses are indices; a
// viewer of null is anonymous.

export type Viewer = number | null

// Every notification type the server writes; the type below fails to compile when it misses one.
export const NOTIFICATION_TYPES = [
	'mention',
	'status',
	'reblog',
	'favourite',
	'follow',
	'follow_request',
	'update',
] as const satisfies readonly NotificationType[]
const EVERY_TYPE: Exclude<NotificationType, (typeof NOTIFICATION_TYPES)[number]> extends never ? true : false = true
void EVERY_TYPE

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

	// R1: a suspended local account is unavailable; every other account is available.
	available(x: number): boolean {
		const account = this.account(x)
		return !(account.local && account.suspended)
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
	// them; public and unlisted are seen by everyone else, private by accepted followers and the mentioned, direct and
	// limited by the mentioned only (silent mentions included).
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
				return true
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

	// The account a reply answers: the parent's author, except that an author continuing their own reply keeps
	// talking to that reply's partner.
	partner(s: number): number | null {
		const { author, replyTo } = this.status(s)
		if (replyTo === null) {
			return null
		}
		const parent = this.status(replyTo)
		return parent.author === author && parent.replyTo !== null ? this.partner(replyTo) : parent.author
	}

	// Blocks the account, or mutes it with notifications.
	private silences(r: number, x: number): boolean {
		return this.blocks(r, x) || this.mutes(r, x, true)
	}

	// R15: whether the recipient is shown a notification of `type` from `from` about `s` (null: none). The sender is not
	// the recipient, is available, is neither blocked (either way), muted with notifications nor domain-blocked by the
	// recipient, and the recipient may see the status. A reblog needs the sender's boost of it to be visible to the
	// recipient. A mention is left out when its status mentions (not silently) or replies to an account the recipient
	// blocks or mutes with notifications. A post notification is shown only when home would show its status.
	shown(r: number, type: NotificationType, from: number, s: number | null): boolean {
		if (
			from === r ||
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
				return s !== null && this.homeFilter(s, r)
			default:
				return true
		}
	}
}
