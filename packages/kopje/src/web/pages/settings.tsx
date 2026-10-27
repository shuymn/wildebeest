import type { FC } from 'hono/jsx'

import type { CredentialAccount, Visibility } from '../../domain/accounts'
import type { Authorizations } from '../../domain/web-session'
import { httpUrl } from '../../platform/http-url'
import { Alert, Csrf, DateTime } from '../components/basics'
import { Icon } from '../components/icon'
import { type Chrome, Layout } from '../components/layout'
import { utcDate } from '../format'
import type { Notice } from '../strings'
import { useUi } from '../ui'
import { address } from '../view/account'
import { linkTo } from '../view/link'
import { scopeGroups } from '../view/scopes'

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

// A checkbox that posts false when unchecked: the hidden input after it is read only when the box sent nothing (the
// first value of a name wins).
const Checkbox: FC<{ name: string; checked: boolean; label: string }> = ({ name, checked, label }) => (
	<label class="check">
		<input type="checkbox" name={name} value="true" checked={checked} />
		<input type="hidden" name={name} value="false" />
		<span>{label}</span>
	</label>
)

const VISIBILITIES: Visibility[] = ['public', 'unlisted', 'private', 'direct']
const FIELD_ROWS = 4
const FIELD_NAME = 'field-name'
const FIELD_VALUE = 'field-value'

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
			<div class="titlebar">
				<h1>{m.settings.title}</h1>
				<a class="quiet-link" href={linkTo(account.url, chrome.domain)?.href}>
					{m.settings.viewProfile}
				</a>
			</div>
			{notice === null ? null : <Alert status="ok" title={m.settings.notices[notice]} />}
			{problems.length === 0 ? null : (
				<Alert status="fail" title={m.settings.problemsTitle}>
					<ul class="list">
						{problems.map((problem) => (
							<li>{problem}</li>
						))}
					</ul>
				</Alert>
			)}
			<div class="sections">
				<section class="stack">
					<h2>{m.settings.profile}</h2>
					<div class="card pad">
						{/* The account's address, which cannot change: read-only (readable, focusable and copyable), and
						outside the form, so it is never posted. */}
						<label>
							{m.settings.address}
							<span class="readonly">
								<input type="text" value={address(account, chrome.domain)} readonly />
								<Icon name="lock" size={18} decorative />
							</span>
						</label>
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
							<fieldset class="pairs">
								<legend>{m.settings.fields}</legend>
								{/* The columns' visible labels, which name each row's inputs. */}
								<div class="field-row" aria-hidden="true">
									<span class="flabel" id={FIELD_NAME}>
										{m.settings.fieldName}
									</span>
									<span class="flabel" id={FIELD_VALUE}>
										{m.settings.fieldValue}
									</span>
								</div>
								{fields.map((field, index) => (
									<div class="field-row">
										<input
											type="text"
											name={`fields_attributes[${index}][name]`}
											value={field.name}
											maxlength={255}
											aria-labelledby={FIELD_NAME}
										/>
										<input
											type="text"
											name={`fields_attributes[${index}][value]`}
											value={field.value}
											maxlength={255}
											aria-labelledby={FIELD_VALUE}
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
							<button type="submit" class="primary">
								{m.settings.save}
							</button>
						</form>
					</div>
				</section>
				<ImageForm kind="avatar" current={account.avatar} csrf={csrf} />
				<ImageForm kind="header" current={account.header} csrf={csrf} />
				<section class="stack">
					<h2>{m.settings.authorizedApps}</h2>
					{authorizations.apps.length === 0 ? (
						<p class="muted">{m.settings.noApps}</p>
					) : (
						<ul class="card rows apps" role="list">
							{authorizations.apps.map((app) => {
								const website = httpUrl(app.website)?.href
								return (
									<li>
										<div class="group">
											<strong>{website === undefined ? app.name : <a href={website}>{app.name}</a>}</strong>
											<dl class="meta">
												{/* By group, as the consent page names them; admin ones in the warning's colour. The one
												item of the line that may wrap. */}
												<div class="wraps">
													<dt>{m.settings.scopes}</dt>
													<dd>
														{scopeGroups(app.scopes).map(({ group }, i) => (
															<>
																{i === 0 ? null : ', '}
																<span class={group === 'admin' ? 'warn-text' : undefined}>
																	{m.oauth.scopeNames[group]}
																</span>
															</>
														))}
													</dd>
												</div>
												<div>
													<dt>{m.settings.authorizedAt}</dt>
													<dd>
														<DateTime
															iso={utcDate(app.authorizedAt)}
															text={f.calendarDate(utcDate(app.authorizedAt))}
															local={false}
														/>
													</dd>
												</div>
											</dl>
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
									{/* Signs out the other devices, which they cannot undo: danger, as Revoke. */}
									<button type="submit" class="danger">
										{m.settings.signOutOthers}
									</button>
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
