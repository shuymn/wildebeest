import { readOperation } from './operation'

// /setup fixes the instance domain first, so its presence marks a set-up instance.
export const getSetupState = readOperation<void, { complete: boolean }>((db) => ({
	complete: db.first("SELECT 1 AS found FROM instance_settings WHERE name = 'domain'") !== undefined,
}))
