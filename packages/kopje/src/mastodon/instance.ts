import { type ApiContext, type ApiDeps, type ApiHandler, storeCall, vapidKey } from './context'
import { mastodonError } from './errors'
import { LANGUAGES } from './languages'
import type { InstanceInfo } from '../domain/instance'

// /api/v1/instance and /api/v2/instance in their Mastodon 4.0.2 shapes. The declared version stays 4.0.2 and
// api_versions is not sent: clients switch to APIs Kopje does not have yet on 4.3+ or api_versions.mastodon >= 2
// (design §4). The payloads are frozen by a contract test.

export const MASTODON_VERSION = '4.0.2'

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
		configuration: {
			urls: { streaming: `wss://${domain}` },
			vapid: { public_key: vapidKey(c.env) },
			...CONFIGURATION,
			translation: { enabled: false },
		},
		registrations: { enabled: false, approval_required: false, message: null },
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
