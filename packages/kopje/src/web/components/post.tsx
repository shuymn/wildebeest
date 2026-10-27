import type { Child, FC } from 'hono/jsx'

import { DateTime, LinkTo, Pager, Rich, VisuallyHidden } from './basics'
import { DialogOpener } from './dialog'
import { Icon } from './icon'
import type { IconName } from '../icons'
import { useUi } from '../ui'
import type { AuthorView } from '../view/account'
import type { EmojiRef, Inline } from '../view/emoji'
import type { Link } from '../view/link'
import type { MediaView } from '../view/media'
import type { PagerLinks } from '../view/pager'
import type { PollView } from '../view/poll'
import type { CountKind, CountView, PostView, QuoteView, StubView } from '../view/post'

// Accounts and posts (design §11). Avatars are decorative; their boxes match their CSS size (§13).

type AvatarSize = 40 | 44 | 48 | 88

export const Avatar: FC<{ src: string | null; size: AvatarSize; eager?: boolean }> = ({ src, size, eager = false }) =>
	src === null ? (
		<span class={`av av${size}`} aria-hidden="true" />
	) : (
		<img
			class={`av av${size}`}
			src={src}
			alt=""
			width={size}
			height={size}
			loading={eager ? undefined : 'lazy'}
			decoding="async"
		/>
	)

// A custom emoji (design §11): its shortcode as its text, at the 20 px its box takes (§13). Its markup is emojiHtml's,
// which the allowance charges (view/emoji.ts).
export const Emoji: FC<{ emoji: EmojiRef }> = ({ emoji }) => (
	<img
		class="emoji"
		src={emoji.url}
		alt={`:${emoji.shortcode}:`}
		width={20}
		height={20}
		loading="lazy"
		decoding="async"
	/>
)

export const InlineText: FC<{ text: Inline[] }> = ({ text }) => (
	<>{text.map((part) => (typeof part === 'string' ? part : <Emoji emoji={part} />))}</>
)

// An account's name, address and, for a post, its date (a link to the post when it has one).
export const Who: FC<{
	account: AuthorView
	size: 40 | 44 | 48
	heading?: 'h1'
	when?: { iso: string; text: string; link: Link | null; edited: boolean }
}> = ({ account, size, heading, when }) => {
	const { m } = useUi()
	const name = <InlineText text={account.name} />
	const date = when === undefined ? null : <DateTime iso={when.iso} text={when.text} local />
	return (
		<div class="who">
			{/* The focal post's author avatar is above the fold: eager (amendment A7). */}
			<Avatar src={account.avatar} size={size} eager={heading === 'h1'} />
			<div class="id">
				{heading === 'h1' ? (
					<h1 class="name">{account.link === null ? name : <LinkTo link={account.link}>{name}</LinkTo>}</h1>
				) : account.link === null ? (
					<span class="name">{name}</span>
				) : (
					<LinkTo class="name" link={account.link}>
						{name}
					</LinkTo>
				)}
				<p class="meta">
					<span class="handle">{account.address}</span>
					{when === undefined ? null : (
						<>
							{' · '}
							{when.link === null ? date : <LinkTo link={when.link}>{date}</LinkTo>}
							{when.edited ? (
								<>
									{' · '}
									{m.post.edited}
								</>
							) : null}
						</>
					)}
				</p>
			</div>
		</div>
	)
}

// The state cue of a summary: Show while closed, Hide while open (the stylesheet hides the other).
const Disclosure: FC = () => {
	const { m } = useUi()
	return (
		<>
			<span class="show">{m.post.show}</span>
			<span class="hide">{m.post.hide}</span>
		</>
	)
}

export const ContentWarning: FC<{ text: Inline[]; lang?: string; children?: Child }> = ({ text, lang, children }) => {
	return (
		<details class="cw">
			<summary>
				<span class="spoiler" lang={lang}>
					<Icon name="cw" size={16} decorative />
					<InlineText text={text} />
				</span>
				<Disclosure />
			</summary>
			{children}
		</details>
	)
}

