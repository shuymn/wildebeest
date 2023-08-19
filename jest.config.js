/** @type {import('ts-jest').JestConfigWithTsJest} */
export default {
	transform: {
		'^.+\\.(t|j)sx?$': '@swc/jest',
	},
	verbose: true,
	testMatch: [
		'<rootDir>/(backend|consumer)/test/**/(*.)+(spec|test).ts',
		'<rootDir>/(backend|consumer)/src/**/(*.)+test.ts',
	],
	testTimeout: 30000,
	testEnvironment: 'miniflare',
	// Configuration is automatically loaded from `.env`, `package.json` and
	// `wrangler.toml` files by default, but you can pass any additional Miniflare
	// API options here:
	testEnvironmentOptions: {},
	cacheDirectory: 'node_modules/.cache/jest',
}
