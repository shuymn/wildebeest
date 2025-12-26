import js from '@eslint/js';
import { FlatCompat } from '@eslint/eslintrc';
import { qwikEslint9Plugin } from 'eslint-plugin-qwik';
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
		ignores: ['e2e/**', 'playwright.config.ts', 'eslint.config.js'],
	},
	...compat.extends('eslint:recommended', 'plugin:@typescript-eslint/recommended'),
	...qwikEslint9Plugin.configs.recommended,
	{
		files: ['**/*.{js,mjs,cjs,jsx,mjsx,ts,tsx,mtsx}'],
		languageOptions: {
			parser: tsParser,
			ecmaVersion: 2021,
			sourceType: 'module',
			parserOptions: {
				tsconfigRootDir: __dirname,
				project: ['./tsconfig.json'],
				ecmaFeatures: {
					jsx: true,
				},
			},
		},
		plugins: {
			'@typescript-eslint': tsPlugin,
		},
		rules: {
			'@typescript-eslint/no-explicit-any': 'error',
			'@typescript-eslint/explicit-module-boundary-types': 'off',
			'@typescript-eslint/no-inferrable-types': 'error',
			'@typescript-eslint/no-non-null-assertion': 'error',
			'@typescript-eslint/no-empty-interface': 'error',
			'@typescript-eslint/no-namespace': 'error',
			'@typescript-eslint/no-empty-function': 'error',
			'@typescript-eslint/no-this-alias': 'error',
			'@typescript-eslint/no-restricted-types': [
				'error',
				{
					types: {
						String: {
							message: 'Use string instead.',
						},
						Boolean: {
							message: 'Use boolean instead.',
						},
						Number: {
							message: 'Use number instead.',
						},
						Symbol: {
							message: 'Use symbol instead.',
						},
						Object: {
							message: 'Use object instead.',
						},
						Function: {
							message: 'Define the function shape instead.',
						},
						'{}': {
							message: 'Use object instead.',
						},
					},
				},
			],
			'@typescript-eslint/ban-ts-comment': 'error',
			'prefer-spread': 'error',
			'no-case-declarations': 'error',
			'no-console': ['error', { allow: ['warn', 'error'] }],
			'@typescript-eslint/no-unused-vars': ['error'],
			'prefer-const': 'error',
		},
	}
];
