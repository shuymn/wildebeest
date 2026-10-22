import type { FC } from 'hono/jsx'

import type { Status } from '../../domain/status-presenter'
import type { ParentLink } from '../../domain/web-pages'
import { httpUrl } from '../../platform/http-url'
import { Layout } from '../components/layout'
import { PostCard } from '../components/post'
import { plainText } from '../safe-html'
import { useUi } from '../ui'
import { address, displayName } from '../view/account'
import { postView } from '../view/post'

export type StatusView = { status: Status; parent: ParentLink | null; domain: string }

// /@username/:id: the status, with the author's name as the page's h1 and the parent it replies to when the anonymous
// viewer may see it.
export const StatusPage: FC<StatusView> = ({ status, parent, domain }) => {
	const { m } = useUi()
	const author = status.account
	const title = m.profile.title(displayName(author), address(author, domain))
	const description = status.spoiler_text !== '' ? status.spoiler_text : plainText(status.content ?? '')
	const post = postView(status, parent, domain)
	const image = status.sensitive ? undefined : httpUrl(status.media_attachments[0]?.preview_url ?? null)?.href
	return (
		<Layout
			title={title}
			chrome={{ domain, documents: null }}
			head={
				<>
					<meta name="description" content={description} />
					<meta property="og:site_name" content={domain} />
					<meta property="og:type" content="article" />
					<meta property="og:title" content={title} />
					<meta property="og:description" content={description} />
					<meta property="og:url" content={status.url ?? undefined} />
					{image === undefined ? null : <meta property="og:image" content={image} />}
					<meta property="article:published_time" content={status.created_at} />
					<link rel="canonical" href={status.url ?? undefined} />
					<link rel="alternate" type="application/activity+json" href={status.uri} />
				</>
			}
		>
			<PostCard post={post} variant="focal" />
		</Layout>
	)
}
