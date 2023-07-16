module.exports = {
	extends: [
		'eslint:recommended',
		'plugin:@typescript-eslint/recommended',
		'plugin:@typescript-eslint/recommended-requiring-type-checking',
	],
	parser: '@typescript-eslint/parser',
	parserOptions: {
		tsconfigRootDir: __dirname,
		project: ['./tsconfig.json'],
	},
	plugins: ['@typescript-eslint', 'unused-imports', 'simple-import-sort'],
	root: true,
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
		'simple-import-sort/imports': 'error',
		'simple-import-sort/exports': 'error',
		'@typescript-eslint/no-unused-vars': 'off',
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
