import type { FC } from 'hono/jsx'

import type { Site } from '../../domain/web-pages/site'
import { Layout } from '../components/layout'
import { Panel, RemoteChoice, remoteTitle, SearchField } from '../components/remote'
import { useUi } from '../ui'
import { authorizeInteraction, type RemoteTarget } from '../view/remote'

// The handoff pages, /@username/interact and /@username/:id/interact (design §8 "Handoff page"): script-free, and
// never cached as shared (design amendment A7). Without a server, or with one refused, the dialog's form as a page of
// its own; with a server, a link to its /authorize_interaction with the target's id. The page goes nowhere by itself:
// it never redirects, fetches, stores or signs in.

export const HandoffFormPage: FC<{ site: Site; target: RemoteTarget; problem: boolean }> = ({
	site,
	target,
	problem,
}) => {
	const { m } = useUi()
	const { title } = remoteTitle(target, m)
	return (
		<Layout title={title} chrome={site}>
			<Panel title={title}>
				<RemoteChoice target={target} field="server" autofocus={false} problem={problem} />
			</Panel>
		</Layout>
	)
}

export const HandoffPage: FC<{ site: Site; target: RemoteTarget; host: string }> = ({ site, target, host }) => {
	const { m } = useUi()
	const title = m.remote.continueTo(host)
	return (
		<Layout title={title} chrome={site}>
			<Panel title={title} back={{ href: target.path, label: m.remote.back }} oneLine>
				<p class="actions">
					<a class="btn primary" href={authorizeInteraction(host, target.uri)} rel="nofollow noopener">
						{m.remote.openOnYourServer}
					</a>
				</p>
				<SearchField target={target} label={m.remote.ifLinkFails} />
			</Panel>
		</Layout>
	)
}
