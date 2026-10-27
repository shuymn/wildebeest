import type { Context } from 'hono'

import { PRIVATE_HEADERS, PUBLIC_HEADERS } from './web-headers'
import { MAINTENANCE_RETRY_AFTER_SECONDS } from '../mastodon/errors'
import { MessagePage } from '../web/pages/message'
import { STRINGS } from '../web/strings'

// The error pages app.ts answers a browser's page request (pageRequest in negotiation.ts) with, in place of the API's
// answers. Each reads nothing of the Store, which may be what failed, so none shows the site's chrome.

const { errors } = STRINGS

const TEXT = {
	404: [errors.notFoundTitle, errors.notFound],
	500: [errors.serverErrorTitle, errors.serverError],
	503: [errors.unavailableTitle, errors.unavailable],
} as const

export type ErrorStatus = keyof typeof TEXT

// The page of each status; nothing of the error that caused it is shown (a 500 is logged by route, DATA-5).
export function ErrorPage({ status }: { status: ErrorStatus }) {
	const [title, message] = TEXT[status]
	return <MessagePage chrome={null} title={title} message={message} />
}

// 404 is the public pages' ordinary one with their headers; 500 and 503 are never kept, and 503 keeps
// maintenanceError's Retry-After.
const HEADERS = {
	404: PUBLIC_HEADERS,
	500: PRIVATE_HEADERS,
	503: { ...PRIVATE_HEADERS, 'retry-after': String(MAINTENANCE_RETRY_AFTER_SECONDS) },
}

export function errorPage(c: Context, status: ErrorStatus): Response | Promise<Response> {
	return c.html(<ErrorPage status={status} />, status, HEADERS[status])
}
