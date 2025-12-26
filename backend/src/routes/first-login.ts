// Screen after the first login to let the user configure the account (username
// especially)
import { parse } from 'cookie'
import { Hono } from 'hono'
import { z } from 'zod'

import * as access from '@wildebeest/backend/access'
import { createUser } from '@wildebeest/backend/accounts'
import { type Database, getDatabase } from '@wildebeest/backend/database'
import * as errors from '@wildebeest/backend/errors'
import type { HonoEnv } from '@wildebeest/backend/types'
import { getJwtEmail } from '@wildebeest/backend/utils/auth/getJwtEmail'

const schema = z.object({
	username: z.string().min(1).max(30).nonempty(),
	name: z.string().min(1).max(30).nonempty(),
})

const app = new Hono<HonoEnv>()

app.post(async ({ req: { raw: request }, env }) => {
	return handlePostRequest(request, getDatabase(env), env.userKEK, env.ACCESS_AUTH_DOMAIN, env.ACCESS_AUD)
})

async function handlePostRequest(
	request: Request,
	db: Database,
	userKEK: string,
	accessDomain: string,
	accessAud: string
): Promise<Response> {
	const url = new URL(request.url)
	const cookie = parse(request.headers.get('Cookie') || '')
	let email = ''
	const jwt = cookie['CF_Authorization']
	try {
		email = getJwtEmail(jwt ?? '')
	} catch (e) {
		return errors.notAuthorized((e as Error)?.message)
	}

	await access.generateValidator({
		jwt,
		domain: accessDomain,
		aud: accessAud,
	})(request)

	const domain = url.hostname

	const formData = await request.formData()

	let username: string | null = null
	if (formData.has('username')) {
		username = formData.get('username')
	}

	let name: string | null = null
	if (formData.has('name')) {
		name = formData.get('name')
	}

	const result = schema.safeParse({ username, name })
	if (!result.success) {
		return new Response('', { status: 400 })
	}

	if (!url.searchParams.has('redirect_uri')) {
		return new Response('', { status: 400 })
	}

	await createUser({ domain, db, userKEK, email, preferredUsername: result.data.username, name: result.data.name })

	let redirect_uri = decodeURIComponent(url.searchParams.get('redirect_uri') || '')
	if (redirect_uri.startsWith('/')) {
		// URL is a relative URL, prepend the domain to it.
		redirect_uri = 'https://' + url.hostname + redirect_uri
	}
	return Response.redirect(redirect_uri, 302)
}

export default app
