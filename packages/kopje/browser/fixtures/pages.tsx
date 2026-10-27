import type { Child, JSXNode } from 'hono/jsx'

import type { Account } from '../../src/domain/accounts'
import type { Poll } from '../../src/domain/polls'
import type { MediaAttachment, Status } from '../../src/domain/status-presenter'
import type { Site } from '../../src/domain/web-pages/site'
import type { PageHistory } from '../../src/domain/web-pages/status'
import { embedHtml } from '../../src/mastodon/oembed'
import { L1Context } from '../../src/web/components/layout'
import { AboutPage } from '../../src/web/pages/about'
import { DocumentPage } from '../../src/web/pages/document'
import { EmbedPage } from '../../src/web/pages/embed'
import { FeaturedPage } from '../../src/web/pages/featured'
import { FollowsPage } from '../../src/web/pages/follows'
import { HandoffFormPage, HandoffPage } from '../../src/web/pages/handoff'
import { InteractionPage, InteractionResultPage } from '../../src/web/pages/interaction'
import { MessagePage } from '../../src/web/pages/message'
import { ProfilePage } from '../../src/web/pages/profile'
import { StatusPage } from '../../src/web/pages/status'
import { TagPage } from '../../src/web/pages/tag'
import { STRINGS } from '../../src/web/strings'
import { accountTarget, statusTarget } from '../../src/web/view/remote'
import { account, CREATED, customEmoji, media, status as post } from '../../test/web-fixtures'
import { DOMAIN, ORIGIN, pageNamed, type PageName } from '../pages'

// Each fixture page of ../pages.ts rendered by the real components from view data, as the Worker renders it
// (src/app/public-pages.tsx). Every image is on the instance origin, so the pages load nothing the job does not serve. This
// module is typed against the Workers types (tsconfig.json here), as the components are.

// A session's anti-forgery token, as the signed-in forms carry it.
const CSRF = 'c'.repeat(43)

// A custom emoji, on the instance origin (design §11): its image is the avatar's.
const LEAF = customEmoji('leaf', `${ORIGIN}/assets/avatar.png`)

// The shared builders (test/web-fixtures.ts), with this job's own values: alice's name, bio, counts, emoji and field.
const alice: Account = account({
	display_name: 'Alice :leaf:',
	note: '<p>Writes about <a href="https://kopje.test/tags/walks">#walks</a> and trains.</p>',
	followers_count: 12,
	following_count: 3,
	statuses_count: 4,
	emojis: [LEAF],
	fields: [{ name: 'Site', value: '<a href="https://site.example/" rel="me">site.example</a>', verified_at: null }],
})

const image: MediaAttachment = media('50', {
	url: `${ORIGIN}/assets/thumbnail.png`,
	preview_url: `${ORIGIN}/assets/thumbnail.png`,
	meta: { small: { width: 640, height: 336, size: '640x336', aspect: 640 / 336 } },
	description: 'A path through a field',
})

// Media of every other type (design §11, "Media by type"): a video with its own preview as its poster, a gifv and an
// audio file without one, and a file of another type. The players' files are never served: preload="none" means the
// page asks for none of them until played.
const player = (id: string, type: string, preview: boolean, description: string | null): MediaAttachment => ({
	...image,
	id,
	type,
	url: `${ORIGIN}/media/${id}/full.bin`,
	preview_url: preview ? `${ORIGIN}/assets/thumbnail.png` : `${ORIGIN}/media/${id}/full.bin`,
	description,
})
const players = [
	player('51', 'video', true, 'A walk along the river'),
	player('52', 'gifv', false, 'A leaf turning'),
	player('53', 'audio', false, null),
	player('54', 'unknown', false, 'Field notes'),
]

// A poll still open, its counts shown.
const openPoll: Poll = {
	id: '102',
	expires_at: '2026-10-30T12:00:00.000Z',
	expired: false,
	multiple: false,
	votes_count: 12,
	voters_count: 12,
	options: [
		{ title: 'The river path :leaf:', votes_count: 9 },
		{ title: 'The hill', votes_count: 3 },
	],
	emojis: [LEAF],
}

// A post of alice's with this job's counts and content.
function status(id: string, fields: Partial<Status>): Status {
	return post(id, {
		replies_count: 1,
		reblogs_count: 2,
		favourites_count: 3,
		content: '<p>A plain post.</p>',
		account: alice,
		...fields,
	})
}

