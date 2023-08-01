import * as myz from './zod'

export { myz }
export * from './cors'
export * from './http'

export function isUUID(str: string): boolean {
	return /^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(str)
}

export function unique<T>(arr: T[]): T[] {
	return [...new Set(arr)]
}
