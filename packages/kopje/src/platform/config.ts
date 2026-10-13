import { z } from 'zod'

import { MAINTENANCE_MODES } from './maintenance'
import { vapidPublicKey } from './vapid'

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
	// The KEK that wraps local private keys. Unset reads as the empty string, which is a legal KEK (healthReport warns).
	USER_KEK: z.string().optional(),
	// Images transformations uploads may reserve per UTC month (two per upload). The default stays under the 5,000 the
	// Images free plan includes; an operator with paid transformations raises it in the dashboard.
	IMAGES_MONTHLY_TRANSFORMS: z.coerce.number().int().min(0).default(4000),
	// Each local account's share of it per month, so one account cannot lock the others out. Unset: a tenth of
	// IMAGES_MONTHLY_TRANSFORMS (accountMonthlyTransforms).
	IMAGES_ACCOUNT_MONTHLY_TRANSFORMS: z.coerce.number().int().min(0).optional(),
	// Rolling a cutover back (docs/cutover-runbook.md): 'journal' makes the Queue consumer keep every spooled inbox
	// request in the Store's rollback journal, for `kopje-admin cutover drain` to hand to the legacy instance.
	CUTOVER_ROLLBACK: z.enum(['journal']).optional(),
	// Lower quotas for the rollback journal than the Store's own maxima (platform/store-admin.ts).
	CUTOVER_JOURNAL_MAX_ENTRIES: z.coerce.number().int().min(1).optional(),
	CUTOVER_JOURNAL_MAX_BYTES: z.coerce.number().int().min(1).optional(),
	// For that drain only: the legacy instance's VAPID_JWK, which its inbox messages carry.
	LEGACY_VAPID_JWK: z.string().min(1).optional(),
	// Set after /setup generates it; Web Push stays unavailable until then.
	VAPID_JWK: z
		.string()
		.refine((value) => vapidPublicKey(value) !== null, 'must be an EC P-256 JWK')
		.optional(),
})

export type Config = z.infer<typeof configSchema>

// The effective KEK: an unset USER_KEK reads as the empty string, which is a legal KEK.
export function userKek(config: Config): string {
	return config.USER_KEK ?? ''
}

// The default share is a tenth of the instance budget: Kopje serves up to about ten local accounts.
export const ACCOUNT_SHARE_DIVISOR = 10

export function accountMonthlyTransforms(config: Config): number {
	return (
		config.IMAGES_ACCOUNT_MONTHLY_TRANSFORMS ?? Math.floor(config.IMAGES_MONTHLY_TRANSFORMS / ACCOUNT_SHARE_DIVISOR)
	)
}

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
