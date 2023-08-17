module.exports = {
	extends: [
		'eslint:recommended',
		'plugin:@typescript-eslint/recommended',
		'plugin:@typescript-eslint/recommended-requiring-type-checking',
		'plugin:import/recommended',
		'plugin:import/typescript',
	],
	parser: '@typescript-eslint/parser',
	parserOptions: {
		tsconfigRootDir: __dirname,
		project: ['./tsconfig.json'],
	},
	plugins: ['@typescript-eslint', 'unused-imports', 'import'],
	root: true,
	settings: {
		'import/resolver': {
			typescript: true,
			node: true,
		},
	},
	rules: {
		'prefer-const': 'error',
		'no-var': 'error',
		'@typescript-eslint/no-unsafe-return': 'error',
		'unused-imports/no-unused-imports': 'error',
		'unused-imports/no-unused-vars': ['error'],
		'no-console': 'off',
		'no-constant-condition': 'off',
		'@typescript-eslint/require-await': 'off',
		'@typescript-eslint/no-unsafe-call': 'error',
		'@typescript-eslint/await-thenable': 'error',
		'@typescript-eslint/no-misused-promises': 'error',
		'@typescript-eslint/no-unused-vars': 'off',
		'import/no-duplicates': 'error',
		'import/order': [
			'error',
			{
				groups: ['builtin', 'external', 'internal'],
				'newlines-between': 'always',
				pathGroupsExcludedImportTypes: ['builtin'],
				alphabetize: { order: 'asc', caseInsensitive: true },
				pathGroups: [
					{
						pattern: 'wildebeest/**',
						group: 'internal',
					},
				],
			},
		],
		'import/no-restricted-paths': [
			'error',
			{
				zones: [
					{
						from: './!(backend|config|node_modules)/**/*',
						target: './backend/src/**/*',
					},
					{
						from: './!(backend|config|node_modules)/**/*',
						target: './functions/**/*',
					},
					{
						from: './!(backend|do|node_modules)/**/*',
						target: './do/**/*',
					},
					{
						from: './!(backend|consumer|node_modules)/**/*',
						target: './consumer/**/*',
					},
					{
						from: './node_modules/@types/better-sqlite3',
						target: './backend/src/**/*',
					},
					{
						from: './node_modules/@types/better-sqlite3',
						target: './functions/**/*',
					},
					{
						from: './node_modules/@types/better-sqlite3',
						target: './do/**/*',
					},
					{
						from: './node_modules/@types/better-sqlite3',
						target: './consumer/**/*',
					},
				],
			},
		],
		/*
			Note: the following rules have been set to off so that linting
				  can pass with the current code, but we need to gradually
				  re-enable most of them
		*/
		'@typescript-eslint/no-unsafe-assignment': 'off',
		'@typescript-eslint/no-unsafe-argument': 'off',
		'@typescript-eslint/no-unsafe-member-access': 'off',
		'@typescript-eslint/restrict-plus-operands': 'off',
		'@typescript-eslint/restrict-template-expressions': 'off',
		'@typescript-eslint/no-unnecessary-type-assertion': 'off',
		'@typescript-eslint/no-explicit-any': 'warn',
	},
}
