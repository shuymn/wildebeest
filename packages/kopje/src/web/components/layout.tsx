import { type Child, createContext, type FC, useContext } from 'hono/jsx'

import { Html } from './html'
import { Icon } from './icon'
import type { Site } from '../../domain/web-pages/site'
import { L1_SCRIPT, STYLESHEET } from '../asset-versions'
import { useUi } from '../ui'

// The page frame (design §11): the skip link, the site header, main#content and the footer. Every page but the embed
// renders in it; `chrome: null` is /setup's, before the instance has a domain to show.

// Whether the page loads the L1 bundle (design §7): its route sets it together with the CSP that names the bundle
// (l1Page in app/public-pages.tsx), so a page has both or neither.
export const L1Context = createContext(false)

// The instance facts the header and footer show, which every page read loads with its page (design §2).
export type Chrome = Site

type Current = 'about'

export const SiteHeader: FC<{ chrome: Chrome | null; current?: Current }> = ({ chrome, current }) => {
	const { m } = useUi()
	return (
		<header class="bar">
			{chrome === null ? (
				// Without the site's facts (the Store-free error pages, OAuth and /setup), the product's name leads to the
				// site's root, so no page is a dead end.
				<a class="site quiet-link" href="/">
					<Icon name="server" size={18} decorative />
					{m.site.product}
				</a>
			) : (
				<a class="site quiet-link" href="/about" aria-current={current === 'about' ? 'page' : undefined}>
					<Icon name="server" size={18} decorative />
					{chrome.domain}
				</a>
			)}
		</header>
	)
}

export const SiteFooter: FC<{ chrome: Chrome | null; current?: Current }> = ({ chrome, current }) => {
	const { m } = useUi()
	return (
		<footer class="foot">
			{chrome === null ? null : (
				<>
					<a class="quiet-link" href="/about" aria-current={current === 'about' ? 'page' : undefined}>
						{m.site.about}
					</a>
					{chrome.documents.termsOfService ? (
						<a class="quiet-link" href="/terms-of-service">
							{m.documents.termsOfService}
						</a>
					) : null}
					{chrome.documents.privacyPolicy ? (
						<a class="quiet-link" href="/privacy-policy">
							{m.documents.privacyPolicy}
						</a>
					) : null}
				</>
			)}
			<span>{m.site.poweredBy}</span>
		</footer>
	)
}

export const Layout: FC<{
	title: string
	head?: Child
	chrome: Chrome | null
	current?: Current
	children?: Child
}> = ({ title, head, chrome, current, children }) => {
	const { lang, m } = useUi()
	const script = useContext(L1Context)
	return (
		<Html lang={lang}>
			<head>
				<meta charset="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<meta name="color-scheme" content="light dark" />
				<title>{title}</title>
				<link rel="stylesheet" href={STYLESHEET} />
				{script ? <script defer src={L1_SCRIPT} /> : null}
				{head}
			</head>
			<body>
				<a class="skip" href="#content">
					{m.a11y.skipToContent}
				</a>
				<SiteHeader chrome={chrome} current={current} />
				<main id="content" class="col" tabindex={-1}>
					{children}
				</main>
				<SiteFooter chrome={chrome} current={current} />
			</body>
		</Html>
	)
}
