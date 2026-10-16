import { type ApiContext, type ApiDeps, type ApiHandler, storeCall, vapidKey } from './context'
import { mastodonError } from './errors'
import { LANGUAGES } from './languages'
import { MAX_DESCRIPTION } from './media'
import { PIN_LIMIT } from '../domain/activities'
import type { InstanceInfo } from '../domain/instance'

// /api/v1/instance and /api/v2/instance in their Mastodon 4.4 shapes. The payloads are frozen by a contract test.
//
// Clients choose APIs by these two numbers, so they are the highest at which every feature a client switches on is
// one Kopje serves or one whose missing parts the client gets past:
//   - api_versions.mastodon (v2 only, as in Mastodon) is 6, Mastodon 4.4's. What each step up to it signals, all
//     served: 2 grouped notifications (/api/v2/notifications); 3 attribution domains (update_credentials), and in the
//     official Android app OAuth PKCE (S256); 4 delete_media and DELETE /api/v1/media/:id; 5 the blur filter action; 6 featuring hashtags
//     (POST /api/v1/tags/:id/feature). At 6 the official iOS app also shows a default quote policy in its privacy
//     settings; Kopje ignores source[quote_policy] and no one can quote a Kopje post, so the setting has no effect and
//     the save still succeeds.
//   - 7 (Mastodon 4.5) is quote posts: clients would offer quoting in the composer and send quoted_status_id, which
//     Kopje does not serve, so a quote would post as a plain status. Kopje stays below it until quotes exist.
//   - version is 4.4.0, the release of api_versions 6. Ice Cubes reads it and switches on at 4.3 grouped
//     notifications, the notification policy and the link timeline, all served; the official apps read only its major
//     number; Phanpy reads it only when NodeInfo names the software "mastodon", and Kopje's says "kopje". Kopje had no
//     build suffix and adds none: NodeInfo names it, as it names Pleroma, Akkoma and GoToSocial.
// Streaming and translation are not chosen by either number: clients use configuration.urls.streaming and
// configuration.translation.enabled (false).

export const MASTODON_VERSION = '4.4.0'
export const API_VERSIONS = { mastodon: 6 }

const SOURCE_URL = 'https://github.com/shuymn/wildebeest'

// Placeholder until the web UI ships instance assets.
const THUMBNAIL_PATH = '/assets/thumbnail.png'

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
	const info = await storeCall(c, deps, (s, b) => s.instanceInfo(b))
	const url = new URL(c.req.url)
	// Before /setup fixes the domain, the request's host stands in.
	return { info, domain: info.domain ?? url.host, origin: url.origin }
}

export const instanceV1: ApiHandler = async (c, deps) => {
	const { info, domain } = await load(c, deps)
	return c.json({
		uri: domain,
		title: info.title ?? domain,
		short_description: info.description ?? '',
		description: info.description ?? '',
		email: info.contactEmail ?? '',
		version: MASTODON_VERSION,
		urls: { streaming_api: `wss://${domain}` },
		stats: { user_count: info.userCount, status_count: info.statusCount, domain_count: info.domainCount },
		thumbnail: null,
		languages: [],
		registrations: false,
		approval_required: false,
		invites_enabled: false,
		configuration: CONFIGURATION,
		contact_account: null,
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
		usage: { users: { active_month: info.userCount } },
		thumbnail: { url: `${origin}${THUMBNAIL_PATH}` },
		languages: [],
		// Kopje ships no app icons (Mastodon lists its own defaults).
		icon: [],
		configuration: {
			// No status page, privacy policy or terms of service (the last two answer 404 at /api/v1/instance/*). Kopje
			// has no about page either, so Mastodon's about URL is left out rather than pointing at a missing page.
			urls: { streaming: `wss://${domain}`, status: null, privacy_policy: null, terms_of_service: null },
			vapid: { public_key: vapidKey(c.env) },
			...CONFIGURATION,
			accounts: { ...CONFIGURATION.accounts, max_pinned_statuses: PIN_LIMIT },
			media_attachments: { ...CONFIGURATION.media_attachments, description_limit: MAX_DESCRIPTION },
			translation: { enabled: false },
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
		contact: { email: info.contactEmail ?? '', account: null },
		rules: info.rules,
	})
}

// No custom emoji yet; the route exists because clients call it at startup.
export const customEmojis: ApiHandler = (c) => Promise.resolve(c.json([]))

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

// No extended description is configured: Mastodon's answer when none is set.
export const extendedDescription: ApiHandler = (c) => Promise.resolve(c.json({ updated_at: null, content: '' }))

// Answered 404 as Mastodon answers when nothing is configured or the feature is off:
//   - terms_of_service: none is published. For a /:date, Mastodon's Api::V1::Instances::TermsOfServicesController
//     #set_terms_of_service raises RecordNotFound (find_by!), answered "Record not found".
//   - privacy_policy: none is configured. Mastodon would serve its built-in template, which describes Mastodon's data
//     handling and is not true of Kopje, so Kopje answers as for terms of service.
//   - activity: Mastodon's weekly counts include logins, which Kopje does not record; the API is off.
//   - domain_blocks: Kopje has no server-wide domain blocks to show; off, as Mastodon's default (show_domain_blocks
//     disabled).
export const notConfigured: ApiHandler = () => Promise.resolve(mastodonError(404, 'Record not found'))

// GET /api/v1/instance/translation_languages: {} when no translation service is configured, as Mastodon's
// Api::V1::Instances::TranslationLanguagesController#set_languages leaves it. Kopje has none.
export const translationLanguages: ApiHandler = (c) => Promise.resolve(c.json({}))

export const languages: ApiHandler = (c) => Promise.resolve(c.json(LANGUAGES))
