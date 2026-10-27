import { type Child, type FC, jsx } from 'hono/jsx'

import { Icon } from './icon'
import type { IconName } from '../icons'
import type { SafeHtml } from '../safe-html'
import { useUi } from '../ui'
import type { Link } from '../view/link'

// The small parts every page shares (design §11).

// Stored HTML, sanitized at its sink (SafeHtml, HTML-1), with the content's language when known.
export const Rich: FC<{ html: SafeHtml; class: string; lang?: string }> = ({ html, class: className, lang }) => (
	<div class={className} lang={lang} dangerouslySetInnerHTML={{ __html: html.html }} />
)

// An instant carries data-local (rewritten to the viewer's zone by the L1 bundle, design §7.6); a calendar date never.
// true is the compact shape, 'full' and 'deadline' the exceptions (src/client/local-time.ts).
export const DateTime: FC<{ iso: string; text: string; local: boolean | 'full' | 'deadline' }> = ({
	iso,
	text,
	local,
}) => (
	<time datetime={iso} data-local={local === false ? undefined : local === true ? '' : local}>
		{text}
	</time>
)

export const VisuallyHidden: FC<{ children?: Child }> = ({ children }) => <span class="vh">{children}</span>

export const Card: FC<{
	as?: 'section' | 'article' | 'div' | 'ol' | 'dl'
	class?: string
	role?: 'list'
	children?: Child
}> = ({ as = 'div', class: className, role, children }) =>
	jsx(as, { class: className === undefined ? 'card' : `card ${className}`, role }, children)

// A link to a Link: one on another host opens nothing of this site's and says where it goes (§1, "Remote links").
export const LinkTo: FC<{ link: Link; class?: string; children?: Child }> = ({ link, class: className, children }) => {
	const { m } = useUi()
	return link.external ? (
		<a class={className} href={link.href} rel="nofollow noopener">
			{children}
			<Icon name="ext" size={14} label={m.a11y.openOn(link.host)} />
		</a>
	) : (
		<a class={className} href={link.href}>
			{children}
		</a>
	)
}

type ButtonVariant = 'primary' | 'default' | 'quiet'

export const LinkButton: FC<{ href: string; variant?: ButtonVariant; icon?: IconName; children?: Child }> = ({
	href,
	variant = 'default',
	icon,
	children,
}) => (
	<a class={variant === 'default' ? 'btn' : `btn ${variant}`} href={href}>
		{icon === undefined ? null : <Icon name={icon} size={18} decorative />}
		{children}
	</a>
)

// A link that is not offered: not focusable, not a control (§4).
export const OffButton: FC<{ icon?: IconName; children?: Child }> = ({ icon, children }) => (
	<span class="btn off">
		{icon === undefined ? null : <Icon name={icon} size={18} decorative />}
		{children}
	</span>
)

// Newer and older pages; nothing when neither is offered.
export const Pager: FC<{
	label: string
	newer: string | null
	older: string | null
	newerText: string
	olderText: string
}> = ({ label, newer, older, newerText, olderText }) =>
	newer === null && older === null ? null : (
		<nav class="pager" aria-label={label}>
			{newer === null ? (
				<OffButton icon="back">{newerText}</OffButton>
			) : (
				<LinkButton href={newer} icon="back">
					{newerText}
				</LinkButton>
			)}
			{older === null ? (
				<OffButton>{olderText}</OffButton>
			) : (
				<a class="btn" href={older}>
					{olderText}
					<Icon name="next" size={18} decorative />
				</a>
			)}
		</nav>
	)

type TabItem = { href: string; text: string; current: boolean }

// Sections of a page that are pages of their own (§14.3): a named nav of links, the current one marked
// aria-current="page", never ARIA tab widgets. A page that is none of them marks none.
export const Tabs: FC<{ label: string; items: TabItem[] }> = ({ label, items }) => (
	<nav class="tabs" aria-label={label}>
		{items.map((item) => (
			<a href={item.href} aria-current={item.current ? 'page' : undefined}>
				{item.text}
			</a>
		))}
	</nav>
)
