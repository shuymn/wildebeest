// The copy control (design §7.7): the server renders each control hidden, inside its CopyField (.copyfield), with the
// value in data-copy and the result texts from the catalogue in data-copied and data-failed; this shows the controls
// and, on a click, copies the value and writes the result into the field's role="status" element. It holds no UI text,
// fetches nothing and writes only text (textContent: no HTML sink, so Trusted Types needs no policy, WEB-2). Without
// the Clipboard API (a page not in a secure context) the controls stay hidden.

// The one call of the Clipboard API the control makes.
export type Clip = { writeText(text: string): Promise<void> }

export function enableCopy(root: ParentNode, clipboard: Clip | undefined): void {
	if (clipboard === undefined) {
		return
	}
	for (const button of root.querySelectorAll<HTMLButtonElement>('.copyfield button[data-copy]')) {
		const status = button.closest('.copyfield')?.querySelector('[role="status"]')
		if (status === null || status === undefined) {
			continue
		}
		button.hidden = false
		button.addEventListener('click', () => {
			// Emptied first, so the same result is announced again on the next click.
			status.textContent = ''
			clipboard.writeText(button.getAttribute('data-copy') ?? '').then(
				() => {
					status.textContent = button.getAttribute('data-copied')
				},
				() => {
					status.textContent = button.getAttribute('data-failed')
				}
			)
		})
	}
}
