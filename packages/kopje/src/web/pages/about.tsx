import type { FC } from 'hono/jsx'

import type { Account } from '../../domain/accounts'
import type { InstanceRule } from '../../domain/instance'
import type { Site } from '../../domain/web-pages/site'
import { Card, LinkTo, Rich } from '../components/basics'
import { Layout } from '../components/layout'
import { sanitizedDocument } from '../safe-html'
import { useUi } from '../ui'
import { address } from '../view/account'
import { linkTo } from '../view/link'

export type AboutView = {
	title: string
	site: Site
	description: string
	contactEmail: string
	// The contact account (the instance's contact.account), named by its full address and linked to its profile; null
	// when none is set.
	contact: Account | null
	rules: InstanceRule[]
	// The software as NodeInfo names it: its version and repository (platform/package-version.ts).
	software: { version: string; repository: string }
	// The extended description as stored, sanitized here at the sink (HTML-1); null when none is set.
	extendedDescription: string | null
}

// /about, the page Mastodon's configuration.urls.about names and the instance actor's url: the server's title,
// description, extended description, rules and contact address, as the instance endpoints give them, and links to the
// privacy policy and the terms of service when they are available, and the Kopje version NodeInfo gives, linked to
// its repository, as the details card's last row. The contact account comes first, then the email: a mailto: link only for an address of one plain local
// part and domain (nothing that could add a header or a second recipient), else text.
// An address a mailto: link carries as it is: a local part and a domain of no space, '?', '#', '%' or second '@'.
const PLAIN_EMAIL = /^[^\s@?#%/:]+@[^\s@?#%/:]+$/

export const AboutPage: FC<AboutView> = ({
	title,
	site,
	description,
	contactEmail,
	contact,
	rules,
	software,
	extendedDescription,
}) => {
	const { m } = useUi()
	const contactView =
		contact === null ? null : { address: address(contact, site.domain), link: linkTo(contact.url, site.domain) }
	const { privacyPolicy, termsOfService } = site.documents
	const documents = privacyPolicy || termsOfService
	return (
		<Layout
			title={title}
			chrome={site}
			current="about"
			head={
				<>
					<meta name="description" content={description} />
					<link rel="canonical" href={`https://${site.domain}/about`} />
				</>
			}
		>
			<section class="intro">
				<h1>{title}</h1>
				{description === '' ? null : <p class="lead">{description}</p>}
			</section>
			<div class="sections">
				{extendedDescription === null ? null : (
					<section class="stack">
						<h2>{m.about.about}</h2>
						<Card class="pad">
							<Rich class="body document" html={sanitizedDocument(extendedDescription)} />
						</Card>
					</section>
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
									<div class="group">
										<p>{rule.text}</p>
										{rule.hint === '' ? null : <p class="hint">{rule.hint}</p>}
									</div>
								</li>
							))}
						</Card>
					</section>
				)}
				{/* Always shown: the software row is there whatever else is set. */}
				<section class="stack">
					<h2>{m.about.contactAndDetails}</h2>
					<Card as="dl" class="fields">
						{contactView === null ? null : (
							<div>
								<dt>{m.about.contact}</dt>
								<dd>
									{contactView.link === null ? (
										contactView.address
									) : (
										<LinkTo link={contactView.link}>{contactView.address}</LinkTo>
									)}
								</dd>
							</div>
						)}
						{contactEmail === '' ? null : (
							<div>
								<dt>{m.about.email}</dt>
								<dd>
									{PLAIN_EMAIL.test(contactEmail) ? (
										<a href={`mailto:${contactEmail}`}>{contactEmail}</a>
									) : (
										contactEmail
									)}
								</dd>
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
						<div>
							<dt>{m.about.software}</dt>
							<dd>
								<a href={software.repository}>{m.about.version(software.version)}</a>
							</dd>
						</div>
					</Card>
				</section>
			</div>
		</Layout>
	)
}