const plain = status('101', {})
// Behind its warning, the embed's post holds a poll whose counts are hidden and quotes a post (nested).
const warned = status('104', {
	spoiler_text: 'Spoilers for the last chapter',
	sensitive: true,
	content: '<p>The <a href="https://kopje.test/tags/ending">#ending</a> was a surprise.</p>',
	poll: { ...openPoll, options: openPoll.options.map((option) => ({ ...option, votes_count: null })) },
	quote: { state: 'accepted', quoted_status: plain },
})
const sensitiveMedia = status('103', { sensitive: true, content: '<p>A photo.</p>', media_attachments: [image] })
// The status page's post: an emoji, media of every other type (the video first, so its poster is the page's
// likely largest paint), a poll and a quoted post.
const reply = status('102', {
	in_reply_to_id: '101',
	in_reply_to_account_id: '1',
	content: '<p>Replying to myself :leaf: with an <a href="https://site.example/page">outside link</a>.</p>',
	edited_at: '2026-10-21T10:00:00.000Z',
	emojis: [LEAF],
	media_attachments: players,
	poll: openPoll,
	quote: { state: 'accepted', quoted_status: { ...plain, quote: null } },
})
// A pinned post (shown before the list on the Posts tab's first page) and a boost of another server's post.
// A pinned post whose quote awaits approval and whose poll has ended.
const pinned = status('106', {
	content: '<p>A pinned post.</p>',
	quote: { state: 'pending', quoted_status: null },
	poll: { ...openPoll, expired: true },
})
const bob: Account = {
	...alice,
	id: '2',
	username: 'bob',
	acct: 'bob@remote.example',
	display_name: 'Bob',
	note: '',
	url: 'https://remote.example/@bob',
	uri: 'https://remote.example/users/bob',
	fields: [],
}
const boost = status('107', {
	content: '',
	language: null,
	replies_count: 0,
	reblogs_count: 0,
	favourites_count: 0,
	reblog: status('900', {
		account: bob,
		uri: 'https://remote.example/users/bob/statuses/900',
		url: 'https://remote.example/@bob/900',
		content: '<p>A post from another server.</p>',
	}),
})

// The status page's post's edit history (design §8): the current version, an edited one behind its warning with
// sensitive media and a poll's choices, and two older versions left out.
const history: PageHistory = {
	versions: [
		{
			content: reply.content ?? '',
			spoiler_text: '',
			sensitive: false,
			created_at: '2026-10-21T10:00:00.000Z',
			// A choice of 50 characters with no break opportunity, the longest a local poll takes.
			poll: { options: [{ title: 'w'.repeat(50) }, ...openPoll.options.map(({ title }) => ({ title }))] },
			media_attachments: [],
			emojis: [LEAF],
		},
		{
			content: '<p>Replying to myself :leaf:.</p>',
			spoiler_text: 'An earlier warning',
			sensitive: true,
			created_at: '2026-10-20T12:00:00.000Z',
			poll: { options: [{ title: 'The river path' }, { title: 'The hill :leaf:' }] },
			media_attachments: [image],
			emojis: [LEAF],
		},
	],
	leftOut: 2,
}

// The status page's post as the handoff pages name it.
const replyTarget = statusTarget({ uri: reply.uri, url: reply.url ?? '', path: '/@alice/102' })

// The site facts every page read loads (domain/web-pages/site.ts): both documents exist, so every footer links them.
const site: Site = { domain: DOMAIN, documents: { privacyPolicy: true, termsOfService: true } }

