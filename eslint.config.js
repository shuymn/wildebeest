import js from '@eslint/js'
import { FlatCompat } from '@eslint/eslintrc'
import importPlugin from 'eslint-plugin-import'
import unusedImports from 'eslint-plugin-unused-imports'
import tsPlugin from '@typescript-eslint/eslint-plugin'
import tsParser from '@typescript-eslint/parser'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const compat = new FlatCompat({
	baseDirectory: __dirname,
	recommendedConfig: js.configs.recommended,
	allConfig: js.configs.all,
})

export default [
	{
		ignores: [
			'**/*.log',
			'**/.DS_Store',
			'.vscode/settings.json',
			'.history',
			'.yarn',
			'bazel-*',
			'bazel-bin',
			'bazel-out',
			'bazel-qwik',
			'bazel-testlogs',
			'dist',
			'dist-dev',
			'lib',
			'lib-types',
			'etc',
			'external',
			'node_modules',
			'temp',
			'tsc-out',
			'tsdoc-metadata.json',
			'target',
			'output',
			'rollup.config.js',
			'build',
			'.cache',
			'.vscode',
			'.rollup.cache',
			'dist',
			'tsconfig.tsbuildinfo',
			'vite.config.ts',
		],
	},
	...compat.extends(
		'eslint:recommended',
		'plugin:@typescript-eslint/recommended-type-checked',
		'plugin:import/recommended',
		'plugin:import/typescript'
	),
	{
		languageOptions: {
			parser: tsParser,
			parserOptions: {
				project: true,
				tsconfigRootDir: __dirname,
			},
		},
		plugins: {
			'@typescript-eslint': tsPlugin,
			import: importPlugin,
			'unused-imports': unusedImports,
		},
		settings: {
			// An array keeps this order: merged into plugin:import/typescript's `node` key, an object would try node first.
			// The node resolver picks a package's JavaScript entry over its types, and the import rules would then parse
			// bundles such as wrangler's 15 MB cli.js, which pushed lint to the heap limit.
			'import/resolver': [{ typescript: true }, { node: true }],
			// Treat Cloudflare virtual modules as built-ins to prevent import/no-unresolved errors.
			// These modules are provided by the Workers test runtime and cannot be resolved through standard module resolution.
			'import/core-modules': ['cloudflare:test', 'cloudflare:workers'],
		},
		rules: {
			'@typescript-eslint/no-unused-vars': 'off',
			'import/no-duplicates': 'error',
			'import/order': [
				'error',
				{
					alphabetize: {
						caseInsensitive: true,
						order: 'asc',
					},
					groups: ['builtin', 'external', 'internal'],
					'newlines-between': 'always',
				},
			],
			'no-var': 'error',
			'prefer-const': 'error',
			'prefer-spread': 'error',
			'unused-imports/no-unused-imports': 'error',
			'unused-imports/no-unused-vars': 'warn',
			/*
				Note: the following rules have been set to off so that linting
					  can pass with the current code, but we need to gradually
					  re-enable most of them
			*/
			'@typescript-eslint/no-unsafe-assignment': 'warn',
			'@typescript-eslint/no-unsafe-argument': 'warn',
			'@typescript-eslint/no-unsafe-member-access': 'warn',
			'@typescript-eslint/restrict-plus-operands': 'warn',
			'@typescript-eslint/restrict-template-expressions': 'warn',
			'@typescript-eslint/no-unnecessary-type-assertion': 'warn',
			'@typescript-eslint/no-explicit-any': 'warn',
			'no-mixed-spaces-and-tabs': 'off',
		},
	},
	{
		files: ['**/*.test.ts'],
		rules: {
			'@typescript-eslint/require-await': 'warn',
		},
	},
	{
		// Kopje's domain modules: an `any` passed as an argument would satisfy any parameter type, including the
		// branded status ids the status presenter accepts (packages/kopje/docs/visibility.md).
		files: ['packages/kopje/src/domain/**/*.ts'],
		rules: {
			'@typescript-eslint/no-unsafe-argument': 'error',
		},
	},
	{
		// Kopje signs a fetch as a local account only with a key chosen while the account is available (the Store's
		// fetchSigner and its answers' fetch preparations, domain/actors.ts fetchSignerOf). localKey has no such check:
		// only publishedKeyPair in federation.ts reads it, for the key pairs Fedify publishes, and nothing may make Fedify
		// sign with those pairs. test-node/signing-keys.test.ts pins these rules.
		files: ['packages/kopje/src/**/*.ts'],
		rules: {
			'no-restricted-syntax': [
				'error',
				{
					selector:
						"MemberExpression:matches([property.name='localKey'], [property.value='localKey']):not(VariableDeclarator[id.name='publishedKeyPair'] MemberExpression)",
					message:
						"Load a signing key with fetchSigner (it checks availability); localKey is publishedKeyPair's alone.",
				},
				{
					selector: "ObjectPattern > Property:matches([key.name='localKey'], [key.value='localKey'])",
					message:
						"Load a signing key with fetchSigner (it checks availability); localKey is publishedKeyPair's alone.",
				},
				{
					selector:
						'MemberExpression:matches([property.name=/^(getDocumentLoader|getActorKeyPairs|setInboxListeners)$/], [property.value=/^(getDocumentLoader|getActorKeyPairs|setInboxListeners)$/])',
					message: 'This makes Fedify sign with the published key pairs, which skip the availability check.',
				},
				{
					selector:
						'ObjectPattern > Property:matches([key.name=/^(getDocumentLoader|getActorKeyPairs|setInboxListeners)$/], [key.value=/^(getDocumentLoader|getActorKeyPairs|setInboxListeners)$/])',
					message: 'This makes Fedify sign with the published key pairs, which skip the availability check.',
				},
			],
		},
	},
]
