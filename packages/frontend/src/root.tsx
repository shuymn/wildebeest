import { component$, useStyles$ } from '@builder.io/qwik'
import { QwikCityProvider, RouterOutlet, ServiceWorkerRegister } from '@builder.io/qwik-city'
import { RouterHead } from './components/router-head/router-head'

import 'modern-normalize/modern-normalize.css'
import globalStyles from './styles.scss?inline'

export default component$(() => {
	useStyles$(globalStyles)

	return (
		<QwikCityProvider>
			<head>
				<meta charSet="utf-8" />
				<link rel="manifest" href="/manifest.json" />
				<link
					rel="stylesheet"
					href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css"
					crossOrigin="anonymous"
				/>
				<RouterHead />
			</head>
			<body lang="en" class="flex flex-col bg-wildebeest-900 text-white min-w-min min-h-screen">
				<RouterOutlet />
				<ServiceWorkerRegister />
			</body>
		</QwikCityProvider>
	)
})
