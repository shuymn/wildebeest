import { component$, useStylesScoped$ } from '@builder.io/qwik'
import { sanitizeHtml } from '@wildebeest/backend/utils/html'
import styles from './HtmlContent.scss?inline'

export const HtmlContent = component$<{
	html: string
}>(({ html }) => {
	useStylesScoped$(styles)

	// the HTML may come from storage without going through the API serializers, so it is sanitized again
	return <div class="leading-normal inner-html-content" dangerouslySetInnerHTML={sanitizeHtml(html)} />
})
