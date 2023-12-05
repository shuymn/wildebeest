module.exports = {
	extends: [
		'eslint:recommended',
		'plugin:@typescript-eslint/recommended-type-checked',
		'plugin:import/recommended',
		'plugin:import/typescript',
	],
	parser: '@typescript-eslint/parser',
	parserOptions: {
		tsconfigRootDir: __dirname,
		project: true,
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
		'@typescript-eslint/no-unused-vars': 'off', // for unused imports
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
	overrides: [
		{
			files: ['*.test.ts'],
			rules: {
				'@typescript-eslint/require-await': 'warn',
			},
		},
	],
}
