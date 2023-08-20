import { getAdminByEmail } from 'wildebeest/backend/src/accounts'
import { DEFAULT_THUMBNAIL } from 'wildebeest/backend/src/config'
import { getRules } from 'wildebeest/backend/src/config/rules'
import { type Database, getDatabase } from 'wildebeest/backend/src/database'
import { loadLocalMastodonAccount } from 'wildebeest/backend/src/mastodon/account'
import type { Env } from 'wildebeest/backend/src/types'
import type { InstanceConfig } from 'wildebeest/backend/src/types/configs'
import { cors } from 'wildebeest/backend/src/utils/cors'
import { actorToHandle } from 'wildebeest/backend/src/utils/handle'
import { getVersion } from 'wildebeest/config/versions'

export const onRequest: PagesFunction<Env, any> = async ({ env, request }) => {
	const domain = new URL(request.url).hostname
	return handleRequest(domain, await getDatabase(env), env)
}

export async function handleRequest(domain: string, db: Database, env: Env) {
	const headers = {
		...cors(),
		'content-type': 'application/json; charset=utf-8',
	}

	// TODO: make it more configurable
	const res: InstanceConfig = {
		uri: domain,
		title: env.INSTANCE_TITLE,
		short_description: env.INSTANCE_DESCR,
		description: env.INSTANCE_DESCR,
		email: env.ADMIN_EMAIL,
		version: getVersion(),
		urls: {},
		stats: {
			// TODO: get real stats
			user_count: 1,
			status_count: 0,
			domain_count: 0,
		},
		thumbnail: DEFAULT_THUMBNAIL,
		languages: ['en'],
		// Registration is disabled because unsupported by Wildebeest. Users
		// should go through the login flow and authenticate with Access.
		// The documentation is incorrect and registrations is a boolean.
		registrations: false,
		approval_required: false,
		invites_enabled: false,
		configuration: {
			accounts: {
				max_featured_tags: 10,
			},
			statuses: {
				max_characters: 500,
				max_media_attachments: 4,
				characters_reserved_per_url: 23,
			},
			media_attachments: {
				supported_mime_types: ['image/jpeg', 'image/png', 'image/gif', 'image/heic', 'image/heif', 'image/webp'],
				image_size_limit: 16 * 1024 * 1024, // 16 MB
				image_matrix_limit: 7680 * 4320, // 8K
				video_size_limit: 0,
				video_frame_rate_limit: 0,
				video_matrix_limit: 0,
			},
			polls: {
				max_options: 4,
				max_characters_per_option: 50,
				min_expiration: 5 * 60, // 5 minutes
				max_expiration: 2629746, // almost a month
			},
		},
		contact_account: null,
		rules: await getRules(db),
	}

	const actor = await getAdminByEmail(db, env.ADMIN_EMAIL)
	if (actor !== null) {
		res.contact_account = await loadLocalMastodonAccount(db, actor, { ...actorToHandle(actor), domain: null })
	}

	return new Response(JSON.stringify(res), { headers })
}
