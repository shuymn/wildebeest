import type { FC } from 'hono/jsx'

import type { InstanceRule } from '../../domain/instance'
import { Card, Rich } from '../components/basics'
import { Layout } from '../components/layout'
import { sanitized } from '../safe-html'
import { useUi } from '../ui'

export type AboutView = {
	title: string
	domain: string
	description: string
	contactEmail: string
	rules: InstanceRule[]
	// The extended description as stored, sanitized here at the sink (HTML-1); null when none is set.
	extendedDescription: string | null
	privacyPolicy: boolean
	termsOfService: boolean
}

// /about, the page Mastodon's configuration.urls.about names and the instance actor's url: the server's title,
// description, extended description, rules and contact address, as the instance endpoints give them, and links to the
// privacy policy and the terms of service when they are available. The address is text, not a mailto: link (HTML-3).
export const AboutPage: FC<AboutView> = ({
	title,
	domain,
	description,
	contactEmail,
	rules,
	extendedDescription,
	privacyPolicy,
	termsOfService,
}) => {
	const { m } = useUi()
	const documents = privacyPolicy || termsOfService
	return (
		<Layout
			title={title}
			chrome={{ domain, documents: { privacyPolicy, termsOfService } }}
			current="about"
			head={
				<>
					<meta name="description" content={description} />
					<link rel="canonical" href={`https://${domain}/about`} />
				</>
			}
		>
			<section class="intro">
				<h1>{title}</h1>
				{description === '' ? null : <p class="lead">{description}</p>}
			</section>
			{extendedDescription === null ? null : (
				<Card as="section" class="pad">
					<h2>{m.about.about}</h2>
					<Rich class="body" html={sanitized(extendedDescription)} />
				</Card>
			)}
			{rules.length === 0 ? null : (
				<section class="stack">
					<h2>{m.about.rules}</h2>
					<Card as="ol" class="rows rules" role="list">
						{rules.map((rule, index) => (
							<li>
								<span class="num" aria-hidden="true">
									{index + 1}
								</span>
								<div>
									<p>{rule.text}</p>
									{rule.hint === '' ? null : <p class="hint">{rule.hint}</p>}
								</div>
							</li>
						))}
					</Card>
				</section>
			)}
			{contactEmail === '' && !documents ? null : (
				<section class="stack">
					<h2>{m.about.contactAndDocuments}</h2>
					<Card as="dl" class="fields">
						{contactEmail === '' ? null : (
							<div>
								<dt>{m.about.contact}</dt>
								<dd class="mono">{contactEmail}</dd>
							</div>
						)}
						{!documents ? null : (
							<div>
								<dt>{m.about.documents}</dt>
								<dd>
									{termsOfService ? <a href="/terms-of-service">{m.documents.termsOfService}</a> : null}
									{privacyPolicy ? <a href="/privacy-policy">{m.documents.privacyPolicy}</a> : null}
								</dd>
							</div>
						)}
					</Card>
				</section>
			)}
		</Layout>
	)
}
