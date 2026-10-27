import { address, type AuthorView, authorView, displayName } from './account'
import { type EmojiAllowance, emojiField, type Inline } from './emoji'
import { languageOf } from './post'
import type { Account } from '../../domain/accounts'
import type { Status } from '../../domain/status-presenter'
import { httpUrl } from '../../platform/http-url'
import { statusSummary } from '../safe-html'

// What a person follows or opens from their own server: a local account or status as its page shows it.
export type RemoteTarget = {
	kind: 'account' | 'status'
	// Its ActivityPub id, the `uri` another server's /authorize_interaction takes: the actor URI or the status's URI.
	uri: string
	// What to search for on that server: the account's full address, or the status page's URL.
	search: string
	// Its page, which the handoff goes back to; the handoff is at interactPath(path).
	path: string
	// The account's name, which the follow dialog's and page's title names: as text for <title>, and with its custom
	// emoji for the heading; null for a status.
	name: { text: string; inline: Inline[] } | null
}

// `allowance`: the page's, which the name's emoji are charged to.
export function accountTarget(account: Account, domain: string, allowance: EmojiAllowance): RemoteTarget {
	return {
		kind: 'account',
		uri: account.uri,
		search: address(account, domain),
		path: `/@${account.username}`,
		name: {
			text: displayName(account),
			inline: emojiField(account.emojis, allowance).text(displayName(account)),
		},
	}
}

export function statusTarget(status: { uri: string; url: string; path: string }): RemoteTarget {
	return { kind: 'status', uri: status.uri, search: status.url, path: status.path, name: null }
}

// What the handoff page names before its link: the account's row, or the post's author's row and the
// start of its text, plain and with its emoji (the warning in its place when it has one, as the status page's
// description has it), from what the handoff's read presented to the anonymous viewer. The name's emoji are charged
// to the page's allowance before the text's. The row links nowhere: the page's one link is the handoff.
export type TargetPreview = { author: AuthorView; text: Inline[] | null; lang: string }

// `target`: the account's own target (accountTarget), whose name, already charged to the page's allowance, the row
// reuses rather than charging it again.
export function accountPreview(account: Account, domain: string, target: RemoteTarget): TargetPreview {
	return {
		author: {
			name: target.name?.inline ?? [displayName(account)],
			address: address(account, domain),
			link: null,
			avatar: httpUrl(account.avatar)?.href ?? null,
		},
		text: null,
		lang: '',
	}
}

export function statusPreview(status: Status, domain: string, allowance: EmojiAllowance): TargetPreview {
	const author = { ...authorView(status.account, domain, allowance), link: null }
	const text = statusSummary(status)
	return {
		author,
		text: text === '' ? null : emojiField(status.emojis, allowance).text(text),
		lang: languageOf(status.language),
	}
}

// The handoff page of a target's page.
export function interactPath(path: string): string {
	return `${path}/interact`
}

// The page on `host` that the handoff links to: its /authorize_interaction with the target's id, percent-encoded.
export function authorizeInteraction(host: string, uri: string): string {
	return `https://${host}/authorize_interaction?uri=${encodeURIComponent(uri)}`
}
