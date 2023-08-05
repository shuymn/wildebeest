// Screen after the first login to let the user configure the account (username
// especially)
import { parse } from 'cookie'
import * as access from 'wildebeest/backend/src/access'
import { createUser } from 'wildebeest/backend/src/accounts'
import { type Database, getDatabase } from 'wildebeest/backend/src/database'
import * as errors from 'wildebeest/backend/src/errors'
import type { ContextData, Env } from 'wildebeest/backend/src/types'
import { getJwtEmail } from 'wildebeest/backend/src/utils/auth/getJwtEmail'
import { z } from 'zod'

const schema = z.object({
	username: z.string().min(1).max(30).nonempty(),
	name: z.string().min(1).max(30).nonempty(),
})

export const onRequestPost: PagesFunction<Env, any, ContextData> = async ({ request, env }) => {
	return handlePostRequest(request, await getDatabase(env), env.userKEK, env.ACCESS_AUTH_DOMAIN, env.ACCESS_AUD)
}

export async function handlePostRequest(
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
		username = formData.get('username') as string | null
	}

	let name: string | null = null
	if (formData.has('name')) {
		name = formData.get('name') as string | null
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
