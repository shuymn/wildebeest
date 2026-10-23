import { type Link, linkTo } from './link'
import type { Account } from '../../domain/accounts'
import { httpUrl } from '../../platform/http-url'
import { type SafeHtml, sanitized, sanitizedField } from '../safe-html'

// An account as the pages show it (design §11, "View-model types"). Pure: no Store, no visibility decisions.

// A run of inline text. Custom emoji join it as image references with the emoji allowance (design §2, PR 7).
export type Inline = string

export type FieldView = { name: string; value: SafeHtml }

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
export function address(account: Account, domain: string): string {
	return account.acct.includes('@') ? `@${account.acct}` : `@${account.acct}@${domain}`
}

export function authorView(account: Account, domain: string): AuthorView {
	return {
		name: [displayName(account)],
		address: address(account, domain),
		link: linkTo(account.url, domain),
		avatar: httpUrl(account.avatar)?.href ?? null,
	}
}

export function accountView(account: Account, domain: string): AccountView {
	return {
		...authorView(account, domain),
		header: httpUrl(account.header)?.href ?? null,
		// HTML-1 at the sink: stored HTML is sanitized again here; profile field links keep rel="me".
		bio: account.note === '' ? null : sanitized(account.note),
		fields: account.fields.map((field) => ({ name: field.name, value: sanitizedField(field.value) })),
		stats: { posts: account.statuses_count, following: account.following_count, followers: account.followers_count },
	}
}