// The media of a post by type (design §11, "Media by type"; amendments A3 and A7). `lcp`: its first image is the
// page's likely largest paint, loaded first (§13); every other image is lazy. Video and audio load nothing before the
// reader plays them (preload="none", no autoplay); a video's poster is its own preview only, and a gifv loops muted
// with its controls. `playback` false (a page whose CSP allows no media) shows video and audio as links instead.
export const MediaGrid: FC<{ items: MediaView[]; sensitive: boolean; lcp: boolean; playback: boolean }> = ({
	items,
	sensitive,
	lcp,
	playback,
}) => {
	const { m } = useUi()
	if (items.length === 0) {
		return null
	}
	const missing = (item: MediaView) => (item.alt === '' ? <span>{m.media.noDescription}</span> : null)
	const grid = (
		<div class="media-grid">
			{items.map((item, index) => {
				const first = lcp && !sensitive && index === 0
				const box = item.width === undefined ? 'box' : undefined
				const label = item.alt === '' ? undefined : item.alt
				if (item.kind === 'image') {
					return (
						<a class="media-item" href={item.full}>
							<img
								class={box}
								src={item.preview ?? item.full}
								alt={item.alt}
								width={item.width}
								height={item.height}
								loading={first ? undefined : 'lazy'}
								fetchpriority={first ? 'high' : undefined}
								decoding="async"
							/>
							{missing(item)}
						</a>
					)
				}
				if (playback && (item.kind === 'video' || item.kind === 'gifv')) {
					const gifv = item.kind === 'gifv'
					return (
						<div class="media-item">
							<video
								class={box}
								src={item.full}
								poster={item.preview ?? undefined}
								width={item.width}
								height={item.height}
								controls
								playsinline
								preload="none"
								muted={gifv}
								loop={gifv}
								aria-label={label}
							/>
							{missing(item)}
						</div>
					)
				}
				if (playback && item.kind === 'audio') {
					return (
						<div class="media-item">
							<audio src={item.full} controls preload="none" aria-label={label} />
							{missing(item)}
						</div>
					)
				}
				return item.link === null ? null : (
					<LinkTo class="media-file" link={item.link}>
						<Icon name="media" size={18} decorative />
						{item.alt === '' ? m.media.attachment : item.alt}
					</LinkTo>
				)
			})}
		</div>
	)
	return sensitive ? (
		<details class="sensitive">
			<summary>
				<span>{m.post.sensitiveMedia}</span>
				<Disclosure />
			</summary>
			{grid}
		</details>
	) : (
		grid
	)
}

// A poll (design §11, POLL-2): each choice with its share as text and an SVG bar once the counts are shown, then how
// many took part and when it ends or that it has. No inline style: the bar's width is the SVG rect's.
export const Poll: FC<{ poll: PollView; lang?: string }> = ({ poll, lang }) => {
	const { m, f } = useUi()
	return (
		<div class="poll">
			<ul class="opts" role="list">
				{poll.options.map((option) => (
					<li>
						<span class="row">
							<span lang={lang}>
								<InlineText text={option.title} />
							</span>
							{option.share === null ? null : <span>{f.percent(option.share.ratio)}</span>}
						</span>
						{option.share === null ? null : (
							<svg class="track" width="100%" height="8" aria-hidden="true" focusable="false">
								<rect
									class={option.share.leading ? 'lead' : undefined}
									width={`${Math.round(option.share.ratio * 1000) / 10}%`}
									height="8"
									rx="4"
								/>
							</svg>
						)}
					</li>
				))}
			</ul>
			<p class="meta">
				<Icon name="poll" size={14} decorative />
				{poll.turnout.voters ? m.poll.people(poll.turnout.n) : m.poll.votes(poll.turnout.n)}
				{poll.expired ? (
					<>
						{' · '}
						{m.poll.closed}
					</>
				) : poll.expiresAt === null ? null : (
					<>
						{' · '}
						{m.poll.ends} <DateTime iso={poll.expiresAt} text={f.instant(poll.expiresAt)} local />
					</>
				)}
			</p>
		</div>
	)
}

