// Cloudflare Access settings of the /admin application, stored in instance_settings by /setup (or by hand).
//   access_team_domain               <team>.cloudflareaccess.com (issuer and JWKS host)
//   access_admin_aud                 AUD tag of the Access application that protects /admin/*
//   admin_email                      the admin's Access identity
//   access_service_token_client_id   client id of the admin CLI's service token (the JWT's common_name)
export const ACCESS_SETTINGS = {
	teamDomain: 'access_team_domain',
	adminAud: 'access_admin_aud',
	adminEmail: 'admin_email',
	serviceTokenClientId: 'access_service_token_client_id',
} as const

export type AccessSettings = { -readonly [K in keyof typeof ACCESS_SETTINGS]: string | null }

export function readAccessSettings(sql: SqlStorage): AccessSettings {
	const settings: AccessSettings = { teamDomain: null, adminAud: null, adminEmail: null, serviceTokenClientId: null }
	let rows: { name: string; value: string }[]
	try {
		rows = sql
			.exec<{ name: string; value: string }>(
				`SELECT name, value FROM instance_settings WHERE name IN (${Object.values(ACCESS_SETTINGS)
					.map(() => '?')
					.join(',')})`,
				...Object.values(ACCESS_SETTINGS)
			)
			.toArray()
	} catch {
		// No schema yet: nothing is configured.
		return settings
	}
	for (const [key, name] of Object.entries(ACCESS_SETTINGS) as [keyof AccessSettings, string][]) {
		const value = rows.find((row) => row.name === name)?.value.trim()
		settings[key] = value === undefined || value === '' ? null : value
	}
	return settings
}

export function accessConfigured(settings: AccessSettings): boolean {
	return Object.values(settings).some((value) => value !== null)
}
