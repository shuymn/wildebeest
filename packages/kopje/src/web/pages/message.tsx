import type { Child, FC } from 'hono/jsx'

import { Card, LinkButton } from '../components/basics'
import { type Chrome, Layout } from '../components/layout'
import { useUi } from '../ui'

// A page with one message: 404 and 410 of the public pages (the same bytes for every hidden case of a page shape), the
// sign-in, form and OAuth messages, and the error pages of app.ts, which read nothing of the Store (chrome null).
export const MessagePage: FC<{
	chrome: Chrome | null
	title: string
	// A sentence; an account in it is markup (in <strong>).
	message: Child
	link?: { href: string; text: string }
	// More ways on, after the message (an error page's).
	actions?: Child
}> = ({ chrome, title, message, link, actions }) => (
	<Layout title={title} chrome={chrome}>
		<h1>{title}</h1>
		<Card as="section" class="pad">
			<p>{message}</p>
			{link === undefined ? null : (
				<p>
					<LinkButton href={link.href}>{link.text}</LinkButton>
				</p>
			)}
			{actions}
		</Card>
	</Layout>
)

export type ErrorStatus = 404 | 500 | 503

// The one error page: the public pages' 404 (with the site's chrome) and app.ts's Store-free 404, 500 and 503 (without
// it) look the same apart from the chrome's name, whose header and footer give the way on. A 500 or a 503 also offers
// the same URL again.
export const ErrorView: FC<{ chrome: Chrome | null; status: ErrorStatus }> = ({ chrome, status }) => {
	const { m } = useUi()
	const texts: Record<ErrorStatus, [string, string]> = {
		404: [m.errors.notFoundTitle, m.errors.notFound],
		500: [m.errors.serverErrorTitle, m.errors.serverError],
		503: [m.errors.unavailableTitle, m.errors.unavailable],
	}
	const [title, message] = texts[status]
	return (
		<MessagePage
			chrome={chrome}
			title={title}
			message={message}
			actions={
				status === 404 ? undefined : (
					<p class="actions">
						{/* An empty href is the page's own URL. */}
						<LinkButton href="" variant="primary">
							{m.errors.retry}
						</LinkButton>
					</p>
				)
			}
		/>
	)
}
