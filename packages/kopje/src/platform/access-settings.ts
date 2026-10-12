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

// No schema yet means nothing is configured.
export function readAccessSettings(sql: SqlStorage): AccessSettings {
	return settingsFromRows(readBootstrapRows(sql))
}

// The Access rows are configuration of this Store, not data: they do not make it non-empty for an import, an import
// moves them aside (so they keep authorizing the admin while imported rows land), and a reset keeps them.
export const BOOTSTRAP = {
	table: 'instance_settings',
	column: 'name',
	values: Object.values(ACCESS_SETTINGS) as readonly string[],
} as const

export type SettingRow = { name: string; value: string }

export function readBootstrapRows(sql: SqlStorage): SettingRow[] {
	try {
		return sql
			.exec<SettingRow>(
				`SELECT name, value FROM instance_settings WHERE name IN (${BOOTSTRAP.values.map(() => '?').join(',')}) ORDER BY name`,
				...BOOTSTRAP.values
			)
			.toArray()
	} catch {
		return []
	}
}

export function settingsFromRows(rows: readonly SettingRow[]): AccessSettings {
	const settings: AccessSettings = { teamDomain: null, adminAud: null, adminEmail: null, serviceTokenClientId: null }
	for (const [key, name] of Object.entries(ACCESS_SETTINGS) as [keyof AccessSettings, string][]) {
		const value = rows.find((row) => row.name === name)?.value.trim()
		settings[key] = value === undefined || value === '' ? null : value
	}
	return settings
}

// Writes bootstrap rows back where the table has no row of that name (imported values win).
export function restoreBootstrapRows(sql: SqlStorage, rows: readonly SettingRow[]): void {
	for (const row of rows) {
		sql.exec('INSERT OR IGNORE INTO instance_settings (name, value) VALUES (?, ?)', row.name, row.value)
	}
}

export function accessConfigured(settings: AccessSettings): boolean {
	return Object.values(settings).some((value) => value !== null)
}
