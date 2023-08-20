import { cors } from 'hono/cors'

export const corsMiddleware = () =>
	cors({
		origin: '*',
		allowHeaders: ['content-type', 'authorization', 'idempotency-key'],
		allowMethods: ['GET', 'PUT', 'POST', 'DELETE', 'PATCH'],
	})
