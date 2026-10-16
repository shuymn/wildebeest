// Kopje's embed page (/@username/:id/embed) runs this script. It answers the embedding page's height request, which
// embed.js sends as { type: 'setHeight', id }, with the page's height, as Mastodon's embed page does, and again when
// a content warning or sensitive media is opened or closed.
;(function () {
	'use strict'

	var id = null

	function send() {
		if (id === null || window.parent === window) {
			return
		}
		window.parent.postMessage({ type: 'setHeight', id: id, height: document.documentElement.scrollHeight }, '*')
	}

	window.addEventListener('message', function (event) {
		var data = event.data
		if (event.source !== window.parent || data === null || typeof data !== 'object' || data.type !== 'setHeight') {
			return
		}
		id = data.id
		// Scrolling stays possible until a parent that sizes the frame asks.
		document.body.style.overflow = 'hidden'
		send()
	})

	document.addEventListener('toggle', send, true)
})()
