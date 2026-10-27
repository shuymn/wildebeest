import { type Child, type FC, useContext } from 'hono/jsx'

import { Card, FieldError } from './basics'
import { Dialog } from './dialog'
import { Icon } from './icon'
import { L1Context } from './layout'
import { InlineText } from './post'
import type { Messages } from '../messages'
import { useUi } from '../ui'
import { interactPath, type RemoteTarget } from '../view/remote'

// Following and interacting from another server (CopyField, RemoteForm, Panel): the profile's and the
// status's dialogs and the handoff pages share one body, a GET form naming the viewer's server and the address to
// search for there.

// The ids of the dialogs their pages open.
export const FOLLOW_DIALOG = 'follow'
export const INTERACT_DIALOG = 'interact'
export const EMBED_DIALOG = 'embed'

// A value to copy, named by a short `label` with what to do with it in a `hint` below, shown whole and wrapping, with
// its copy button on a page that loads the L1 bundle (L1Context): rendered hidden and shown by the bundle, its slot
// reserved so the button appears without moving anything, its result in the field's status element and its failure's
// note in the hint's place, the space of the longer kept, so nothing moves. A page without the bundle (the handoff
// pages, the code page) shows the value alone, selected and copied by hand, with no space kept for a control that never
// runs.
// `oneLine`: a long value (the embed code) shows one line cut with an ellipsis; the whole of it is still the text
// that is selected and copied.
export const CopyField: FC<{ value: string; label: string; hint: string; copyLabel: string; oneLine?: boolean }> = ({
	value,
	label,
	hint,
	copyLabel,
	oneLine = false,
}) => {
	const { m } = useUi()
	const shown = <span class={oneLine ? 'mono oneline' : 'mono'}>{value}</span>
	if (!useContext(L1Context)) {
		return (
			<div class="copyfield">
				<p class="flabel">{label}</p>
				<div class="copy">{shown}</div>
				<p class="hint">{hint}</p>
			</div>
		)
	}
	return (
		<div class="copyfield">
			<p class="flabel">{label}</p>
			<div class="copy">
				{shown}
				<span class="slot">
					{/* One icon a state (the bundle's data-state): copy, then a check for a moment, or an alert. */}
					<button
						type="button"
						class="btn quiet icon"
						hidden
						aria-label={copyLabel}
						data-copy={value}
						data-copied={m.copy.copied}
						data-failed={m.copy.failed}
					>
						<span class="idle">
							<Icon name="copy" size={18} decorative />
						</span>
						<span class="copied">
							<Icon name="check" size={18} decorative />
						</span>
						<span class="failed">
							<Icon name="alert" size={18} decorative />
						</span>
					</button>
				</span>
			</div>
			{/* The result for assistive technology, and the failure's note over the hint, so nothing moves. */}
			<p class="vh" role="status" />
			<div class="note">
				<p class="hint">{hint}</p>
				<p class="hint copy-failed" aria-hidden="true">
					{m.copy.failed}
				</p>
			</div>
		</div>
	)
}

// The form naming the viewer's server: a GET to the target's handoff page. `field` prefixes its ids, unique on the
// page; `autofocus` only inside a dialog; `problem` when the server given was refused, which the page
// says with the same bytes whatever was given, so nothing given is shown again.
export const RemoteForm: FC<{ action: string; field: string; autofocus: boolean; problem?: boolean }> = ({
	action,
	field,
	autofocus,
	problem = false,
}) => {
	const { m } = useUi()
	const hint = `${field}-hint`
	const refusal = `${field}-problem`
	return (
		<form method="get" action={action}>
			<div class="field">
				<label>
					{m.remote.server}
					<input
						type="text"
						name="server"
						required
						inputmode="url"
						autocapitalize="none"
						spellcheck={false}
						autofocus={autofocus ? true : undefined}
						aria-invalid={problem ? 'true' : undefined}
						aria-describedby={problem ? refusal : hint}
					/>
				</label>
				{problem ? (
					<FieldError id={refusal}>{m.remote.invalidServer}</FieldError>
				) : (
					<p class="hint" id={hint}>
						{m.remote.serverHint}
					</p>
				)}
			</div>
			<button type="submit" class="btn primary">
				{m.remote.go}
			</button>
		</form>
	)
}

// What to search for on another server, as the target's kind names it.
export const SearchField: FC<{ target: RemoteTarget; hint?: string }> = ({ target, hint }) => {
	const { m } = useUi()
	const account = target.kind === 'account'
	return (
		<CopyField
			value={target.search}
			label={account ? m.remote.handle : m.remote.postUrl}
			hint={hint ?? (account ? m.remote.searchHandle : m.remote.searchUrl)}
			copyLabel={account ? m.copy.copyHandle : m.copy.copyUrl}
		/>
	)
}

// The title of a target's dialog or handoff form, as text for <title> and as its heading (a name with its custom
// emoji), and its prompt.
export function remoteTitle(target: RemoteTarget, m: Messages): { title: string; heading: Child; prompt: string } {
	return target.name === null
		? { title: m.remote.openTitle, heading: m.remote.openTitle, prompt: m.remote.openPrompt }
		: {
				title: m.remote.followTitle(target.name.text),
				heading: m.remote.followHeading(<InlineText text={target.name.inline} />),
				prompt: m.remote.followPrompt,
			}
}

// The body the dialog and the handoff form page share: the prompt, the form, then the address to search for.
export const RemoteChoice: FC<{ target: RemoteTarget; field: string; autofocus: boolean; problem?: boolean }> = ({
	target,
	field,
	autofocus,
	problem,
}) => {
	const { m } = useUi()
	return (
		<>
			<p>{remoteTitle(target, m).prompt}</p>
			<RemoteForm action={interactPath(target.path)} field={field} autofocus={autofocus} problem={problem} />
			<p class="or">{m.remote.or}</p>
			<SearchField target={target} />
		</>
	)
}

// The profile's follow dialog or the status's: focus on the server field; an outside click closes it, as it
// closes every dialog.
export const RemoteDialog: FC<{ id: string; target: RemoteTarget }> = ({ id, target }) => {
	const { m } = useUi()
	return (
		<Dialog id={id} title={remoteTitle(target, m).heading} focus="content">
			<RemoteChoice target={target} field={`${id}-server`} autofocus />
		</Dialog>
	)
}

// The status's embed code, the oEmbed html as Mastodon's web client offers it: nothing is typed in it,
// so focus on its heading.
export const EmbedDialog: FC<{ code: string }> = ({ code }) => {
	const { m } = useUi()
	return (
		<Dialog id={EMBED_DIALOG} title={m.embed.title} focus="heading">
			<CopyField value={code} label={m.embed.code} hint={m.embed.prompt} copyLabel={m.copy.copyCode} oneLine />
		</Dialog>
	)
}

// A page for following or interacting: its heading, above its card as every page's is. `oneLine`: a
// heading that names a server the viewer typed stays one line, cut with an ellipsis (the whole of it stays the
// heading's text).
export const Panel: FC<{ title: Child; oneLine?: boolean; children?: Child }> = ({
	title,
	oneLine = false,
	children,
}) => (
	<>
		{oneLine ? <h1 class="oneline">{title}</h1> : <h1>{title}</h1>}
		<Card as="section" class="pad">
			{children}
		</Card>
	</>
)
