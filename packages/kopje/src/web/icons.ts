// The web UI's icons (design §11, §12): one stroked path each on a 24×24 grid, drawn for Kopje and licensed with it.
// Stroke width, caps and joins come from the stylesheet (.ic), so every icon takes the text colour.

export const ICONS = {
	alert: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7.5v5.5M12 16.5h.01',
	back: 'M19 12H5M11 18l-6-6 6-6',
	boost:
		'M17 3l3.5 3.5L17 10M4 11.5V10a3.5 3.5 0 0 1 3.5-3.5h13M7 21l-3.5-3.5L7 14M20 12.5V14a3.5 3.5 0 0 1-3.5 3.5h-13',
	check: 'M5 12.5l4.5 4.5L19 7.5',
	clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7.5V12l3 2',
	code: 'M8.5 7.5L4 12l4.5 4.5M15.5 7.5L20 12l-4.5 4.5M13.5 5l-3 14',
	copy: 'M9.5 9.5h10.5v10.5H9.5zM5.5 14.5H4V4h10.5v1.5',
	cw: 'M12 3.5L2.5 20h19zM12 10v4.5M12 17.5h.01',
	edit: 'M4 20h4.5L19.5 9l-4.5-4.5L4 15.5zM13 6.5l4.5 4.5',
	ext: 'M14 4h6v6M20 4l-8.5 8.5M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
	fav: 'M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.8z',
	follow: 'M15 20v-1.5a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4V20M8.5 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM19 8v6M16 11h6',
	info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5.5M12 7.5h.01',
	lock: 'M5.5 11h13v9.5h-13zM8.5 11V7.5a3.5 3.5 0 0 1 7 0V11',
	media: 'M4 4.5h16v15H4zM4 16l5-5 4 4 2.5-2.5L20 17M16.5 9a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z',
	next: 'M5 12h14M13 6l6 6-6 6',
	pin: 'M9 3.5h6M10 3.5v6l-4 3.5v2h12v-2l-4-3.5v-6M12 15v6',
	poll: 'M4 20h16M7 16.5V11M12 16.5V5.5M17 16.5V13',
	quote:
		'M10 11.5H6.5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1H9a1 1 0 0 1 1 1v4.5c0 3-1.5 5-4 6.5M18.5 11.5H15a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h2.5a1 1 0 0 1 1 1v4.5c0 3-1.5 5-4 6.5',
	reply: 'M9 14.5L4 9.5l5-5M4 9.5h10a6 6 0 0 1 6 6V20',
	search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4',
	server: 'M4 4h16v6.5H4zM4 13.5h16V20H4zM8 7.25h.01M8 16.75h.01',
	x: 'M6 6l12 12M18 6L6 18',
} as const

export type IconName = keyof typeof ICONS

export type IconSize = 16 | 18
