import type { Db } from '../db/sql'
import { ACCESS_SETTINGS, accessRefusal, settingsFromRows, type SettingRow } from '../platform/access-settings'
import type { ImportAuthority } from '../platform/store-admin'

// The Access admin, checked against the saved configuration, as the Worker verified it, in the transaction of an admin
// operation that writes (the media rebuild, the key rewrap). IMPORT_TOKEN and import sessions are refused with
// `refusal`: these operations run through Access only. null when the admin may go on.
export function accessAdminRefusal(db: Db, authority: ImportAuthority, refusal: string): string | null {
	if (authority.kind !== 'access') {
		return refusal
	}
	const names = Object.values(ACCESS_SETTINGS)
	const rows = db.all<SettingRow>(
		`SELECT name, value FROM instance_settings WHERE name IN (${names.map(() => '?').join(',')})`,
		...names
	)
	return accessRefusal(settingsFromRows(rows), authority)
}
