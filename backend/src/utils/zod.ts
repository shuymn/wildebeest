import { z } from 'zod'

export function logical() {
	return z.string().transform((value) => value === 'true')
}

export function numeric() {
	return z
		.string()
		.transform(Number)
		.refine((value) => !isNaN(value))
}
