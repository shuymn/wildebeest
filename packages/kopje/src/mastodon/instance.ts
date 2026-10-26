import {
	type ApiContext,
	type ApiDeps,
	type ApiHandler,
	authorized,
	optionalTokenCredential,
	present,
	storeCall,
	vapidKey,
} from './context'
import { mastodonError } from './errors'
import { LANGUAGES } from './languages'
import { MAX_DESCRIPTION } from './media'
import { PIN_LIMIT } from '../domain/activities'
import type { InstanceInfo } from '../domain/instance'

// /api/v1/instance and /api/v2/instance in their Mastodon 4.5 shapes. The payloads are frozen by a contract test.
//
// Clients choose APIs by these two numbers, so they are the highest at which every feature a client switches on is
// one Kopje serves or one whose missing parts the client gets past:
//   - api_versions.mastodon (v2 only, as in Mastodon) is 7, Mastodon 4.5's. What each step up to it signals, all
//     served: 2 grouped notifications (/api/v2/notifications); 3 attribution domains (update_credentials), and in the
//     official Android app OAuth PKCE (S256); 4 delete_media and DELETE /api/v1/media/:id; 5 the blur filter action;
//     6 featuring hashtags (POST /api/v1/tags/:id/feature); 7 quote posts: quoted_status_id, quote_approval_policy,
//     interaction_policy, the quotes list and revoke (R35, R36). At 7 Phanpy also hides the quote-inline fallback.
//   - version is 4.5.0, the release of api_versions 7. Ice Cubes reads it and switches on at 4.3 grouped
//     notifications, the notification policy and the link timeline, all served; the official apps read only its major
//     number; Phanpy reads it only when NodeInfo names the software "mastodon", and Kopje's says "kopje". Kopje had no
//     build suffix and adds none: NodeInfo names it, as it names Pleroma, Akkoma and GoToSocial.
// Streaming and translation are not chosen by either number: clients use configuration.urls.streaming and
// configuration.translation.enabled (false).

export const MASTODON_VERSION = '4.5.0'
export const API_VERSIONS = { mastodon: 7 }

const SOURCE_URL = 'https://github.com/shuymn/wildebeest'

// The plain default shipped as a static asset (public/assets); Kopje has no thumbnail upload.
const DEFAULT_THUMBNAIL = '/assets/thumbnail.png'

// The web UI's only language (src/web/strings.ts, `<html lang="en">`), as Mastodon lists its default locale
// (InstancePresenter#languages).
const UI_LANGUAGES = ['en']

const CONFIGURATION = {
	accounts: { max_featured_tags: 10 },
	statuses: { max_characters: 500, max_media_attachments: 4, characters_reserved_per_url: 23 },
	media_attachments: {
		supported_mime_types: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif'],
		// Enforced by the upload (mastodon/media.ts); GIF, WebP and AVIF are re-encoded as WebP. No video or audio type
		// is listed: they are refused.
		image_size_limit: 16777216,
		image_matrix_limit: 16777216,
		video_size_limit: 41943040,
		video_frame_rate_limit: 60,
		video_matrix_limit: 2304000,
	},
	polls: { max_options: 4, max_characters_per_option: 50, min_expiration: 300, max_expiration: 2629746 },
}

async function load(c: ApiContext, deps: ApiDeps): Promise<{ info: InstanceInfo; domain: string; origin: string }> {
	const info = await storeCall(c, deps, (s, b) => s.instanceInfo(b, { now: deps.now(), present: present(c) }))
	const url = new URL(c.req.url)
	// Before /setup fixes the domain, the request's host stands in.
	return { info, domain: info.domain ?? url.host, origin: url.origin }
}

export const instanceV1: ApiHandler = async (c, deps) => {
	const { info, domain, origin } = await load(c, deps)
	return c.json({
		uri: domain,
		title: info.title ?? domain,
		short_description: info.description ?? '',
		description: info.description ?? '',
		email: info.contactEmail ?? '',
		version: MASTODON_VERSION,
		urls: { streaming_api: `wss://${domain}` },
		stats: { user_count: info.userCount, status_count: info.statusCount, domain_count: info.domainCount },
		thumbnail: `${origin}${DEFAULT_THUMBNAIL}`,
		languages: UI_LANGUAGES,
		registrations: false,
		approval_required: false,
		invites_enabled: false,
		configuration: CONFIGURATION,
		contact_account: info.contactAccount,
		rules: info.rules,
	})
}

