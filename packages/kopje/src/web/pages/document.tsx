import type { FC } from 'hono/jsx'

import type { Site } from '../../domain/web-pages/site'
import { Card, DateTime, Rich } from '../components/basics'
import { Layout } from '../components/layout'
import { sanitized } from '../safe-html'
import { useUi } from '../ui'

export type DocumentView = {
	title: string
	site: Site
	path: string
	// The document as stored, sanitized here at the sink (HTML-1).
	html: string
	// The privacy policy's stamp (an instant), or the terms of service's effective date (a calendar date).
	updatedAt: string | null
	effectiveDate: string | null
}

// /privacy-policy, /terms-of-service and /terms-of-service/:date (Mastodon's paths, config/routes.rb:230-232): the
// document an instance endpoint serves, with its effective date or the time it was last changed.
export const DocumentPage: FC<DocumentView> = ({ title, site, path, html, updatedAt, effectiveDate }) => {
	const { m, f } = useUi()
	return (
		<Layout title={title} chrome={site} head={<link rel="canonical" href={`https://${site.domain}${path}`} />}>
			<Card as="article" class="pad">
				<h1>{title}</h1>
				{effectiveDate === null ? null : (
					<p class="date">
						{m.documents.effectiveFrom}{' '}
						<DateTime iso={effectiveDate} text={f.calendarDate(effectiveDate)} local={false} />
					</p>
				)}
				{updatedAt === null ? null : (
					<p class="date">
						{m.documents.lastUpdated} <DateTime iso={updatedAt} text={f.instant(updatedAt)} local />
					</p>
				)}
				<Rich class="body document" html={sanitized(html)} />
			</Card>
		</Layout>
	)
}
