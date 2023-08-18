import { component$ } from '@builder.io/qwik'
import { useDocumentHead, useLocation } from '@builder.io/qwik-city'

/**
 * The RouterHead component is placed inside of the document `<head>` element.
 */
export const RouterHead = component$(() => {
	const head = useDocumentHead()
	const loc = useLocation()

	return (
		<>
			<title>{head.title}</title>

			<link rel="canonical" href={loc.href} />
			<meta name="viewport" content="width=device-width, initial-scale=1.0" />
			<link rel="icon" type="image/svg+xml" href="/favicon.svg" />

			{head.meta.map((m, idx) => (
				<meta key={idx} {...m} />
			))}

			{head.links.map((l, idx) => (
				<link key={idx} {...l} />
			))}

			{head.styles.map((s, idx) => (
				<style key={idx} {...s.props} dangerouslySetInnerHTML={s.style} />
			))}
		</>
	)
})
