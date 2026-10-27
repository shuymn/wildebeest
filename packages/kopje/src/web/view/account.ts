import { type EmojiAllowance, emojiField, emojiFields, type Inline } from './emoji'
import { type Link, linkTo } from './link'
import type { Account } from '../../domain/accounts'
import { httpUrl } from '../../platform/http-url'
import { type SafeHtml, sanitizedField, sanitizedWithEmoji } from '../safe-html'

// An account as the pages show it (design §11, "View-model types"). Pure: no Store, no visibility decisions.

export type { Inline } from './emoji'

// A profile field: its name as text and its value as sanitized HTML, each with the account's emoji.
export type FieldView = { name: Inline[]; value: SafeHtml }

// What a post shows of its author.
export type AuthorView = {
	name: Inline[]
	address: string
	link: Link | null
	avatar: string | null
}

export type AccountView = AuthorView & {
	header: string | null
	bio: SafeHtml | null
	fields: FieldView[]
	stats: { posts: number; following: number; followers: number }
}

// The display name, or the username when it is empty or only whitespace: the name labels links and headings, which
// must not be left without a name (§14.6).
export function displayName(account: Account): string {
	return account.display_name.trim() === '' ? account.username : account.display_name
}

// The full address of a local or remote account: @user@domain.
export function address(account: Pick<Account, 'acct'>, domain: string): string {
	return account.acct.includes('@') ? `@${account.acct}` : `@${account.acct}@${domain}`
}

// The path of a local account's followers or following page.
export function followsPath(username: string, direction: 'followers' | 'following'): string {
	return `/@${username}/${direction}`
}

// The account's name with its emoji, charged to the page's allowance (emoji.ts).
export function authorView(account: Account, domain: string, allowance: EmojiAllowance): AuthorView {
	return {
		name: emojiField(account.emojis, allowance).text(displayName(account)),
		address: address(account, domain),
		link: linkTo(account.url, domain),
		avatar: httpUrl(account.avatar)?.href ?? null,
	}
}

// The account's name, bio and fields, each a field of its own for the emoji allowance, in the order the profile card
// shows them.
export function accountView(account: Account, domain: string, allowance: EmojiAllowance): AccountView {
	const field = emojiFields(account.emojis, allowance)
	return {
		...authorView(account, domain, allowance),
		header: httpUrl(account.header)?.href ?? null,
		// HTML-1 at the sink: stored HTML is sanitized again here; profile field links keep rel="me".
		bio: account.note === '' ? null : sanitizedWithEmoji(account.note, field()),
		fields: account.fields.map((f) => ({ name: field().text(f.name), value: sanitizedField(f.value, field()) })),
		stats: { posts: account.statuses_count, following: account.following_count, followers: account.followers_count },
	}
}
