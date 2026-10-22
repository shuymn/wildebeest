import type { Child, FC } from 'hono/jsx'

import { type SafeHtml, plainText, sanitized, sanitizedField } from './safe-html'
import { type Notice, STRINGS } from './strings'
import type { Account, CredentialAccount, Visibility } from '../domain/accounts'
import type { InstanceRule } from '../domain/instance'
import type { MediaAttachment, Status } from '../domain/status-presenter'
import type { ParentLink } from '../domain/web-pages'
import type { Authorizations } from '../domain/web-session'
import { httpUrl } from '../platform/http-url'

// The web UI's pages (B5): server-rendered HTML with no script (the CSP has no script-src), one stylesheet from the
// static assets (/assets/kopje.css). hono/jsx escapes every interpolated value; stored HTML enters only through
// SafeHtml (safe-html.ts). Every link a page emits is a local path or an http(s) URL (HTML-3).

const STYLESHEET = '/assets/kopje.css'

const Rich: FC<{ html: SafeHtml; class: string }> = ({ html, class: className }) => (
	<div class={className} dangerouslySetInnerHTML={{ __html: html.html }} />
)

function href(url: string | null | undefined): string | undefined {
	return httpUrl(url ?? null)?.href
}

export const Layout: FC<{ title: string; head?: Child; children: Child }> = ({ title, head, children }) => (
	<html lang="en">
		<head>
			<meta charset="utf-8" />
			<meta name="viewport" content="width=device-width, initial-scale=1" />
			<meta name="color-scheme" content="light dark" />
			<title>{title}</title>
			<link rel="stylesheet" href={STYLESHEET} />
			{head}
		</head>
		<body>
			<header class="site">{STRINGS.site.product}</header>
			<main>{children}</main>
		</body>
	</html>
)

export const MessagePage: FC<{ title: string; message: string; link?: { href: string; text: string } }> = ({
	title,
	message,
	link,
}) => (
	<Layout title={title}>
		<h1>{title}</h1>
		<p>{message}</p>
		{link === undefined ? null : (
			<p>
				<a href={link.href}>{link.text}</a>
			</p>
		)}
	</Layout>
)

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
}) => (
	<Layout
		title={title}
		head={
			<>
				<meta name="description" content={description} />
				<link rel="canonical" href={`https://${domain}/about`} />
			</>
		}
	>
		<h1>{title}</h1>
		{description === '' ? null : <p class="about">{description}</p>}
		{extendedDescription === null ? null : <Rich html={sanitized(extendedDescription)} class="extended" />}
		{rules.length === 0 ? null : (
			<>
				<h2>{STRINGS.about.rules}</h2>
				<ol class="rules">
					{rules.map((rule) => (
						<li>
							{rule.text}
							{rule.hint === '' ? null : <p class="hint">{rule.hint}</p>}
						</li>
					))}
				</ol>
			</>
		)}
		{contactEmail === '' ? null : (
			<p class="contact">
				{STRINGS.about.contact}: {contactEmail}
			</p>
		)}
		{!privacyPolicy && !termsOfService ? null : (
			<ul class="documents">
				{privacyPolicy ? (
					<li>
						<a href="/privacy-policy">{STRINGS.documents.privacyPolicy}</a>
					</li>
				) : null}
				{termsOfService ? (
					<li>
						<a href="/terms-of-service">{STRINGS.documents.termsOfService}</a>
					</li>
				) : null}
			</ul>
		)}
	</Layout>
)

export type DocumentView = {
	title: string
	domain: string
	path: string
	// The document as stored, sanitized here at the sink (HTML-1).
	html: string
	// The privacy policy's stamp, or the terms of service's effective date.
	updatedAt: string | null
	effectiveDate: string | null
}

// /privacy-policy, /terms-of-service and /terms-of-service/:date (Mastodon's paths, config/routes.rb:230-232): the
// document an instance endpoint serves, with its effective date or the time it was last changed.
export const DocumentPage: FC<DocumentView> = ({ title, domain, path, html, updatedAt, effectiveDate }) => (
	<Layout title={title} head={<link rel="canonical" href={`https://${domain}${path}`} />}>
		<h1>{title}</h1>
		{effectiveDate === null ? null : (
			<p class="document-date">
				{STRINGS.documents.effectiveFrom} <time datetime={effectiveDate}>{effectiveDate}</time>
			</p>
		)}
		{updatedAt === null ? null : (
			<p class="document-date">
				{STRINGS.documents.lastUpdated} <DateTime iso={updatedAt} />
			</p>
		)}
		<Rich html={sanitized(html)} class="document" />
	</Layout>
)

function displayName(account: Account): string {
	return account.display_name === '' ? account.username : account.display_name
}

