import { raw } from 'hono/html'
import type { Child, FC } from 'hono/jsx'

// The root of every HTML page: the doctype, so browsers render in standards mode (HTML, "the DOCTYPE"; without it
// they use quirks mode), then <html lang>.
export const Html: FC<{ lang: string; children?: Child }> = ({ lang, children }) => (
	<>
		{raw('<!DOCTYPE html>')}
		<html lang={lang}>{children}</html>
	</>
)
