export const MAINTENANCE_MODES = ['off', 'readonly', 'full'] as const

export type MaintenanceMode = (typeof MAINTENANCE_MODES)[number]
