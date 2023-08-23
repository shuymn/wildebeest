import { cors } from 'hono/cors'

type AllowedMethod = 'GET' | 'PUT' | 'POST' | 'DELETE' | 'PATCH'
type AllowedHeader = 'content-type' | 'authorization' | 'idempotency-key'

type CORSOptions = {
	origin: string | string[] | ((origin: string) => string | undefined | null)
	allowMethods?: AllowedMethod[]
	allowHeaders?: AllowedHeader[]
	maxAge?: number
	credentials?: boolean
	exposeHeaders?: string[]
}

export const corsMiddleware = (
	options: CORSOptions = {
		origin: '*',
		allowHeaders: ['content-type', 'authorization', 'idempotency-key'],
		allowMethods: ['GET', 'PUT', 'POST', 'DELETE', 'PATCH'],
	}
) => cors(options)
