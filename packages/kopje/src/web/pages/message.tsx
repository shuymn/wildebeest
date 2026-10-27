import type { FC } from 'hono/jsx'

import { Card, LinkButton } from '../components/basics'
import { type Chrome, Layout } from '../components/layout'

// A page with one message: 404 and 410 of the public pages (the same bytes for every hidden case of a page shape), the
// sign-in, form and OAuth messages, and the error pages of app.ts, which read nothing of the Store (chrome null).
export const MessagePage: FC<{
	chrome: Chrome | null
	title: string
	message: string
	link?: { href: string; text: string }
}> = ({ chrome, title, message, link }) => (
	<Layout title={title} chrome={chrome}>
		<Card as="section" class="pad">
			<h1>{title}</h1>
			<p>{message}</p>
			{link === undefined ? null : (
				<p>
					<LinkButton href={link.href}>{link.text}</LinkButton>
				</p>
			)}
		</Card>
	</Layout>
)
