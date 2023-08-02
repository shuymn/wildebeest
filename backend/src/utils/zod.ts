import { z } from 'zod'

const emptyString = z.literal('').transform(() => undefined)

export function logical() {
	return z.preprocess((value) => {
		const result = z
			.union([emptyString, z.string().transform((value) => value === 'true' || value === '1')])
			.safeParse(value)
		return result.success ? result.data : value
	}, z.boolean()) as z.ZodEffects<z.ZodBoolean, boolean, boolean>
}

export function numeric() {
	return z.preprocess((value) => {
		const result = z
			.union([
				emptyString,
				z
					.string()
					.transform(Number)
					.refine((value) => !isNaN(value)),
			])
			.safeParse(value)
		return result.success ? result.data : value
	}, z.number()) as z.ZodEffects<z.ZodNumber, number, number>
}