// The post a post quotes (design §11): nested, with its author, date, content, media and poll, or its state as text
// (R35: the presenter embeds only a post the viewer may see by itself).
export const Quote: FC<{ quote: QuoteView; playback: boolean }> = ({ quote, playback }) => {
	const { m, f } = useUi()
	if (quote.state !== 'accepted') {
		return (
			<p class="gone">
				<Icon name="quote" size={16} decorative />
				{m.quote[quote.state]}
			</p>
		)
	}
	const { post } = quote
	return (
		<div class="quote">
			<Who
				account={post.author}
				size={40}
				when={{ iso: post.createdAt, text: f.instant(post.createdAt), link: post.link, edited: post.editedAt !== null }}
			/>
			<PostBody post={post} lcp={false} playback={playback} />
		</div>
	)
}

// A quoting post's content hides its fallback line (`RE: <link>`, class quote-inline), as clients that show the quote
// do.
export const PostBody: FC<{ post: PostView; lcp: boolean; playback: boolean }> = ({ post, lcp, playback }) => {
	const content = (
		<>
			<Rich class={post.quote === null ? 'body' : 'body quoting'} html={post.html} lang={post.lang} />
			<MediaGrid items={post.media} sensitive={post.sensitive} lcp={lcp && post.cw.length === 0} playback={playback} />
			{post.poll === null ? null : <Poll poll={post.poll} lang={post.lang} />}
			{post.quote === null ? null : <Quote quote={post.quote} playback={playback} />}
		</>
	)
	// The content warning hides the content until the reader opens it, with no script.
	return post.cw.length === 0 ? (
		content
	) : (
		<ContentWarning text={post.cw} lang={post.lang}>
			{content}
		</ContentWarning>
	)
}

const COUNT_ICONS: Record<CountKind, IconName> = {
	replies: 'reply',
	boosts: 'boost',
	favourites: 'fav',
	quotes: 'quote',
}

// A linked count is named by its label, which contains the visible number; an unlinked one shows the number to sight
// and the label to assistive technology (§14.6).
export const Counts: FC<{ items: CountView[] }> = ({ items }) => {
	const { m, f } = useUi()
	return (
		<div class="counts">
			{items.map((item) => {
				const label = m.counts[item.kind](item.n)
				const icon = <Icon name={COUNT_ICONS[item.kind]} size={18} decorative />
				return item.href === undefined ? (
					<span>
						{icon}
						<span aria-hidden="true">{f.count(item.n)}</span>
						<VisuallyHidden>{label}</VisuallyHidden>
					</span>
				) : (
					<a href={item.href} aria-label={label}>
						{icon}
						{f.count(item.n)}
					</a>
				)
			})}
		</div>
	)
}

