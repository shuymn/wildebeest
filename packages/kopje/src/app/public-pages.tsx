import { type Context, Hono } from 'hono'

import { PUBLIC_HEADERS, embedHeaders } from './web-headers'
import type { FollowDirection } from '../domain/web-pages/follows'
import { pageCursor } from '../domain/web-pages/paging'
import type { ProfileTab } from '../domain/web-pages/profile'
import { localUsername, type Site } from '../domain/web-pages/site'
import { notSetUp } from '../federation/setup-gate'
import { type ApiDeps, present, storeCall } from '../mastodon/context'
import { AboutPage } from '../web/pages/about'
import { DocumentPage } from '../web/pages/document'
import { EmbedPage } from '../web/pages/embed'
import { FollowsPage } from '../web/pages/follows'
import { MessagePage } from '../web/pages/message'
import { ProfilePage } from '../web/pages/profile'
import { StatusPage } from '../web/pages/status'
import { STRINGS } from '../web/strings'

// The public pages (design §1, §3): what the instance shows people who are not using a client, to an anonymous viewer
// (VIS-4). Each page makes one Store call, a page read that also reads the site facts (domain/web-pages/), and answers
// 503 before setup has fixed the domain (SETUP-1). These routes read no session and no cookie, so a page is the same
// with and without one. ActivityPub requests for /@user and /@user/:id forward to the actor and object endpoints, which
// make their own reads. Every path of a page's shape that no page serves answers the ordinary 404 page, and every
// hidden case of a page answers the same bytes as a missing one.

export type PublicDeps = ApiDeps & {
	// Serves another path of this app for the same request (content negotiation to the ActivityPub documents).
	dispatch: (request: Request, env: Env, ctx: Context['executionCtx']) => Response | Promise<Response>
}

type PublicContext = Context<{ Bindings: Env }>

// The status page's id: an API id, or a legacy id, which moves to the API id (design §3).
const STATUS_ID = '(?:[0-9]{1,19}|[0-9a-f-]{36})'

type PageStatus = 200 | 404 | 410

function publicPage(c: PublicContext, status: PageStatus, body: Parameters<PublicContext['html']>[0]) {
	return c.html(body, status, PUBLIC_HEADERS)
}

function notFound(c: PublicContext, site: Site) {
	return publicPage(
		c,
		404,
		<MessagePage chrome={site} title={STRINGS.errors.notFoundTitle} message={STRINGS.errors.notFound} />
	)
}

// An ActivityPub client asks for the object, a browser for the page (content negotiation on /@user and /@user/:id).
function wantsActivityPub(accept: string | undefined): boolean {
	return accept !== undefined && /application\/(activity\+json|ld\+json)/i.test(accept)
}

function withVary(response: Response): Response {
	const copy = new Response(response.body, response)
	copy.headers.append('vary', 'Accept')
	return copy
}

