import type { Child, JSXNode } from 'hono/jsx'

import type { Account } from '../../src/domain/accounts'
import type { MediaAttachment, Status } from '../../src/domain/status-presenter'
import { AboutPage } from '../../src/web/pages/about'
import { DocumentPage } from '../../src/web/pages/document'
import { EmbedPage } from '../../src/web/pages/embed'
import { MessagePage } from '../../src/web/pages/message'
import { ProfilePage } from '../../src/web/pages/profile'
import { StatusPage } from '../../src/web/pages/status'
import { STRINGS } from '../../src/web/strings'
import { DOMAIN, ORIGIN, type PageName } from '../pages'

// Each fixture page of ../pages.ts rendered by the real components from view data, as the Worker renders it
// (src/app/web.tsx). Every image is on the instance origin, so the pages load nothing the job does not serve. This
// module is typed against the Workers types (tsconfig.json here), as the components are.

const CREATED = '2026-10-20T09:30:00.000Z'

const alice: Account = {
	id: '1',
	username: 'alice',
	acct: 'alice',
	display_name: 'Alice',
	locked: false,
	bot: false,
	discoverable: true,
	indexable: false,
	group: false,
	created_at: CREATED,
	note: '<p>Writes about <a href="https://kopje.test/tags/walks">#walks</a> and trains.</p>',
	url: `${ORIGIN}/@alice`,
	uri: `${ORIGIN}/users/alice`,
	avatar: `${ORIGIN}/assets/avatar.png`,
	avatar_static: `${ORIGIN}/assets/avatar.png`,
	header: `${ORIGIN}/assets/header.png`,
	header_static: `${ORIGIN}/assets/header.png`,
	followers_count: 12,
	following_count: 3,
	statuses_count: 4,
	last_status_at: '2026-10-20',
	hide_collections: false,
	emojis: [],
	fields: [{ name: 'Site', value: '<a href="https://site.example/" rel="me">site.example</a>', verified_at: null }],
}

const image: MediaAttachment = {
	id: '50',
	type: 'image',
	url: `${ORIGIN}/assets/thumbnail.png`,
	preview_url: `${ORIGIN}/assets/thumbnail.png`,
	remote_url: null,
	preview_remote_url: null,
	text_url: null,
	meta: { small: { width: 640, height: 336, size: '640x336', aspect: 640 / 336 } },
	description: 'A path through a field',
	blurhash: null,
}

function status(id: string, fields: Partial<Status>): Status {
	return {
		id,
		created_at: CREATED,
		in_reply_to_id: null,
		in_reply_to_account_id: null,
		sensitive: false,
		spoiler_text: '',
		visibility: 'public',
		language: 'en',
		uri: `${ORIGIN}/users/alice/statuses/${id}`,
		url: `${ORIGIN}/@alice/${id}`,
		replies_count: 1,
		reblogs_count: 2,
		favourites_count: 3,
		quotes_count: 0,
		edited_at: null,
		content: '<p>A plain post.</p>',
		reblog: null,
		account: alice,
		media_attachments: [],
		mentions: [],
		tags: [],
		emojis: [],
		quote: null,
		quote_approval: { automatic: ['public'], manual: [], current_user: 'unknown' },
		card: null,
		poll: null,
		...fields,
	}
}

const warned = status('104', {
	spoiler_text: 'Spoilers for the last chapter',
	sensitive: true,
	content: '<p>The <a href="https://kopje.test/tags/ending">#ending</a> was a surprise.</p>',
})
const sensitiveMedia = status('103', { sensitive: true, content: '<p>A photo.</p>', media_attachments: [image] })
const reply = status('102', {
	in_reply_to_id: '101',
	in_reply_to_account_id: '1',
	content: '<p>Replying to myself, with an <a href="https://site.example/page">outside link</a>.</p>',
	edited_at: '2026-10-21T10:00:00.000Z',
})
const plain = status('101', {})

const ELEMENTS: Record<PageName, Child> = {
	profile: (
		<ProfilePage
			account={alice}
			statuses={[warned, sensitiveMedia, reply, plain]}
			next="100"
			domain={DOMAIN}
			actorUri={alice.uri}
		/>
	),
	status: <StatusPage status={reply} parent={{ url: `${ORIGIN}/@alice/101`, acct: 'alice' }} domain={DOMAIN} />,
	about: (
		<AboutPage
			title="Kopje Test"
			domain={DOMAIN}
			description="A small server for testing."
			contactEmail="admin@kopje.test"
			rules={[
				{ id: '1', text: 'Be kind.', hint: '', translations: {} },
				{ id: '2', text: 'No spam.', hint: 'Advertising included.', translations: {} },
			]}
			extendedDescription={'<p>Run by one person.</p><p>See the <a href="/privacy-policy">policy</a>.</p>'}
			privacyPolicy
			termsOfService
		/>
	),
	// Inline content directly in the body, not in a <p>: text, a link and text share one line box.
	document: (
		<DocumentPage
			title={STRINGS.documents.privacyPolicy}
			domain={DOMAIN}
			path="/privacy-policy"
			html='We keep <a href="https://kopje.test/about">little data</a> about you.<h2>Logs</h2><p>Kept for a week.</p>'
			updatedAt="2026-10-01T00:00:00.000Z"
			effectiveDate={null}
		/>
	),
	'not-found': (
		<MessagePage
			chrome={{ domain: DOMAIN, documents: null }}
			title={STRINGS.errors.notFoundTitle}
			message={STRINGS.errors.notFound}
		/>
	),
	embed: <EmbedPage status={warned} domain={DOMAIN} />,
}

// The bytes the Worker sends for each page: c.html writes the rendered element as it is.
export async function renderPages(): Promise<Record<PageName, string>> {
	const html = {} as Record<PageName, string>
	for (const [name, element] of Object.entries(ELEMENTS) as [PageName, Child][]) {
		html[name] = String(await (element as JSXNode).toString())
	}
	return html
}
