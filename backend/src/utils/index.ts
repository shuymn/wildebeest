import { SingleOrArray } from './type'
import * as myz from './zod'

export { myz }
export * from './cors'
export * from './file'
export * from './http'
export { createApp } from './hono'

export function isUUID(str: string): boolean {
	return /^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(str)
}

export function unique<T>(arr: T[]): T[] {
	return [...new Set(arr)]
}

export function toArray<T>(v: SingleOrArray<T>): T[] {
	return Array.isArray(v) ? v : [v]
}
