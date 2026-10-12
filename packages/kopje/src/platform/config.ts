import { z } from 'zod'

import { MAINTENANCE_MODES } from './maintenance'

function binding<T>(name: string) {
	return z.custom<T>((value) => typeof value === 'object' && value !== null, `binding ${name} is missing`)
}

// Bindings come from wrangler.jsonc (typed by `wrangler types`). MAINTENANCE and the secrets are set outside the
// config file, so they are validated here instead. MAINTENANCE lives outside the Store because PITR rewinds it.
const configSchema = z.object({
	STORE: binding<Env['STORE']>('STORE'),
	QUEUE: binding<Env['QUEUE']>('QUEUE'),
	MEDIA: binding<Env['MEDIA']>('MEDIA'),
	IMAGES: binding<Env['IMAGES']>('IMAGES'),
	ASSETS: binding<Env['ASSETS']>('ASSETS'),
	CF_VERSION_METADATA: binding<Env['CF_VERSION_METADATA']>('CF_VERSION_METADATA'),
	MAINTENANCE: z.enum(MAINTENANCE_MODES).default('off'),
	SETUP_TOKEN: z.string().min(1).optional(),
	// One-time secret for the cutover import into an empty Store (app/admin.ts); removed after the import.
	IMPORT_TOKEN: z.string().min(1).optional(),
})

export type Config = z.infer<typeof configSchema>

export type ConfigResult = { ok: true; config: Config } | { ok: false; issues: string[] }

const parsed = new WeakMap<object, ConfigResult>()

// Validates env once per env object. Issues name the field and the problem, never the value.
export function readConfig(env: object): ConfigResult {
	let result = parsed.get(env)
	if (result === undefined) {
		const parse = configSchema.safeParse(env)
		result = parse.success
			? { ok: true, config: parse.data }
			: { ok: false, issues: parse.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`) }
		parsed.set(env, result)
	}
	return result
}
