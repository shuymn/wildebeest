import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { mastodonAccessTable } from '../scripts/mastodon-scopes.mjs'

// scripts/mastodon-scopes.mjs on a minimal Mastodon checkout: what it resolves and what it leaves unresolved.
let dir: string

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'kopje-mastodon-scopes-'))
})

afterEach(async () => {
	await rm(dir, { recursive: true, force: true })
})

async function checkout(files: Record<string, string>) {
	const all: Record<string, string> = {
		'lib/mastodon/version.rb':
			'module Mastodon\n  module Version\n    def major\n      4\n    end\n\n    def minor\n      5\n    end\n\n    def patch\n      11\n    end\n  end\nend\n',
		'config/routes.rb': 'Rails.application.routes.draw do\n  draw(:api)\nend\n',
		'app/controllers/api/base_controller.rb': 'class Api::BaseController < ApplicationController\nend\n',
		...files,
	}
	for (const [path, text] of Object.entries(all)) {
		await mkdir(dirname(join(dir, path)), { recursive: true })
		await writeFile(join(dir, path), text)
	}
}

type Entry = { method: string; path: string; unresolved?: string[] }

const route = (path: string, method = 'GET') =>
	(mastodonAccessTable(dir).routes as Entry[]).find((r) => r.path === path && r.method === method)

describe('mastodon-scopes.mjs', () => {
	it('leaves a route a Pundit policy decides on unresolved, unless a user is required anyway', async () => {
		await checkout({
			'config/routes/api.rb':
				'namespace :api do\n  namespace :v1 do\n    resources :things, only: [:index, :show, :update]\n    resources :reports, only: [:index]\n  end\nend\n',
			'app/controllers/api/v1/things_controller.rb': [
				'class Api::V1::ThingsController < Api::BaseController',
				'  include Authorization',
				"  before_action -> { authorize_if_got_token! :read, :'read:things' }, except: :update",
				"  before_action -> { doorkeeper_authorize! :write, :'write:things' }, only: :update",
				'  before_action :require_user!, only: :update',
				'  before_action :set_thing, only: [:show, :update]',
				'',
				'  def index',
				'    render json: []',
				'  end',
				'',
				'  def show',
				'    render json: @thing',
				'  end',
				'',
				'  def update',
				'    authorize @thing, :update?',
				'  end',
				'',
				'  private',
				'',
				'  def set_thing',
				'    @thing = Thing.find(params[:id])',
				'    authorize @thing, :show?',
				'  end',
				'end',
				'',
			].join('\n'),
			'app/controllers/api/v1/reports_controller.rb': [
				'class Api::V1::ReportsController < Api::BaseController',
				"  before_action -> { authorize_if_got_token! :'admin:read' }",
				'  after_action :verify_authorized',
				'',
				'  def index',
				'    render json: []',
				'  end',
				'end',
				'',
			].join('\n'),
		})
		// No policy: resolved.
		expect(route('/api/v1/things')).toMatchObject({ token: 'optional', scopes: ['read', 'read:things'], user: false })
		expect(route('/api/v1/things')?.unresolved).toBeUndefined()
		// A policy in a callback the action runs, or verify_authorized after it.
		expect(route('/api/v1/things/:id')?.unresolved).toEqual(['Pundit policy: authorize @thing, :show?'])
		expect(route('/api/v1/reports')?.unresolved).toEqual(['Pundit policy: verify_authorized'])
		// require_user! already establishes the user requirement the policy would add.
		const update = route('/api/v1/things/:id', 'PATCH')
		expect(update).toMatchObject({ token: 'required', scopes: ['write', 'write:things'], user: true })
		expect(update?.unresolved).toBeUndefined()
	})
})
