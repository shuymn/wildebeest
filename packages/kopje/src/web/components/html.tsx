import { raw } from 'hono/html'
import { type Child, createContext, type FC, useContext } from 'hono/jsx'

// The ids a page hands out to elements it names by id (an ALT badge's popover), counted per page so each is unique.
const PageIds = createContext<{ next: number } | null>(null)

// A new id for the page being rendered; outside a page (a component rendered alone, in a test) a prefixed one of its
// own call.
export function usePageId(prefix: string): () => string {
	const ids = useContext(PageIds)
	let local = 0
	return () => (ids === null ? `${prefix}-x${local++}` : `${prefix}-${ids.next++}`)
}

// The root of every HTML page: the doctype, so browsers render in standards mode (HTML, "the DOCTYPE"; without it
// they use quirks mode), then <html lang>.
export const Html: FC<{ lang: string; children?: Child }> = ({ lang, children }) => (
	<>
		{raw('<!DOCTYPE html>')}
		<PageIds.Provider value={{ next: 0 }}>
			<html lang={lang}>{children}</html>
		</PageIds.Provider>
	</>
)
