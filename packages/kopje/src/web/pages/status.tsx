import type { FC } from 'hono/jsx'

import type { Status } from '../../domain/status-presenter'
import type { ParentLink } from '../../domain/web-pages/parents'
import type { Site } from '../../domain/web-pages/site'
import type { PageHistory } from '../../domain/web-pages/status'
import { HISTORY_DIALOG, HistoryDialog } from '../components/history'
import { Layout } from '../components/layout'
import { PostCard } from '../components/post'
import { plainText, shortText } from '../safe-html'
import { useUi } from '../ui'
import { address, displayName } from '../view/account'
import { emojiAllowance } from '../view/emoji'
import { historyView } from '../view/history'
import { shownImage } from '../view/media'
import { likelyLcp, postView } from '../view/post'

export type StatusView = { status: Status; parent: ParentLink | null; history: PageHistory | null; site: Site }

// /@username/:id: the status, with the author's name as the page's h1 and the parent it replies to when the anonymous
// viewer may see it. The page's likely largest paint (design §13, amendment A7) is the post's first attachment when
// nothing covers it: an image is loaded first by its own element (MediaGrid), and a video's or gifv's poster, when it
// has a real one (A3), by a preload in the head; either is the page's one high-priority request. An edited status with
// recorded versions has its history in a dialog after the post, which the post's "Edited" opens (design §8).
export const StatusPage: FC<StatusView> = ({ status, parent, history, site }) => {
	const { m } = useUi()
	const { domain } = site
	const author = status.account
	const title = m.profile.title(displayName(author), address(author, domain))
	// Bounded as a description, the warning as the content: the page holds it twice more in its head.
	const description = status.spoiler_text !== '' ? shortText(status.spoiler_text) : plainText(status.content ?? '')
	const allowance = emojiAllowance()
	const post = postView(status, parent, domain, allowance)
	// The dialog follows the post, so its emoji come after the post's (document order, design §2).
	const versions = history === null || status.edited_at === null ? null : historyView(history, domain, allowance)
	const first = post.media[0]
	const image = status.sensitive || first === undefined ? null : shownImage(first)
	const lcp = likelyLcp(post)
	const poster = lcp !== null && (lcp.kind === 'video' || lcp.kind === 'gifv') ? lcp.preview : null
	return (
		<Layout
			title={title}
			chrome={site}
			head={
				<>
					<meta name="description" content={description} />
					<meta property="og:site_name" content={domain} />
					<meta property="og:type" content="article" />
					<meta property="og:title" content={title} />
					<meta property="og:description" content={description} />
					<meta property="og:url" content={status.url ?? undefined} />
					{image === null ? null : <meta property="og:image" content={image} />}
					{poster === null ? null : <link rel="preload" as="image" href={poster} fetchpriority="high" />}
					<meta property="article:published_time" content={status.created_at} />
					<link rel="canonical" href={status.url ?? undefined} />
					<link rel="alternate" type="application/activity+json" href={status.uri} />
				</>
			}
		>
			<PostCard post={post} variant="focal" history={versions === null ? undefined : HISTORY_DIALOG} />
			{versions === null ? null : <HistoryDialog history={versions} />}
		</Layout>
	)
}