// The full address of a local or remote account: @user@domain.
function address(account: Account, domain: string): string {
	return account.acct.includes('@') ? `@${account.acct}` : `@${account.acct}@${domain}`
}

function localPath(url: string | null): string | undefined {
	const parsed = httpUrl(url)
	return parsed === null ? undefined : `${parsed.pathname}${parsed.search}`
}

const DateTime: FC<{ iso: string }> = ({ iso }) => (
	<time datetime={iso}>{`${iso.slice(0, 16).replace('T', ' ')} UTC`}</time>
)

const Media: FC<{ media: MediaAttachment[]; sensitive: boolean }> = ({ media, sensitive }) => {
	const images = media.flatMap((m) => {
		const full = href(m.url)
		const preview = href(m.preview_url) ?? full
		if (full === undefined || preview === undefined) {
			return []
		}
		const size = m.meta?.small
		return [
			<a href={full} class="media-item">
				<img src={preview} alt={m.description ?? ''} loading="lazy" width={size?.width} height={size?.height} />
			</a>,
		]
	})
	if (images.length === 0) {
		return null
	}
	const grid = <div class="media">{images}</div>
	return sensitive ? (
		<details class="sensitive">
			<summary>{STRINGS.post.sensitiveMedia}</summary>
			{grid}
		</details>
	) : (
		grid
	)
}

const StatusBody: FC<{ status: Status }> = ({ status }) => {
	const content = (
		<>
			<Rich class="content" html={sanitized(status.content ?? '')} />
			<Media media={status.media_attachments} sensitive={status.sensitive} />
		</>
	)
	// The content warning hides the content until the reader opens it, as Mastodon does, with no script.
	return status.spoiler_text === '' ? (
		content
	) : (
		<details class="cw">
			<summary>
				<span class="spoiler">{status.spoiler_text}</span> <span class="more">{STRINGS.post.show}</span>
			</summary>
			{content}
		</details>
	)
}

const AccountHeader: FC<{ account: Account; domain: string }> = ({ account, domain }) => (
	<a class="author" href={localPath(account.url) ?? `/@${account.username}`}>
		<img class="avatar small" src={href(account.avatar)} alt="" width={48} height={48} />
		<span>
			<strong>{displayName(account)}</strong>
			<br />
			<span class="address">{address(account, domain)}</span>
		</span>
	</a>
)

const StatusItem: FC<{ status: Status }> = ({ status }) => (
	<article class="status">
		<p class="meta">
			<a href={localPath(status.url)}>
				<DateTime iso={status.created_at} />
			</a>
			{status.edited_at === null ? null : <span class="edited"> ({STRINGS.post.edited})</span>}
		</p>
		<StatusBody status={status} />
	</article>
)

export type ProfileView = {
	account: Account
	statuses: Status[]
	next: string | null
	domain: string
	actorUri: string
	// The hashtag the posts are of (/@username/tagged/:tag), or none for all of them.
	tag?: string | null
}