export const instanceV2: ApiHandler = async (c, deps) => {
	const { info, domain, origin } = await load(c, deps)
	return c.json({
		domain,
		title: info.title ?? domain,
		version: MASTODON_VERSION,
		source_url: SOURCE_URL,
		description: info.description ?? '',
		usage: { users: { active_month: info.activeMonth } },
		thumbnail: { url: `${origin}${DEFAULT_THUMBNAIL}` },
		languages: UI_LANGUAGES,
		// Kopje ships no app icons (Mastodon lists its own defaults).
		icon: [],
		configuration: {
			// The about page is /about, the documents' pages /privacy-policy and /terms-of-service (app/web.tsx), each
			// named only while its document is available (Mastodon always names its privacy policy, served from a template
			// when none is set). No status page.
			urls: {
				streaming: `wss://${domain}`,
				status: null,
				about: `https://${domain}/about`,
				privacy_policy: info.privacyPolicy ? `https://${domain}/privacy-policy` : null,
				terms_of_service: info.termsOfService ? `https://${domain}/terms-of-service` : null,
			},
			vapid: { public_key: vapidKey(c.env) },
			...CONFIGURATION,
			accounts: { ...CONFIGURATION.accounts, max_pinned_statuses: PIN_LIMIT },
			media_attachments: { ...CONFIGURATION.media_attachments, description_limit: MAX_DESCRIPTION },
			translation: { enabled: false },
			// Who may read the public, hashtag and link timelines: anyone, as Kopje serves them without a token.
			timelines_access: {
				live_feeds: { local: 'public', remote: 'public' },
				hashtag_feeds: { local: 'public', remote: 'public' },
				trending_link_feeds: { local: 'public', remote: 'public' },
			},
			limited_federation: false,
		},
		registrations: {
			enabled: false,
			approval_required: false,
			reason_required: false,
			message: null,
			min_age: null,
			url: null,
		},
		api_versions: API_VERSIONS,
		contact: { email: info.contactEmail ?? '', account: info.contactAccount },
		rules: info.rules,
	})
}

// GET /api/v1/custom_emojis: the enabled local emoji shown in the picker (domain/local-emojis.ts customEmojis), to
// anyone, as Mastodon's CustomEmojisController#index.
export const customEmojis: ApiHandler = async (c, deps) => c.json(await storeCall(c, deps, (s, b) => s.customEmojis(b)))

// The rest of /api/v1/instance/*, the endpoints clients read at startup and on an instance's about page.

export const rules: ApiHandler = async (c, deps) => c.json(await storeCall(c, deps, (s, b) => s.instanceRules(b)))

export const peers: ApiHandler = async (c, deps) => c.json(await storeCall(c, deps, (s, b) => s.instancePeers(b)))

// GET /api/v1/peers/search, as Mastodon's Api::V1::Peers::SearchController#index with the peers API on (its default):
// null for a blank q (@domains is never set), else the peers whose domain starts with q as TagManager#normalize_domain
// reads it (a host, lowercased and IDNA-encoded), and [] for a q that is no host (Addressable::URI::InvalidURIError).
export const searchPeers: ApiHandler = async (c, deps) => {
	const q = (c.req.query('q') ?? '').trim()
	if (q === '') {
		return c.json(null)
	}
	const prefix = normalizeDomain(q)
	return c.json(prefix === null ? [] : await storeCall(c, deps, (s, b) => s.searchPeers(b, { prefix })))
}

