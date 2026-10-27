import { type Child, createContext, type FC, useContext } from 'hono/jsx'

import { Html } from './html'
import type { Site } from '../../domain/web-pages/site'
import { APPLE_TOUCH_ICON, FAVICON, FAVICON_48, FAVICON_192 } from '../../platform/brand-assets'
import { L1_SCRIPT, STYLESHEET } from '../asset-versions'
import { useUi } from '../ui'

// The page frame: the skip link, the site header, main#content and the footer. Every page but the embed
// renders in it; `chrome: null` is /setup's, before the instance has a domain to show.

// Whether the page loads the L1 bundle: its route sets it together with the CSP that names the bundle
// (l1Page in app/public-pages.tsx), so a page has both or neither.
export const L1Context = createContext(false)

// The instance facts the header and footer show, which every page read loads with its page.
export type Chrome = Site

type Current = 'about'

// Kopje's mark, decorative (the link's name is the text beside it): 20 px, as a disc reads smaller than an 18 px
// line icon.
const MARK_SIZE = 20
const SiteMark: FC = () => <img src={FAVICON_48} width={MARK_SIZE} height={MARK_SIZE} alt="" />

export const SiteHeader: FC<{ chrome: Chrome | null; current?: Current }> = ({ chrome, current }) => {
	const { m } = useUi()
	return (
		<header class="bar">
			{chrome === null ? (
				// Without the site's facts (the Store-free error pages, OAuth and /setup), the product's name leads to the
				// site's root, so no page is a dead end.
				<a class="site quiet-link" href="/">
					<SiteMark />
					{m.site.product}
				</a>
			) : (
				<a class="site quiet-link" href="/about" aria-current={current === 'about' ? 'page' : undefined}>
					<SiteMark />
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
				<link rel="icon" href={FAVICON} sizes="16x16 32x32 48x48" />
				<link rel="icon" href={FAVICON_192} type="image/png" sizes="192x192" />
				<link rel="apple-touch-icon" href={APPLE_TOUCH_ICON} />
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
