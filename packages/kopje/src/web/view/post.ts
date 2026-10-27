import { address, type AuthorView, authorView } from './account'
import { type EmojiAllowance, emojiFields, type Inline } from './emoji'
import { type Link, linkTo } from './link'
import { type MediaView, mediaView } from './media'
import { pollView, type PollView } from './poll'
import type { Quote, ShallowQuote, Status } from '../../domain/status-presenter'
import type { StatusStub } from '../../domain/web-pages/budget'
import type { ParentLink } from '../../domain/web-pages/parents'
import { type SafeHtml, sanitizedWithEmoji } from '../safe-html'

// A status as the pages show it. Pure: the read decided what is visible.

export type CountKind = 'replies' | 'boosts' | 'favourites' | 'quotes'

// A count under a post; `href` makes it a link.
export type CountView = { kind: CountKind; n: number; href?: string }

// What a post shows of the post it quotes (R35 for the anonymous viewer, docs/visibility.md): the quoted post when the
// presenter embedded it (an accepted quote of a post the viewer may see by itself), else only the state, as text.
// `pending` awaits the quoted author; `revoked` is a quote the quoted author refused or withdrew; `unavailable` is
// anything else (a quoted post deleted, hidden from the viewer, or an accepted quote without its post).
export type QuoteView = { state: 'accepted'; post: PostView } | { state: 'pending' | 'revoked' | 'unavailable' }

export type PostView = {
	link: Link | null
	author: AuthorView
	createdAt: string
	editedAt: string | null
	// The status's language, when it is a language tag; unknown is '', an empty lang, so the content does not
	// take the page's UI language.
	lang: string
	cw: Inline[]
	html: SafeHtml
	media: MediaView[]
	sensitive: boolean
	counts: CountView[]
	replyTo: { link: Link; acct: string } | null
	poll: PollView | null
	quote: QuoteView | null
}

const LANGUAGE_TAG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/

// A status's language as its text's lang: the tag, or '' (unknown) when it has none or it is not a language tag.
export function languageOf(language: string | null): string {
	return language !== null && LANGUAGE_TAG.test(language) ? language : ''
}

// Where each count links on a post that has a page here: the page itself (its Replies tab) and its other tabs.
const COUNT_TABS: Record<CountKind, string> = {
	replies: '',
	boosts: '/reblogs',
	favourites: '/favourites',
	quotes: '/quotes',
}

// The post's parts in the order the page shows them, so the emoji allowance (emoji.ts) goes to them in document
// order: the author's name, the warning, the content, the poll's choices, then the quoted post. A quoted post shows no
// quote of its own (the presenter gives it only a shallow one).
export function postView(
	status: Status,
	parent: ParentLink | null,
	domain: string,
	allowance: EmojiAllowance,
	quoted = false
): PostView {
	const parentLink = parent === null ? null : linkTo(parent.url, domain)
	const link = linkTo(status.url, domain)
	// A post of this server has its page and tabs here, and each count links to its tab; another server's post has
	// none here, and its counts are text. Locality is the author's (a local account's acct has no domain, as the
	// presenter writes it), never the URL's host, which another server supplies for its own posts.
	const local = !status.account.acct.includes('@')
	const page = local ? `/@${status.account.username}/${status.id}` : null
	const count = (kind: CountKind, n: number): CountView =>
		page === null ? { kind, n } : { kind, n, href: `${page}${COUNT_TABS[kind]}` }
	const counts: CountView[] = [
		count('replies', status.replies_count),
		count('boosts', status.reblogs_count),
		count('favourites', status.favourites_count),
	]
	// Quotes are shown only when there are some.
	if (status.quotes_count > 0) {
		counts.push(count('quotes', status.quotes_count))
	}
	const field = emojiFields(status.emojis, allowance)
	const author = authorView(status.account, domain, allowance)
	const cw = status.spoiler_text === '' ? [] : field().text(status.spoiler_text)
	// HTML-1 at the sink.
	const html = sanitizedWithEmoji(status.content ?? '', field())
	const poll = status.poll === null ? null : pollView(status.poll, field)
	return {
		link,
		author,
		createdAt: status.created_at,
		editedAt: status.edited_at,
		lang: languageOf(status.language),
		cw,
		html,
		media: status.media_attachments.flatMap((media) => mediaView(media, domain) ?? []),
		sensitive: status.sensitive,
		counts,
		replyTo: parent === null || parentLink === null ? null : { link: parentLink, acct: parent.acct },
		poll,
		quote: quoted || status.quote === null ? null : quoteView(status.quote, domain, allowance),
	}
}

function quoteView(quote: Quote | ShallowQuote, domain: string, allowance: EmojiAllowance): QuoteView {
	switch (quote.state) {
		case 'accepted':
			return 'quoted_status' in quote && quote.quoted_status !== null
				? { state: 'accepted', post: postView(quote.quoted_status, null, domain, allowance, true) }
				: { state: 'unavailable' }
		case 'pending':
			return { state: 'pending' }
		case 'rejected':
		case 'revoked':
			return { state: 'revoked' }
		default:
			return { state: 'unavailable' }
	}
}

// The post's first attachment when it is the page's likely largest paint: only a post shown at once,
// with no content warning or sensitive media over it.
export function likelyLcp(post: PostView): MediaView | null {
	return post.cw.length === 0 && !post.sensitive ? (post.media[0] ?? null) : null
}

// A post a page links without showing it (the first of a list, too large to show beside the rest of its
// page): its author's address and date, linking to its own page or its origin; each left out when the read had none.
export type StubView = { link: Link | null; address: string | null; createdAt: string | null }

export function stubView(stub: StatusStub, domain: string): StubView {
	return {
		link: linkTo(stub.url, domain),
		address: stub.acct === null ? null : address({ acct: stub.acct }, domain),
		createdAt: stub.created_at,
	}
}
