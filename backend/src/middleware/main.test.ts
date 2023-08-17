import { strict as assert } from 'node:assert/strict'

import { buildRoute, Route } from './main'

describe('buildRoute', () => {
	test.each([
		{
			title: 'static path, all methods',
			input: { path: '/foo/bar' } satisfies Route,
			expect: { key: '*', ok: ['/foo/bar'], ng: ['/', '/foo', '/foo/barbar', '/foo/bar/', '/foo/bar/piyo'] } as const,
		},
		{
			title: 'static path, GET',
			input: { method: 'GET', path: '/foo/bar' } satisfies Route,
			expect: { key: 'GET', ok: ['/foo/bar'], ng: ['/', '/foo', '/foo/barbar', '/foo/bar/', '/foo/bar/piyo'] } as const,
		},
		{
			title: 'dynamic path, prefix, all methods',
			input: { path: '/foo/bar/*', dynamic: true } satisfies Route,
			expect: {
				key: '*',
				ok: ['/foo/bar/piyo', '/foo/bar/a/b/c/d/e/f/g/h'],
				ng: ['/', '/foo', '/foo/barbar', '/foo/bar/', '/foo/piyo/bar'],
			} as const,
		},
		{
			title: 'dynamic path, prefix, GET',
			input: { method: 'GET', path: '/foo/bar/*', dynamic: true } satisfies Route,
			expect: {
				key: 'GET',
				ok: ['/foo/bar/piyo', '/foo/bar/a/b/c/d/e/f/g/h'],
				ng: ['/', '/foo', '/foo/barbar', '/foo/bar/', '/foo/piyo/bar'],
			} as const,
		},
		{
			title: 'dynamic path, param, all methods',
			input: { path: '/foo/bar/:id/piyo', dynamic: true } satisfies Route,
			expect: {
				key: '*',
				ok: ['/foo/bar/a-b-c-d/piyo', '/foo/bar/123/piyo'],
				ng: [
					'/',
					'/foo',
					'/foo/barbar',
					'/foo/bar/',
					'/foo/piyo/bar',
					'/foo/bar/a/b/c/d/e/f/g/h',
					'/foo/bar',
					'/foo/bar/piyo',
				],
			} as const,
		},
		{
			title: 'dynamic path, param, GET',
			input: { method: 'GET', path: '/foo/bar/:id/piyo', dynamic: true } satisfies Route,
			expect: {
				key: 'GET',
				ok: ['/foo/bar/a-b-c-d/piyo', '/foo/bar/123/piyo'],
				ng: [
					'/',
					'/foo',
					'/foo/barbar',
					'/foo/bar/',
					'/foo/piyo/bar',
					'/foo/bar/a/b/c/d/e/f/g/h',
					'/foo/bar',
					'/foo/bar/piyo',
				],
			} as const,
		},
		{
			title: 'dynamic path, end with param, all methods',
			input: { path: '/foo/bar/:id', dynamic: true } satisfies Route,
			expect: {
				key: '*',
				ok: ['/foo/bar/p-i-y-o', '/foo/bar/123'],
				ng: [
					'/',
					'/foo',
					'/foo/barbar',
					'/foo/bar/',
					'/foo/piyo/bar',
					'/foo/bar/a/b/c/d/e/f/g/h',
					'/foo/bar/piyo/piyo',
				],
			} as const,
		},
		{
			title: 'dynamic path, end with param, GET',
			input: { method: 'GET', path: '/foo/bar/:id', dynamic: true } satisfies Route,
			expect: {
				key: 'GET',
				ok: ['/foo/bar/p-i-y-o', '/foo/bar/123'],
				ng: [
					'/',
					'/foo',
					'/foo/barbar',
					'/foo/bar/',
					'/foo/piyo/bar',
					'/foo/bar/a/b/c/d/e/f/g/h',
					'/foo/bar/piyo/piyo',
				],
			} as const,
		},
	])('$title', ({ input, expect: { key, ok, ng } }) => {
		const routes = buildRoute([input])
		const actual = routes.get(key)
		assert.ok(actual)
		for (const path of ok) {
			assert.ok(actual.test(path), String(actual))
		}
		for (const path of ng) {
			assert.ok(!actual.test(path), path)
		}
	})
})
