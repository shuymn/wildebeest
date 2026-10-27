import type { Child, FC } from 'hono/jsx'

import { Icon } from './icon'
import { useUi } from '../ui'

// Dialogs (design §8 "Dialogs", amendments A5 and A7): a modal <dialog>, rendered closed and named by its heading,
// opened by a button with command="show-modal" and closed by its close button or Esc, with no script (the invoker
// commands of current browsers; no fallback for older ones, docs/web-pages.md). The browser returns focus to the
// invoker when it closes. hono/jsx passes `command`, `commandfor` and `closedby` through untyped (risk R6), so these
// components are where their values are typed.

// The button that opens the dialog `dialog` (its id).
export const DialogOpener: FC<{ dialog: string; class?: string; children?: Child }> = ({
	dialog,
	class: className,
	children,
}) => (
	<button type="button" class={className} command="show-modal" commandfor={dialog}>
		{children}
	</button>
)

// `focus`: where focus lands when it opens. 'heading' focuses the heading row (tabindex="-1" with autofocus, A5), so
// the dialog is announced by its name and no control is chosen for the reader; 'content' leaves it to an autofocus
// inside the children (a form's field). `lightDismiss`: an outside click closes it too (closedby="any", A7), only
// where closing loses nothing typed.
export const Dialog: FC<{
	id: string
	title: Child
	focus: 'heading' | 'content'
	lightDismiss: boolean
	children?: Child
}> = ({ id, title, focus, lightDismiss, children }) => {
	const { m } = useUi()
	const heading = `${id}-title`
	return (
		<dialog id={id} class="card" aria-labelledby={heading} closedby={lightDismiss ? 'any' : undefined}>
			<div
				class="dhead"
				tabindex={focus === 'heading' ? -1 : undefined}
				autofocus={focus === 'heading' ? true : undefined}
			>
				<h2 id={heading}>{title}</h2>
				<button type="button" class="btn quiet icon" command="close" commandfor={id}>
					<Icon name="x" size={18} label={m.a11y.close} />
				</button>
			</div>
			{children}
		</dialog>
	)
}

// A post's further actions behind one quiet "Share" button (design review B1): a popover of buttons, each opening its
// dialog, with no script. It is a group of buttons, not an ARIA menu (no arrow keys); light dismiss, Esc and Tab work
// as the popover gives them. The popover follows its trigger, so it is named by it and anchored to it.
export const ActionsMenu: FC<{ id: string; children?: Child }> = ({ id, children }) => {
	const { m } = useUi()
	return (
		<>
			<button type="button" class="btn quiet icon" command="toggle-popover" commandfor={id}>
				{/* The counts row's icon size (16, beside --t1 text). */}
				<Icon name="share" size={16} label={m.post.share} />
			</button>
			<div id={id} popover="auto" class="menu card">
				{children}
			</div>
		</>
	)
}