const ELEMENTS: Record<PageName, Child> = {
	profile: (
		<ProfilePage
			account={alice}
			tab={{ kind: 'posts' }}
			pins={[pinned]}
			statuses={[boost, warned, sensitiveMedia, reply, plain]}
			// A post too large to show beside the rest (design §2): its row, which the checks cover with the cards.
			stub={{ id: '105', url: `${ORIGIN}/@alice/105`, acct: 'alice', created_at: CREATED }}
			parents={{ '101': { url: `${ORIGIN}/@alice/101`, acct: 'alice' } }}
			cursor={null}
			paging={{ newest: '107', oldest: '100', more: true }}
			site={site}
			actorUri={alice.uri}
		/>
	),
	// An older page of a hashtag: a stubbed first post, posts and a reply with its parent's line, both pager links.
	tag: (
		<TagPage
			tag="walks"
			statuses={[warned, sensitiveMedia, reply, plain]}
			stub={{ id: '105', url: `${ORIGIN}/@alice/105`, acct: 'alice', created_at: CREATED }}
			parents={{ '101': { url: `${ORIGIN}/@alice/101`, acct: 'alice' } }}
			cursor={{ maxId: '106' }}
			paging={{ newest: '105', oldest: '101', more: true }}
			site={site}
		/>
	),
	// The status page: its parent above it, and a Replies tab with no replies.
	status: (
		<StatusPage
			status={reply}
			parent={{ url: `${ORIGIN}/@alice/101`, acct: 'alice' }}
			history={history}
			site={site}
			embed={embedHtml(reply, DOMAIN)}
			thread={{
				ancestors: [plain],
				replies: [],
				stub: null,
				paging: { newest: null, oldest: null, more: false },
				cursor: null,
			}}
		/>
	),
	// A thread at a later page of its replies (design §4): two ancestors, then the post, then its replies after a
	// cursor, the first too large to show (a remote one's stub), and both pager links.
	thread: (
		<StatusPage
			status={status('108', { in_reply_to_id: '102', in_reply_to_account_id: '1', content: '<p>Further down.</p>' })}
			parent={{ url: `${ORIGIN}/@alice/102`, acct: 'alice' }}
			history={null}
			site={site}
			embed={embedHtml(reply, DOMAIN)}
			thread={{
				ancestors: [plain, reply],
				replies: [sensitiveMedia, pinned],
				stub: { id: '109', url: 'https://remote.example/@bob/109', acct: 'bob@remote.example', created_at: CREATED },
				paging: { newest: '110', oldest: '109', more: true },
				cursor: { minId: '108' },
			}}
		/>
	),
	about: (
		<AboutPage
			title="Kopje Test"
			site={site}
			description="A small server for testing."
			contactEmail="admin@kopje.test"
			rules={[
				{ id: '1', text: 'Be kind.', hint: '', translations: {} },
				{ id: '2', text: 'No spam.', hint: 'Advertising included.', translations: {} },
			]}
			extendedDescription={'<p>Run by one person.</p><p>See the <a href="/privacy-policy">policy</a>.</p>'}
		/>
	),
	// Inline content directly in the body, not in a <p>: text, a link and text share one line box.
	document: (
		<DocumentPage
			title={STRINGS.documents.privacyPolicy}
			site={site}
			path="/privacy-policy"
			html='We keep <a href="https://kopje.test/about">little data</a> about you.<h2>Logs</h2><p>Kept for a week.</p>'
			updatedAt="2026-10-01T00:00:00.000Z"
			effectiveDate={null}
		/>
	),
	// A follow list with a member on another server (its link names the server) and one of this server's, and a page
	// past it.
	followers: (
		<FollowsPage
			account={alice}
			direction="followers"
			hidden={false}
			accounts={[
				bob,
				{ ...alice, id: '3', username: 'dana', acct: 'dana', display_name: 'Dana', url: `${ORIGIN}/@dana` },
			]}
			cursor={null}
			paging={{ newest: '30', oldest: '20', more: true }}
			site={site}
		/>
	),
	// An account that hides its network: the counts alone.
	'follows-hidden': (
		<FollowsPage
			account={{ ...alice, id: '4', username: 'carol', acct: 'carol', display_name: 'Carol', url: `${ORIGIN}/@carol` }}
			direction="following"
			hidden
			accounts={[]}
			cursor={null}
			paging={{ newest: null, oldest: null, more: false }}
			site={site}
		/>
	),
	// The Featured tab: a hashtag with its page, an imported name that has none, two endorsed accounts (one on another
	// server) and a page past them.
	featured: (
		<FeaturedPage
			account={alice}
			tags={[
				{
					featured: {
						id: '1',
						name: 'Walks',
						url: `${ORIGIN}/@alice/tagged/walks`,
						statuses_count: '12',
						last_status_at: '2026-10-20',
					},
					tag: 'walks',
				},
				{
					featured: {
						id: '2',
						name: 'a-b',
						url: `${ORIGIN}/@alice/tagged/ab`,
						statuses_count: '1',
						last_status_at: null,
					},
					tag: null,
				},
			]}
			accounts={[
				bob,
				{ ...alice, id: '3', username: 'dana', acct: 'dana', display_name: 'Dana', url: `${ORIGIN}/@dana` },
			]}
			cursor={null}
			paging={{ newest: '3', oldest: '2', more: true }}
			site={site}
		/>
	),
	'not-found': <MessagePage chrome={site} title={STRINGS.errors.notFoundTitle} message={STRINGS.errors.notFound} />,
	embed: <EmbedPage status={warned} domain={DOMAIN} />,
	interaction: <InteractionPage site={site} uri={alice.uri} csrf={CSRF} />,
	'interaction-result': (
		<InteractionResultPage site={site} target={{ kind: 'account', account: alice }} uri={alice.uri} csrf={CSRF} />
	),
	'handoff-form': <HandoffFormPage site={site} target={accountTarget(alice, DOMAIN)} problem={false} />,
	'handoff-refused': <HandoffFormPage site={site} target={replyTarget} problem />,
	handoff: <HandoffPage site={site} target={replyTarget} host="social.example" />,
}

// The bytes the Worker sends for each page: c.html writes the rendered element as it is, inside L1Context on the
// pages that load the L1 bundle (l1Page in src/app/public-pages.tsx).
export async function renderPages(): Promise<Record<PageName, string>> {
	const html = {} as Record<PageName, string>
	for (const [name, element] of Object.entries(ELEMENTS) as [PageName, Child][]) {
		const page =
			pageNamed(name).kind === 'l1' ? <L1Context.Provider value={true}>{element}</L1Context.Provider> : element
		html[name] = String(await (page as JSXNode).toString())
	}
	return html
}
