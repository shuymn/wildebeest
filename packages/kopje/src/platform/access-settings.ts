// Cloudflare Access settings of the /admin application, stored in instance_settings by /setup (or by hand). The
// /admin application is its own Access app (its policy also admits the CLI's service token), so it has its own AUD
// next to /oauth/authorize's access_aud; the team, and so the issuer and key set, is shared.
//   access_team_domain               <team>.cloudflareaccess.com, the same row as domain/oauth.ts ACCESS_TEAM_DOMAIN
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

// The Store's configuration: everything the config operation sets. That is the Access rows above (who administers
// the Store), plus domain (actor ids derive from it; domain/setup.ts reads it) and access_aud (the /oauth/authorize
// application; domain/oauth.ts ACCESS_AUD). Configuration is not data: it does not make the Store non-empty for an
// import, an import moves it aside (so the admin keeps authenticating while imported rows land) and afterwards puts
// back exactly these rows (an imported value never replaces them, an absent name stays absent), and a reset keeps
// it. Only the config operation changes it.
export const CONFIG_KEYS: readonly string[] = ['domain', 'access_aud', ...Object.values(ACCESS_SETTINGS)]

export const BOOTSTRAP = { table: 'instance_settings', column: 'name', values: CONFIG_KEYS } as const

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

// Makes the configuration rows exactly `rows`: any other value of these names (an imported one) is removed, and a
// name that was absent stays absent.
export function replaceBootstrapRows(sql: SqlStorage, rows: readonly SettingRow[]): void {
	sql.exec(
		`DELETE FROM instance_settings WHERE name IN (${BOOTSTRAP.values.map(() => '?').join(',')})`,
		...BOOTSTRAP.values
	)
	for (const row of rows) {
		sql.exec('INSERT INTO instance_settings (name, value) VALUES (?, ?)', row.name, row.value)
	}
}

// Admin access works once a team, the /admin AUD and an identity to admit are set. Until then the Store is in
// bootstrap, where IMPORT_TOKEN may configure it and begin an import.
export function adminUsable(settings: AccessSettings): boolean {
	return (
		settings.teamDomain !== null &&
		settings.adminAud !== null &&
		(settings.adminEmail !== null || settings.serviceTokenClientId !== null)
	)
}

export function readConfigRows(sql: SqlStorage): Record<string, string> {
	const rows = sql
		.exec<SettingRow>(
			`SELECT name, value FROM instance_settings WHERE name IN (${CONFIG_KEYS.map(() => '?').join(',')}) ORDER BY name`,
			...CONFIG_KEYS
		)
		.toArray()
	return Object.fromEntries(rows.map((row) => [row.name, row.value]))
}