export function publicPageRoutes(deps: PublicDeps): Hono<{ Bindings: Env }> {
	const app = new Hono<{ Bindings: Env }>()

	// The same request for another path of this app, keeping its headers (Accept, signatures).
	const forward = (c: PublicContext, path: string) =>
		deps.dispatch(new Request(new URL(path, c.req.url), c.req.raw), c.env, c.executionCtx)

	// No page of its own yet: the about page, which oEmbed's provider_url (/) then opens. 302, so a home page can
	// replace it.
	app.get(
		'/',
		() => new Response(null, { status: 302, headers: { location: '/about', 'cache-control': 'public, max-age=60' } })
	)

	app.get('/about', async (c) => {
		const page = await storeCall(c, deps, (s, b) => s.webAbout(b))
		if (page.status === 'not_set_up') {
			return notSetUp(c)
		}
		const { about, site } = page
		return publicPage(
			c,
			200,
			<AboutPage
				title={about.title ?? site.domain}
				site={site}
				description={about.description ?? ''}
				contactEmail={about.contactEmail ?? ''}
				rules={about.rules}
				extendedDescription={about.extendedDescription}
			/>
		)
	})

	// The documents the instance endpoints serve (domain/instance.ts), as stored and sanitized at the page's sink; a
	// /:date matches the stored effective date exactly, as GET /api/v1/instance/terms_of_service/:date.
	const documentPage = async (c: PublicContext, name: 'privacy_policy' | 'terms_of_service', date?: string) => {
		const page = await storeCall(c, deps, (s, b) => s.webDocument(b, { name }))
		if (page.status === 'not_set_up') {
			return notSetUp(c)
		}
		const { document, site } = page
		if (document === null || (date !== undefined && date !== document.effectiveDate)) {
			return notFound(c, site)
		}
		return publicPage(
			c,
			200,
			<DocumentPage
				title={name === 'privacy_policy' ? STRINGS.documents.privacyPolicy : STRINGS.documents.termsOfService}
				site={site}
				path={
					name === 'privacy_policy' ? '/privacy-policy' : `/terms-of-service${date === undefined ? '' : `/${date}`}`
				}
				html={document.text}
				updatedAt={document.updatedAt}
				effectiveDate={document.effectiveDate}
			/>
		)
	}
	app.get('/privacy-policy', (c) => documentPage(c, 'privacy_policy'))
	app.get('/terms-of-service', (c) => documentPage(c, 'terms_of_service'))
	app.get('/terms-of-service/:date', (c) => documentPage(c, 'terms_of_service', c.req.param('date')))

	// A profile tab (design §3): HTML only, but for the Posts tab, which serves the actor to an ActivityPub client.
	const profile = async (c: PublicContext, tab: ProfileTab) => {
		const handle = c.req.param('handle') ?? ''
		if (tab.kind === 'posts' && wantsActivityPub(c.req.header('accept'))) {
			return profileActor(c, handle)
		}
		const cursor = pageCursor(c.req.query('max_id'), c.req.query('min_id'))
		const page = await storeCall(c, deps, (s, b) => s.webProfilePage(b, { handle, tab, cursor, now: deps.now() }))
		switch (page.status) {
			case 'not_set_up':
				return notSetUp(c)
			case 'not_found':
				return notFound(c, page.site)
			case 'redirect':
				return new Response(null, { status: 302, headers: { location: page.location } })
			case 'suspended':
				// Mastodon answers a suspended account's profile with 410 Gone.
				return publicPage(
					c,
					410,
					<MessagePage chrome={page.site} title={STRINGS.errors.goneTitle} message={STRINGS.errors.gone} />
				)
		}
		const { site } = page
		return publicPage(
			c,
			200,
			<ProfilePage
				account={page.account}
				tab={tab}
				pins={page.pins}
				statuses={page.statuses}
				stub={page.stub}
				parents={page.parents}
				cursor={cursor}
				paging={page.paging}
				site={site}
				actorUri={`https://${site.domain}/ap/users/${page.account.username}`}
			/>
		)
	}

	// The actor document: the account first, case-insensitively (the actor endpoint answers only its stored spelling,
	// and serves a suspended actor redacted).
	const profileActor = async (c: PublicContext, handle: string) => {
		const gate = await storeCall(c, deps, (s, b) => s.webSite(b))
		if (gate.status === 'not_set_up') {
			return notSetUp(c)
		}
		const username = localUsername(handle, gate.site.domain)
		if (username === null || username === '') {
			return notFound(c, gate.site)
		}
		const account = await storeCall(c, deps, (s, b) =>
			s.lookupAccount(b, { username, domain: null, present: present(c) })
		)
		return account === null
			? withVary(new Response('Not Found', { status: 404 }))
			: withVary(await forward(c, `/ap/users/${encodeURIComponent(account.username)}`))
	}

	app.get('/:handle{@[^/]+}', (c) => profile(c, { kind: 'posts' }))
	app.get('/:handle{@[^/]+}/with_replies', (c) => profile(c, { kind: 'with_replies' }))
	app.get('/:handle{@[^/]+}/media', (c) => profile(c, { kind: 'media' }))
	// A featured hashtag's URL (Mastodon's short_account_tag_url): the profile's posts with the hashtag. A remote
	// account's (/@username@domain/tagged/:tag, featured-tags.ts taggedUrl) moves to its profile on its own server.
	app.get('/:handle{@[^/]+}/tagged/:tag', (c) => profile(c, { kind: 'tagged', tag: c.req.param('tag') }))

	// A local account's followers and following (design §3): HTML only; the collections stay at /ap/users/:u/….
	const follows = async (c: PublicContext, direction: FollowDirection) => {
		const handle = c.req.param('handle') ?? ''
		const cursor = pageCursor(c.req.query('max_id'), c.req.query('min_id'))
		const page = await storeCall(c, deps, (s, b) => s.webFollowsPage(b, { handle, direction, cursor, now: deps.now() }))
		switch (page.status) {
			case 'not_set_up':
				return notSetUp(c)
			case 'not_found':
				return notFound(c, page.site)
			case 'suspended':
				return publicPage(
					c,
					410,
					<MessagePage chrome={page.site} title={STRINGS.errors.goneTitle} message={STRINGS.errors.gone} />
				)
		}
		return publicPage(
			c,
			200,
			<FollowsPage
				account={page.account}
				direction={direction}
				hidden={page.hidden}
				accounts={page.accounts}
				cursor={cursor}
				paging={page.paging}
				site={page.site}
			/>
		)
	}
	app.get('/:handle{@[^/]+}/followers', (c) => follows(c, 'followers'))
	app.get('/:handle{@[^/]+}/following', (c) => follows(c, 'following'))

	// VIS-4: a status an anonymous viewer may see, or 404 for anything else, alike.
	app.get(`/:handle{@[^/]+}/:id{${STATUS_ID}}`, async (c) => {
		const page = await storeCall(c, deps, (s, b) =>
			s.webStatusPage(b, { handle: c.req.param('handle'), id: c.req.param('id'), now: deps.now() })
		)
		switch (page.status) {
			case 'not_set_up':
				return notSetUp(c)
			case 'not_found':
				return wantsActivityPub(c.req.header('accept'))
					? withVary(new Response('Not Found', { status: 404 }))
					: notFound(c, page.site)
			case 'moved':
				// A legacy id moves to the status's id for good, under the stored username (never the request's text).
				return new Response(null, {
					status: 301,
					headers: {
						location: `/@${page.username}/${page.id}`,
						vary: 'Accept',
						'cache-control': 'public, max-age=60',
					},
				})
		}
		if (wantsActivityPub(c.req.header('accept'))) {
			// The object endpoint serves the Note and applies VIS-4 again.
			return withVary(await forward(c, new URL(page.value.uri).pathname))
		}
		return publicPage(c, 200, <StatusPage status={page.value} parent={page.parent} site={page.site} />)
	})

	// The status page's status for an iframe (VIS-4, the same read): Mastodon's embed_short_account_status_url, which
	// the oEmbed HTML names (mastodon/oembed.ts). Anything the status page would not show is the same 404, which, like
	// every other page, may not be framed.
	app.get(`/:handle{@[^/]+}/:id{${STATUS_ID}}/embed`, async (c) => {
		const page = await storeCall(c, deps, (s, b) =>
			s.webStatusPage(b, { handle: c.req.param('handle'), id: c.req.param('id'), now: deps.now() })
		)
		switch (page.status) {
			case 'not_set_up':
				return notSetUp(c)
			case 'not_found':
				return notFound(c, page.site)
			case 'moved':
				return new Response(null, {
					status: 301,
					headers: { location: `/@${page.username}/${page.id}/embed`, 'cache-control': 'public, max-age=60' },
				})
		}
		const { domain } = page.site
		return c.html(<EmbedPage status={page.value} domain={domain} />, 200, embedHeaders(domain))
	})

	// The shapes of the public pages that no route above serves (design §3): the ordinary 404 page, never the plain
	// text answer of app.ts.
	const missing = async (c: PublicContext) => {
		const gate = await storeCall(c, deps, (s, b) => s.webSite(b))
		return gate.status === 'not_set_up' ? notSetUp(c) : notFound(c, gate.site)
	}
	app.get('/@*', missing)
	app.get('/tags/*', missing)

	return app
}
