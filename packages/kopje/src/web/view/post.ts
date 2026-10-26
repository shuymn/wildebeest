import { type AuthorView, authorView, type Inline } from './account'
import { type Link, linkTo } from './link'
import { type MediaView, mediaView } from './media'
import type { Status } from '../../domain/status-presenter'
import type { StatusStub } from '../../domain/web-pages/budget'
import type { ParentLink } from '../../domain/web-pages/parents'
import { type SafeHtml, sanitized } from '../safe-html'

// A status as the pages show it (design §11, "View-model types"). Pure: the read decided what is visible.

export type CountKind = 'replies' | 'boosts' | 'favourites' | 'quotes'

// A count under a post; `href` makes it a link.
export type CountView = { kind: CountKind; n: number; href?: string }

export type PostView = {
	link: Link | null
	author: AuthorView
	createdAt: string
	editedAt: string | null
	// The status's language, when it is a language tag (§9.5); unknown means no attribute.
	lang?: string
	cw: Inline[]
	html: SafeHtml
	media: MediaView[]
	sensitive: boolean
	counts: CountView[]
	replyTo: { link: Link; acct: string } | null
}

const LANGUAGE_TAG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/

export function postView(status: Status, parent: ParentLink | null, domain: string): PostView {
	const parentLink = parent === null ? null : linkTo(parent.url, domain)
	const counts: CountView[] = [
		{ kind: 'replies', n: status.replies_count },
		{ kind: 'boosts', n: status.reblogs_count },
		{ kind: 'favourites', n: status.favourites_count },
	]
	// Quotes are shown only when there are some (§11, Counts).
	if (status.quotes_count > 0) {
		counts.push({ kind: 'quotes', n: status.quotes_count })
	}
	return {
		link: linkTo(status.url, domain),
		author: authorView(status.account, domain),
		createdAt: status.created_at,
		editedAt: status.edited_at,
		...(status.language !== null && LANGUAGE_TAG.test(status.language) ? { lang: status.language } : {}),
		cw: status.spoiler_text === '' ? [] : [status.spoiler_text],
		// HTML-1 at the sink.
		html: sanitized(status.content ?? ''),
		media: status.media_attachments.flatMap((media) => mediaView(media) ?? []),
		sensitive: status.sensitive,
		counts,
		replyTo: parent === null || parentLink === null ? null : { link: parentLink, acct: parent.acct },
	}
}

// A post a page links without showing it (design §2: the first of a list, too large to show beside the rest of its
// page): its author's address and date, linking to its own page or its origin.
export type StubView = { link: Link | null; address: string; createdAt: string }

export function stubView(stub: StatusStub, domain: string): StubView {
	return {
		link: linkTo(stub.url, domain),
		address: stub.acct.includes('@') ? `@${stub.acct}` : `@${stub.acct}@${domain}`,
		createdAt: stub.created_at,
	}
}