export const ProfilePage: FC<ProfileView> = ({ account, statuses, next, domain, actorUri, tag = null }) => {
	const base = tag === null ? `/@${account.username}` : `/@${account.username}/tagged/${encodeURIComponent(tag)}`
	const name = displayName(account)
	const title = `${name} (${address(account, domain)})`
	const description = plainText(account.note)
	const header = href(account.header)
	return (
		<Layout
			title={title}
			head={
				<>
					<meta name="description" content={description} />
					<meta property="og:site_name" content={domain} />
					<meta property="og:type" content="profile" />
					<meta property="og:title" content={title} />
					<meta property="og:description" content={description} />
					<meta property="og:url" content={account.url} />
					<meta property="og:image" content={href(account.avatar)} />
					<meta property="profile:username" content={address(account, domain).slice(1)} />
					<link rel="canonical" href={account.url} />
					<link rel="alternate" type="application/activity+json" href={actorUri} />
				</>
			}
		>
			<section class="profile">
				{header === undefined ? null : <img class="header" src={header} alt="" />}
				<div class="identity">
					<img class="avatar" src={href(account.avatar)} alt="" width={96} height={96} />
					<h1>
						{name}
						<br />
						<span class="address">{address(account, domain)}</span>
					</h1>
				</div>
				<Rich class="note" html={sanitized(account.note)} />
				{account.fields.length === 0 ? null : (
					<dl class="fields">
						{account.fields.map((field) => (
							<div>
								<dt>{field.name}</dt>
								<dd dangerouslySetInnerHTML={{ __html: sanitizedField(field.value).html }} />
							</div>
						))}
					</dl>
				)}
				<ul class="counts">
					<li>
						<strong>{account.statuses_count}</strong> {STRINGS.profile.posts}
					</li>
					<li>
						<strong>{account.following_count}</strong> {STRINGS.profile.following}
					</li>
					<li>
						<strong>{account.followers_count}</strong> {STRINGS.profile.followers}
					</li>
				</ul>
			</section>
			<section class="statuses">
				{tag === null ? null : <h2>#{tag}</h2>}
				{statuses.length === 0 ? (
					<p class="empty">{STRINGS.profile.noPosts}</p>
				) : (
					statuses.map((s) => <StatusItem status={s} />)
				)}
				{next === null ? null : (
					<p class="pager">
						<a href={`${base}?max_id=${next}`}>{STRINGS.pager.older}</a>
					</p>
				)}
			</section>
		</Layout>
	)
}

export type StatusView = { status: Status; parent: ParentLink | null; domain: string }

export const StatusPage: FC<StatusView> = ({ status, parent, domain }) => {
	const author = status.account
	const title = `${displayName(author)} (${address(author, domain)})`
	const description = status.spoiler_text !== '' ? status.spoiler_text : plainText(status.content ?? '')
	const image = status.sensitive ? undefined : href(status.media_attachments[0]?.preview_url)
	const parentHref = href(parent?.url)
	return (
		<Layout
			title={title}
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
			<article class="status permalink">
				<AccountHeader account={author} domain={domain} />
				{parent === null || parentHref === undefined ? null : (
					<p class="reply-to">
						{STRINGS.post.inReplyTo} <a href={parentHref}>@{parent.acct}</a>
					</p>
				)}
				<StatusBody status={status} />
				<p class="meta">
					<DateTime iso={status.created_at} />
					{status.edited_at === null ? null : <span class="edited"> ({STRINGS.post.edited})</span>}
				</p>
			</article>
		</Layout>
	)
}

export type SettingsView = {
	account: CredentialAccount
	authorizations: Authorizations
	csrf: string
	notice: Notice | null
	problems: string[]
}

const Csrf: FC<{ token: string }> = ({ token }) => <input type="hidden" name="csrf" value={token} />

// A checkbox that posts false when unchecked: the hidden input after it is read only when the box sent nothing (the
// first value of a name wins).
const Checkbox: FC<{ name: string; checked: boolean; label: string }> = ({ name, checked, label }) => (
	<label class="check">
		<input type="checkbox" name={name} value="true" checked={checked} />
		<input type="hidden" name={name} value="false" />
		{label}
	</label>
)

const VISIBILITIES: Visibility[] = ['public', 'unlisted', 'private', 'direct']
const FIELD_ROWS = 4

const ImageForm: FC<{ kind: 'avatar' | 'header'; current: string; csrf: string }> = ({ kind, current, csrf }) => (
	<form method="post" action={`/settings/${kind}`} enctype="multipart/form-data" class="image-form">
		<h3>{kind === 'avatar' ? STRINGS.settings.avatar : STRINGS.settings.header}</h3>
		<img class={kind === 'avatar' ? 'avatar' : 'header'} src={href(current)} alt="" />
		<Csrf token={csrf} />
		<input type="file" name="file" accept="image/jpeg,image/png,image/gif,image/webp" required />
		<p class="hint">{STRINGS.settings.imageHint}</p>
		<button type="submit">{STRINGS.settings.upload}</button>
	</form>
)

export const SettingsPage: FC<SettingsView> = ({ account, authorizations, csrf, notice, problems }) => {
	const fields = [...account.source.fields]
	while (fields.length < FIELD_ROWS) {
		fields.push({ name: '', value: '', verified_at: null })
	}
	return (
		<Layout title={STRINGS.settings.title}>
			<h1>{STRINGS.settings.title}</h1>
			{notice === null ? null : (
				<p class="notice" role="status">
					{STRINGS.settings.notices[notice]}
				</p>
			)}
			{problems.length === 0 ? null : (
				<div class="problems" role="alert">
					<p>{STRINGS.settings.problemsTitle}</p>
					<ul>
						{problems.map((problem) => (
							<li>{problem}</li>
						))}
					</ul>
				</div>
			)}
			<section>
				<h2>{STRINGS.settings.profile}</h2>
				<p>
					<a href={localPath(account.url)}>@{account.username}</a>
				</p>
				<form method="post" action="/settings/profile">
					<Csrf token={csrf} />
					<label>
						{STRINGS.settings.displayName}
						<input type="text" name="display_name" value={account.display_name} maxlength={30} />
					</label>
					<label>
						{STRINGS.settings.bio}
						<textarea name="note" rows={4} maxlength={500}>
							{account.source.note}
						</textarea>
					</label>
					<fieldset>
						<legend>{STRINGS.settings.fields}</legend>
						{fields.map((field, index) => (
							<div class="field-row">
								<input
									type="text"
									name={`fields_attributes[${index}][name]`}
									value={field.name}
									maxlength={255}
									placeholder={STRINGS.settings.fieldName}
									aria-label={STRINGS.settings.fieldName}
								/>
								<input
									type="text"
									name={`fields_attributes[${index}][value]`}
									value={field.value}
									maxlength={255}
									placeholder={STRINGS.settings.fieldValue}
									aria-label={STRINGS.settings.fieldValue}
								/>
							</div>
						))}
					</fieldset>
					<Checkbox name="locked" checked={account.locked} label={STRINGS.settings.locked} />
					<Checkbox name="discoverable" checked={account.discoverable === true} label={STRINGS.settings.discoverable} />
					<Checkbox name="indexable" checked={account.source.indexable} label={STRINGS.settings.indexable} />
					<label>
						{STRINGS.settings.defaultVisibility}
						<select name="source[privacy]">
							{VISIBILITIES.map((visibility) => (
								<option value={visibility} selected={account.source.privacy === visibility}>
									{STRINGS.settings.visibilities[visibility]}
								</option>
							))}
						</select>
					</label>
					<button type="submit">{STRINGS.settings.save}</button>
				</form>
			</section>
			<section class="images">
				<ImageForm kind="avatar" current={account.avatar} csrf={csrf} />
				<ImageForm kind="header" current={account.header} csrf={csrf} />
			</section>
			<section>
				<h2>{STRINGS.settings.authorizedApps}</h2>
				{authorizations.apps.length === 0 ? (
					<p class="empty">{STRINGS.settings.noApps}</p>
				) : (
					<ul class="apps">
						{authorizations.apps.map((app) => {
							const website = href(app.website)
							return (
								<li>
									<strong>{website === undefined ? app.name : <a href={website}>{app.name}</a>}</strong>
									<br />
									{STRINGS.settings.scopes}: <code>{app.scopes.join(' ')}</code>
									<br />
									{STRINGS.settings.authorizedAt}: <DateTime iso={app.authorizedAt} />
									<form method="post" action="/settings/authorizations/revoke">
										<Csrf token={csrf} />
										<input type="hidden" name="client_id" value={app.clientId} />
										<button type="submit" class="danger">
											{STRINGS.settings.revoke}
										</button>
									</form>
								</li>
							)
						})}
					</ul>
				)}
			</section>
			<section>
				<h2>{STRINGS.settings.sessions}</h2>
				<p>{STRINGS.settings.otherSessions(authorizations.otherSessions)}</p>
				<div class="actions">
					{authorizations.otherSessions === 0 ? null : (
						<form method="post" action="/settings/sessions/revoke">
							<Csrf token={csrf} />
							<button type="submit">{STRINGS.settings.signOutOthers}</button>
						</form>
					)}
					<form method="post" action="/logout">
						<Csrf token={csrf} />
						<button type="submit">{STRINGS.signIn.signOut}</button>
					</form>
				</div>
			</section>
		</Layout>
	)
}

// The script an embed page runs (public/assets/embed-status.js): it answers embed.js's height request.
export const EMBED_SCRIPT = '/assets/embed-status.js'

// The embed page (Mastodon's StatusesController#embed): the status page's status alone, for an iframe on another
// site. Links open outside the frame (<base target>, which base-uri 'none' does not restrict: it names no URL); the
// script answers the embedding page's height request and does nothing else.
export const EmbedPage: FC<{ status: Status; domain: string }> = ({ status, domain }) => (
	<html lang="en">
		<head>
			<meta charset="utf-8" />
			<meta name="viewport" content="width=device-width, initial-scale=1" />
			<meta name="color-scheme" content="light dark" />
			<meta name="robots" content="noindex" />
			<base target="_blank" />
			<title>{`${displayName(status.account)} (${address(status.account, domain)})`}</title>
			<link rel="stylesheet" href={STYLESHEET} />
			<link rel="canonical" href={status.url ?? undefined} />
			<script src={EMBED_SCRIPT} async />
		</head>
		<body class="embed">
			<article class="status permalink">
				<AccountHeader account={status.account} domain={domain} />
				<StatusBody status={status} />
				<p class="meta">
					<a href={localPath(status.url)}>
						<DateTime iso={status.created_at} />
					</a>
					{status.edited_at === null ? null : <span class="edited"> ({STRINGS.post.edited})</span>}
					{' · '}
					<a href={localPath(status.url)}>{STRINGS.post.viewOn(domain)}</a>
				</p>
			</article>
		</body>
	</html>
)
