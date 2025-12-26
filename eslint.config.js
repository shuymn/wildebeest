import js from '@eslint/js';
import { FlatCompat } from '@eslint/eslintrc';
import importPlugin from 'eslint-plugin-import';
import unusedImports from 'eslint-plugin-unused-imports';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const compat = new FlatCompat({
	baseDirectory: __dirname,
	recommendedConfig: js.configs.recommended,
	allConfig: js.configs.all,
});

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
			'backend/src/database/d1/*.ts',
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
			'import/resolver': {
				typescript: true,
				node: true,
			},
			// Treat 'cloudflare:test' as a built-in module to prevent import/no-unresolved errors.
			// This virtual module is provided by @cloudflare/vitest-pool-workers and cannot be resolved
			// through standard module resolution.
			'import/core-modules': ['cloudflare:test'],
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
					pathGroups: [
						{
							pattern: '@wildebeest/**',
							group: 'internal',
						},
						{
							pattern: 'wildebeest/**',
							group: 'internal',
						},
					],
					pathGroupsExcludedImportTypes: ['builtin'],
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
	}
];
