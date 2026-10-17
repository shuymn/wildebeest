import * as tsParser from '@typescript-eslint/parser'
import { Linter } from 'eslint'
import { describe, expect, it } from 'vitest'

import config from '../../../eslint.config.js'

// The rule eslint.config.js sets for Kopje's sources: a fetch signs as a local account only with a key loaded while the
// account is available; the unchecked localKey serves Fedify's key-pairs dispatcher alone (federation.ts userSigner).
const block = (config as { files?: string[]; rules?: Linter.RulesRecord }[]).find(
	(entry) => entry.files?.includes('packages/kopje/src/**/*.ts') && entry.rules?.['no-restricted-syntax'] !== undefined
)

function flagged(code: string): string[] {
	const messages = new Linter({ configType: 'flat' }).verify(
		code,
		[{ files: ['**/*.ts'], languageOptions: { parser: tsParser }, rules: block?.rules ?? {} }],
		'federation.ts'
	)
	return messages.map((m) => m.message)
}

const ALLOWED = `
const userSigner = async (username: string) => {
	const key = await rpc((s) => s.localKey(build, { username })) // the dispatcher's own key
	return key
}
const localSigner = async (username: string) => rpc((s) => s.signingKey(build, { username }))
federation.setKeyPairsDispatcher(async (_ctx, identifier) => [await userSigner(identifier)])
`

describe('signing keys', () => {
	it('allows the dispatcher alone to load an unchecked key', () => {
		expect(block).toBeDefined()
		expect(flagged(ALLOWED)).toEqual([])
	})

	it('flags an unchecked key loaded anywhere else', () => {
		expect(flagged(ALLOWED.replace('s.signingKey(', 's.localKey('))).toHaveLength(1)
		expect(flagged(`${ALLOWED}\nconst other = () => store.localKey(build, x)`)).toHaveLength(1)
	})

	it('flags userSigner called outside the dispatcher', () => {
		expect(flagged(`${ALLOWED}\nconst late = async (identifier: string) => userSigner(identifier)`)).toHaveLength(1)
		expect(
			flagged(`${ALLOWED}\nfederation.setKeyPairsDispatcher(() => [])\nawait userSigner(identifier)`)
		).toHaveLength(1)
	})

	it('flags every Fedify call that signs with the dispatcher keys', () => {
		expect(
			flagged(
				`ctx.getDocumentLoader({ identifier })\nctx.getActorKeyPairs(name)\nfederation.setInboxListeners('/u/{identifier}/inbox')`
			)
		).toHaveLength(3)
	})
})
