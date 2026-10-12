import { type ApiContext, type ApiDeps, type ApiHandler, storeCall, vapidKey } from './context'
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