function normalizeDomain(value: string): string | null {
	const host = value.replace(/\/$/, '')
	if (host === '') {
		return ''
	}
	if (/[\s/?#@:\\]/.test(host)) {
		return null
	}
	const hostname = URL.parse(`https://${host}/`)?.hostname
	if (hostname === undefined) {
		return null
	}
	// Addressable keeps a host of numbers as written where WHATWG reads it as an IPv4 address (123 as 0.0.0.123), and
	// drops a trailing dot.
	const written = /^\d+(\.\d+){3}$/.test(hostname) && hostname !== host ? host.toLowerCase() : hostname
	return written.replace(/\.$/, '')
}

// GET /api/v1/instance/extended_description, as Mastodon's REST::ExtendedDescriptionSerializer: the stored HTML
// sanitized, with its stamp (null for a converted one until it is edited), or Mastodon's answer when none is set.
export const extendedDescription: ApiHandler = async (c, deps) => {
	const document = await storeCall(c, deps, (s, b) => s.instanceDocument(b, { name: 'extended_description' }))
	return c.json({ updated_at: document?.updatedAt ?? null, content: document?.text ?? '' })
}

// GET /api/v1/instance/privacy_policy, as Mastodon's REST::PrivacyPolicySerializer. None set answers Mastodon's
// not_found (app/controllers/api/base_controller.rb:100-102) instead of its built-in template, which describes
// Mastodon's data handling and is not true of Kopje. updated_at is null for a converted policy until it is edited.
export const privacyPolicy: ApiHandler = async (c, deps) => {
	const document = await storeCall(c, deps, (s, b) => s.instanceDocument(b, { name: 'privacy_policy' }))
	return document === null
		? mastodonError(404, 'Not Found')
		: c.json({ updated_at: document.updatedAt, content: document.text })
}

// GET /api/v1/instance/terms_of_service and /:date, as Mastodon's TermsOfServicesController#set_terms_of_service with
// one current version: none answers not_found ("Not Found"), and a /:date other than the stored date, spelled exactly
// (Rails would also cast 2026-1-5), answers RecordNotFound ("Record not found"). effective is the date strictly before
// today (UTC), as effective_date&.past?; a future date is still the current version (TermsOfService.current's
// upcoming.first). Kopje keeps no earlier versions, so succeeded_by is null.
export const termsOfService: ApiHandler = async (c, deps) => {
	const date = c.req.param('date')
	const document = await storeCall(c, deps, (s, b) => s.instanceDocument(b, { name: 'terms_of_service' }))
	if (document?.effectiveDate == null || (date !== undefined && date !== document.effectiveDate)) {
		return mastodonError(404, date === undefined ? 'Not Found' : 'Record not found')
	}
	const today = new Date(deps.now()).toISOString().slice(0, 10)
	return c.json({
		effective_date: document.effectiveDate,
		effective: document.effectiveDate < today,
		content: document.text,
		succeeded_by: null,
	})
}

// GET /api/v1/instance/domain_blocks (domain/instance-domain-blocks.ts publicDomainBlocks): a suspended user's token
// is answered 403 whatever the settings; a list the settings hide answers Mastodon's head 404 (an empty body).
export const domainBlocks: ApiHandler = async (c, deps) => {
	const credential = optionalTokenCredential(c, deps)
	const blocks = authorized(await storeCall(c, deps, (s, b) => s.publicDomainBlocks(b, { credential })))
	return blocks === null ? new Response(null, { status: 404 }) : c.json(blocks)
}

// GET /api/v1/instance/activity (Api::V1::Instances::ActivityController, domain/instance-activity.ts): the 12 weeks,
// the same for every caller (public, Vary empty), with cache_even_if_authenticated!'s Cache-Control; with
// activity_api_enabled off, Mastodon's head 404 (require_enabled_api!), before the action sets any caching.
const ACTIVITY_CACHE = 'public, max-age=300, stale-while-revalidate=30, stale-if-error=86400'

export const activity: ApiHandler = async (c, deps) => {
	const body = await storeCall(c, deps, (s, b) => s.instanceActivity(b, { now: deps.now() }))
	return body === null
		? new Response(null, { status: 404 })
		: c.body(body, 200, { 'content-type': 'application/json', 'cache-control': ACTIVITY_CACHE })
}

// GET /api/v1/instance/translation_languages: {} when no translation service is configured, as Mastodon's
// Api::V1::Instances::TranslationLanguagesController#set_languages leaves it. Kopje has none.
export const translationLanguages: ApiHandler = (c) => Promise.resolve(c.json({}))

export const languages: ApiHandler = (c) => Promise.resolve(c.json(LANGUAGES))
