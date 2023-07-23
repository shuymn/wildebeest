import { or } from 'wildebeest/backend/src/utils/or'

export function numberParam(
	value: string | null,
	defaultValue: number,
	{ minValue, maxValue }: { minValue?: number; maxValue?: number }
): number {
	return or(value, defaultValue, (value) => {
		let n = Number.parseInt(value)
		n = n < 0 || isNaN(n) ? defaultValue : n
		if (minValue !== undefined) {
			n = Math.min(n, minValue)
		}
		if (maxValue !== undefined) {
			n = Math.max(n, maxValue)
		}
		return n
	})
}

export function boolParam(value: string | null, defaultValue: boolean): boolean {
	return or(value, defaultValue, (value) => {
		return value === 'true'
	})
}
