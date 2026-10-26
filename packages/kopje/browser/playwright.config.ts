import { defineConfig, devices } from '@playwright/test'

// The browser job (design §10.11): the fixture pages of fixtures.tsx, rendered to files by render.ts, opened in
// Chromium with the stylesheet and headers production serves. Firefox and WebKit are checked by hand before a UI
// release.
export default defineConfig({
	testDir: '.',
	testMatch: '*.spec.ts',
	globalSetup: './render.ts',
	outputDir: './.results',
	fullyParallel: true,
	forbidOnly: process.env.CI !== undefined,
	reporter: process.env.CI === undefined ? 'list' : [['list'], ['github']],
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
