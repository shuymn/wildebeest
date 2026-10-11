export const MAINTENANCE_MODES = ['off', 'readonly', 'full'] as const

export type MaintenanceMode = (typeof MAINTENANCE_MODES)[number]

export function maxMode(a: MaintenanceMode, b: MaintenanceMode): MaintenanceMode {
	return MAINTENANCE_MODES.indexOf(a) >= MAINTENANCE_MODES.indexOf(b) ? a : b
}