// `playback`: whether the page's CSP lets media play (media-src, design §5); every public page's and the embed's does.
// `history`: the id of the page's edit-history dialog, which the focal post's "Edited" opens (design §8); without
// one, "Edited" is text. `actions`: the focal post's further controls, after its date (the status page's dialogs).
export const PostCard: FC<{
	post: PostView
	variant: 'feed' | 'focal' | 'embed'
	label?: { icon: IconName; text: Child }
	playback?: boolean
	history?: string
	actions?: Child[]
}> = ({ post, variant, label, playback = true, history, actions = [] }) => {
	const { m, f } = useUi()
	const focal = variant === 'focal'
	const edited = post.editedAt !== null
	return (
		<article class={focal ? 'card post focal' : 'card post'}>
			{label === undefined ? null : (
				<p class="label">
					<Icon name={label.icon} size={16} decorative />
					{label.text}
				</p>
			)}
			<Who
				account={post.author}
				size={focal ? 48 : 44}
				heading={focal ? 'h1' : undefined}
				when={focal ? undefined : { iso: post.createdAt, text: f.instant(post.createdAt), link: post.link, edited }}
			/>
			{post.replyTo === null ? null : (
				<p class="reply-to">
					<Icon name="reply" size={16} decorative />
					{m.post.inReplyTo} <LinkTo link={post.replyTo.link}>@{post.replyTo.acct}</LinkTo>
				</p>
			)}
			<PostBody post={post} lcp={focal} playback={playback} />
			{focal ? (
				<p class="meta">
					<DateTime iso={post.createdAt} text={f.instant(post.createdAt)} local />
					{edited ? (
						<>
							{' · '}
							{history === undefined ? (
								m.post.edited
							) : (
								<DialogOpener dialog={history} class="btn quiet">
									<Icon name="edit" size={14} decorative />
									{m.post.edited}
								</DialogOpener>
							)}
						</>
					) : null}
					{actions.map((action) => (
						<>
							{' · '}
							{action}
						</>
					))}
				</p>
			) : null}
			{variant === 'embed' ? (
				post.link === null ? null : (
					<p class="meta">
						<LinkTo link={post.link}>{m.post.viewOn(post.link.host)}</LinkTo>
					</p>
				)
			) : (
				<Counts items={post.counts} />
			)}
		</article>
	)
}

// A post too large to show on its page (design §2): a compact row of its author's address, its date and "Open", both
// linking to it.
export const PostStub: FC<{ stub: StubView }> = ({ stub }) => {
	const { m, f } = useUi()
	const date = stub.createdAt === null ? null : <DateTime iso={stub.createdAt} text={f.instant(stub.createdAt)} local />
	const parts: Child[] = [
		...(stub.address === null ? [] : [<span class="handle">{stub.address}</span>]),
		...(date === null ? [] : [stub.link === null ? date : <LinkTo link={stub.link}>{date}</LinkTo>]),
		...(stub.link === null ? [] : [<LinkTo link={stub.link}>{m.post.open}</LinkTo>]),
	]
	return (
		<article class="card post">
			<p class="meta">{parts.flatMap((part, i) => (i === 0 ? [part] : [' · ', part]))}</p>
		</article>
	)
}

// A paged list of posts (design §4): its items, each an <li>, then its pager. An empty page that links on shows only its
// pager; the empty line shows only when no page lies either way. The pager's first link goes back (newer posts, or
// earlier replies on an oldest-first list), its second on, with `texts` naming them.
export const PostFeed: FC<{
	empty: boolean
	emptyText: string
	pager: PagerLinks
	texts?: { newer: string; older: string }
	children?: Child
}> = ({ empty, emptyText, pager, texts, children }) => {
	const { m } = useUi()
	return (
		<>
			{empty ? (
				pager.newer === null && pager.older === null ? (
					<p class="empty">{emptyText}</p>
				) : null
			) : (
				<ul class="feed" role="list">
					{children}
				</ul>
			)}
			<Pager
				label={m.a11y.pages}
				newer={pager.newer}
				older={pager.older}
				newerText={texts?.newer ?? m.pager.newer}
				olderText={texts?.older ?? m.pager.older}
			/>
		</>
	)
}

// The posts above a status on its page (design §11, ThreadUp): its ancestors, oldest first, as a named ordered list;
// nothing when there are none.
export const ThreadUp: FC<{ posts: PostView[] }> = ({ posts }) => {
	const { m } = useUi()
	return posts.length === 0 ? null : (
		<ol class="feed thread" role="list" aria-label={m.a11y.thread}>
			{posts.map((post) => (
				<li>
					<PostCard post={post} variant="feed" />
				</li>
			))}
		</ol>
	)
}
