// Kopje's embed script, loaded by the HTML of GET /api/oembed: it replaces each embed quote with an iframe of its
// embed page (data-embed-url) and sizes the iframe to the height the page reports, as Mastodon's embed.js does. Only
// pages under the prefixes the script tag allows (data-allowed-prefixes, this instance's origin) are framed.
;(function (script) {
	'use strict'

	var allowed = script && script.dataset.allowedPrefixes ? script.dataset.allowedPrefixes.split(' ') : []
	var frames = new Map()
	var next = 0

	function permitted(url) {
		return (
			(url.protocol === 'https:' || url.protocol === 'http:') &&
			allowed.some(function (prefix) {
				return prefix !== '' && url.href.indexOf(prefix) === 0
			})
		)
	}

	window.addEventListener('message', function (event) {
		var data = event.data
		if (data === null || typeof data !== 'object' || data.type !== 'setHeight' || !frames.has(data.id)) {
			return
		}
		var entry = frames.get(data.id)
		if (entry.iframe.contentWindow !== event.source) {
			return
		}
		var height = Number(data.height)
		if (!isFinite(height) || height < 0) {
			return
		}
		entry.iframe.height = String(Math.ceil(height))
		if (entry.placeholder !== null && entry.placeholder.parentNode !== null) {
			entry.placeholder.parentNode.removeChild(entry.placeholder)
			entry.placeholder = null
		}
	})

	function embed(container) {
		if (container.getAttribute('data-kopje-embedded') !== null) {
			return
		}
		var url
		try {
			url = new URL(container.getAttribute('data-embed-url') || '')
		} catch (e) {
			return
		}
		if (!permitted(url)) {
			return
		}
		// Each embed's HTML carries this script; whichever copy runs first frames the quote.
		container.setAttribute('data-kopje-embedded', '')
		var id = ++next
		var iframe = document.createElement('iframe')
		iframe.src = url.href
		iframe.width = String(container.clientWidth)
		iframe.height = '0'
		iframe.allow = 'fullscreen'
		iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox')
		iframe.style.border = '0'
		iframe.style.overflow = 'hidden'
		iframe.style.display = 'block'
		iframe.onload = function () {
			iframe.contentWindow.postMessage({ type: 'setHeight', id: id }, url.origin)
		}
		frames.set(id, { iframe: iframe, placeholder: container.querySelector('a') })
		container.appendChild(iframe)
	}

	function start() {
		document.querySelectorAll('blockquote.mastodon-embed').forEach(embed)
	}

	if (document.readyState === 'complete') {
		start()
	} else {
		window.addEventListener('load', start)
	}
})(document.currentScript)
