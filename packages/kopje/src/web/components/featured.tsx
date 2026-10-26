import type { FC } from 'hono/jsx'

import { Icon } from './icon'
import { useUi } from '../ui'

export type FeaturedTagView = { name: string; href: string | null; count: number }

// An account's featured hashtags (design §11): a row each, its name linked to its hashtag page when one serves it, and
// its count of posts as the API reports it.
export const FeaturedTags: FC<{ tags: FeaturedTagView[] }> = ({ tags }) => {
	const { m } = useUi()
	return (
		<ul class="card rows hashtags" role="list">
			{tags.map((tag) => {
				const name = (
					<>
						<Icon name="tag" size={18} decorative />
						{tag.name}
					</>
				)
				return (
					<li>
						{tag.href === null ? <span class="name">{name}</span> : <a href={tag.href}>{name}</a>}
						<span class="count">{m.featured.posts(tag.count)}</span>
					</li>
				)
			})}
		</ul>
	)
}
