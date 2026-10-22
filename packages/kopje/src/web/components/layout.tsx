import type { Child, FC } from 'hono/jsx'

import { Icon } from './icon'
import { STYLESHEET } from '../asset-versions'
import { useUi } from '../ui'

// The page frame (design §11): the skip link, the site header, main#content and the footer. Every page but the embed
// renders in it; `chrome: null` is /setup's, before the instance has a domain to show.

export type SiteDocuments = { privacyPolicy: boolean; termsOfService: boolean }

// The instance facts the header and footer show. `documents` is null where the page read did not load them.
export type Chrome = { domain: string; documents: SiteDocuments | null }

type Current = 'about'

export const SiteHeader: FC<{ chrome: Chrome | null; current?: Current }> = ({ chrome, current }) => {
	const { m } = useUi()
	return (
		<header class="bar">
			{chrome === null ? (
				<span class="site">
					<Icon name="server" size={20} decorative />
					{m.site.product}
				</span>
			) : (
				<a class="site" href="/about" aria-current={current === 'about' ? 'page' : undefined}>
					<Icon name="server" size={20} decorative />
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
					<a href="/about" aria-current={current === 'about' ? 'page' : undefined}>
						{m.site.about}
					</a>
					{chrome.documents?.termsOfService === true ? (
						<a href="/terms-of-service">{m.documents.termsOfService}</a>
					) : null}
					{chrome.documents?.privacyPolicy === true ? <a href="/privacy-policy">{m.documents.privacyPolicy}</a> : null}
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
	return (
		<html lang={lang}>
			<head>
				<meta charset="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<meta name="color-scheme" content="dark light" />
				<title>{title}</title>
				<link rel="stylesheet" href={STYLESHEET} />
				{head}
			</head>
			<body>
				<a class="skip" href="#content">
					{m.a11y.skipToContent}
				</a>
				<SiteHeader chrome={chrome} current={current} />
				<main id="content" class="col">
					{children}
				</main>
				<SiteFooter chrome={chrome} current={current} />
			</body>
		</html>
	)
}
