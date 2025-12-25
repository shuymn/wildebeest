import { useLocation } from '@builder.io/qwik-city'
import { getDomain } from '@wildebeest/backend/utils/getDomain'

export const useDomain = () => {
	const location = useLocation()
	return getDomain(location.url)
}
