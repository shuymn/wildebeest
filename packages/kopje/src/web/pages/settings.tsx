import type { FC } from 'hono/jsx'

import type { CredentialAccount, Visibility } from '../../domain/accounts'
import type { Authorizations } from '../../domain/web-session'
import { httpUrl } from '../../platform/http-url'
import { DateTime } from '../components/basics'
import { type Chrome, Layout } from '../components/layout'
import type { Notice } from '../strings'
import { useUi } from '../ui'
import { linkTo } from '../view/link'

// The settings page of the signed-in account (B5): profile, images, authorized apps and web sessions. Every form posts
// with the session's anti-forgery token (WEB-4).

export type SettingsView = {
	chrome: Chrome
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

// The avatar's or header's section: its heading above its card, the current image, then the upload form.
const ImageForm: FC<{ kind: 'avatar' | 'header'; current: string; csrf: string }> = ({ kind, current, csrf }) => {
	const { m } = useUi()
	const hint = `${kind}-hint`
	return (
		<section class="stack image-form">
			<h2>{kind === 'avatar' ? m.settings.avatar : m.settings.header}</h2>
			<div class="card pad">
				<img class={kind === 'avatar' ? 'avatar' : 'header'} src={httpUrl(current)?.href} alt="" />
				<form method="post" action={`/settings/${kind}`} enctype="multipart/form-data">
					<Csrf token={csrf} />
					<div class="field">
						<label>
							{kind === 'avatar' ? m.settings.avatarFile : m.settings.headerFile}
							<input
								type="file"
								name="file"
								accept="image/jpeg,image/png,image/gif,image/webp"
								required
								aria-describedby={hint}
							/>
						</label>
						<p class="hint" id={hint}>
							{m.settings.imageHint}
						</p>
					</div>
					<button type="submit">{m.settings.upload}</button>
				</form>
			</div>
		</section>
	)
}

export const SettingsPage: FC<SettingsView> = ({ chrome, account, authorizations, csrf, notice, problems }) => {
	const { m, f } = useUi()
	const fields = [...account.source.fields]
	while (fields.length < FIELD_ROWS) {
		fields.push({ name: '', value: '', verified_at: null })
	}
	return (
		<Layout title={m.settings.title} chrome={chrome}>
			<h1>{m.settings.title}</h1>
			{notice === null ? null : (
				<p class="notice" role="status">
					{m.settings.notices[notice]}
				</p>
			)}
			{problems.length === 0 ? null : (
				<div class="problems" role="alert">
					<p>{m.settings.problemsTitle}</p>
					<ul class="list">
						{problems.map((problem) => (
							<li>{problem}</li>
						))}
					</ul>
				</div>
			)}
			<div class="sections">
				<section class="stack">
					<h2>{m.settings.profile}</h2>
					<div class="card pad">
						<p>
							<a href={linkTo(account.url, chrome.domain)?.href}>@{account.username}</a>
						</p>
						<form method="post" action="/settings/profile">
							<Csrf token={csrf} />
							<label>
								{m.settings.displayName}
								<input type="text" name="display_name" value={account.display_name} maxlength={30} />
							</label>
							<label>
								{m.settings.bio}
								<textarea name="note" rows={4} maxlength={500}>
									{account.source.note}
								</textarea>
							</label>
							<fieldset>
								<legend>{m.settings.fields}</legend>
								{fields.map((field, index) => (
									<div class="field-row">
										<input
											type="text"
											name={`fields_attributes[${index}][name]`}
											value={field.name}
											maxlength={255}
											placeholder={m.settings.fieldName}
											aria-label={m.settings.fieldName}
										/>
										<input
											type="text"
											name={`fields_attributes[${index}][value]`}
											value={field.value}
											maxlength={255}
											placeholder={m.settings.fieldValue}
											aria-label={m.settings.fieldValue}
										/>
									</div>
								))}
							</fieldset>
							<Checkbox name="locked" checked={account.locked} label={m.settings.locked} />
							<Checkbox name="discoverable" checked={account.discoverable === true} label={m.settings.discoverable} />
							<Checkbox name="indexable" checked={account.source.indexable} label={m.settings.indexable} />
							<Checkbox
								name="hide_collections"
								checked={account.source.hide_collections}
								label={m.settings.hideCollections}
							/>
							<label>
								{m.settings.defaultVisibility}
								<select name="source[privacy]">
									{VISIBILITIES.map((visibility) => (
										<option value={visibility} selected={account.source.privacy === visibility}>
											{m.settings.visibilities[visibility]}
										</option>
									))}
								</select>
							</label>
							<button type="submit">{m.settings.save}</button>
						</form>
					</div>
				</section>
				<ImageForm kind="avatar" current={account.avatar} csrf={csrf} />
				<ImageForm kind="header" current={account.header} csrf={csrf} />
				<section class="stack">
					<h2>{m.settings.authorizedApps}</h2>
					{authorizations.apps.length === 0 ? (
						<p class="empty">{m.settings.noApps}</p>
					) : (
						<ul class="card pad apps" role="list">
							{authorizations.apps.map((app) => {
								const website = httpUrl(app.website)?.href
								return (
									<li>
										<div class="group">
											<strong>{website === undefined ? app.name : <a href={website}>{app.name}</a>}</strong>
											<span>
												{m.settings.scopes}: <code>{app.scopes.join(' ')}</code>
											</span>
											<span>
												{m.settings.authorizedAt}:{' '}
												<DateTime iso={app.authorizedAt} text={f.instant(app.authorizedAt)} local />
											</span>
										</div>
										<form method="post" action="/settings/authorizations/revoke">
											<Csrf token={csrf} />
											<input type="hidden" name="client_id" value={app.clientId} />
											<button type="submit" class="danger">
												{m.settings.revoke}
											</button>
										</form>
									</li>
								)
							})}
						</ul>
					)}
				</section>
				<section class="stack">
					<h2>{m.settings.sessions}</h2>
					<div class="card pad">
						<p>{m.settings.otherSessions(authorizations.otherSessions)}</p>
						<div class="actions">
							{authorizations.otherSessions === 0 ? null : (
								<form method="post" action="/settings/sessions/revoke">
									<Csrf token={csrf} />
									<button type="submit">{m.settings.signOutOthers}</button>
								</form>
							)}
							<form method="post" action="/logout">
								<Csrf token={csrf} />
								<button type="submit">{m.signIn.signOut}</button>
							</form>
						</div>
					</div>
				</section>
			</div>
		</Layout>
	)
}
