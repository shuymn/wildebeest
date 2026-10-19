import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { entityFields, mastodonAccessTable } from '../scripts/mastodon-scopes.mjs'

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

type Entry = {
	method: string
	path: string
	unresolved?: string[]
	params?: { names: string[]; unresolved: string[] }
}

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

	it('leaves a route unresolved when a callback names its actions in a form it cannot read', async () => {
		await checkout({
			'config/routes/api.rb':
				'namespace :api do\n  namespace :v1 do\n    resources :things, only: [:index]\n  end\nend\n',
			'app/controllers/api/v1/things_controller.rb': [
				'class Api::V1::ThingsController < Api::BaseController',
				'  READS = %i(index show).freeze',
				"  before_action -> { doorkeeper_authorize! :read, :'read:things' }, only: READS",
				'',
				'  def index',
				'    render json: []',
				'  end',
				'end',
				'',
			].join('\n'),
		})
		expect(route('/api/v1/things')?.unresolved).toEqual([
			"unreadable only:/except: in `before_action -> { doorkeeper_authorize! :read, :'read:things' }, only: READS`",
		])
	})

	it('reads the API routes outside /api it names, and no other route outside /api', async () => {
		await checkout({
			'config/routes.rb': [
				'Rails.application.routes.draw do',
				'  namespace :oauth do',
				"    match 'userinfo', via: [:get, :post], to: 'userinfo#show', defaults: { format: 'json' }",
				'  end',
				"  get '/about', to: 'about#show'",
				'end',
				'',
			].join('\n'),
			'app/controllers/oauth/userinfo_controller.rb': [
				'class OAuth::UserinfoController < Api::BaseController',
				'  before_action -> { doorkeeper_authorize! :profile }, only: [:show]',
				'  before_action :require_user!',
				'',
				'  def show',
				'    render json: {}',
				'  end',
				'end',
				'',
			].join('\n'),
		})
		for (const method of ['GET', 'POST']) {
			expect(route('/oauth/userinfo', method)).toMatchObject({ token: 'required', scopes: ['profile'], user: true })
			expect(route('/oauth/userinfo', method)?.unresolved).toBeUndefined()
		}
		expect((mastodonAccessTable(dir).routes as Entry[]).map((r) => `${r.method} ${r.path}`)).toEqual([
			'GET /oauth/userinfo',
			'POST /oauth/userinfo',
		])
	})
})

// The Ruby forms are copied from Mastodon v4.5.11's controllers, trimmed to what the extraction reads.
describe('mastodon-scopes.mjs request parameters', () => {
	const params = (path: string, method = 'GET') => route(path, method)?.params

	const api = (lines: string) => `namespace :api do\n  namespace :v1 do\n${lines}\n  end\nend\n`

	it("reads an alias of params.require, a method's permit by the keys read, and a presence check", async () => {
		await checkout({
			'config/routes/api.rb': api(
				'    resource :credentials, only: [:update], path: "accounts/update_credentials"\n    resources :statuses, only: [:create, :update]'
			),
			'app/controllers/api/v1/credentials_controller.rb': [
				'class Api::V1::CredentialsController < Api::BaseController',
				'  def update',
				'    UpdateAccountService.new.call(@account, account_params, raise_error: true)',
				'    current_user.update(user_params) if user_params',
				'  end',
				'',
				'  private',
				'',
				'  def account_params',
				'    params.permit(:display_name, :avatar, attribution_domains: [])',
				'  end',
				'',
				'  def user_params',
				'    return nil if params[:source].blank?',
				'',
				'    source_params = params.require(:source)',
				'',
				'    {',
				'      default_privacy: source_params.fetch(:privacy, @account.user.setting_default_privacy),',
				'      default_language: source_params[:language],',
				'    }',
				'  end',
				'end',
				'',
			].join('\n'),
			'app/controllers/api/v1/statuses_controller.rb': [
				'class Api::V1::StatusesController < Api::BaseController',
				'  before_action :set_thread, only: [:create]',
				'',
				'  def create',
				'    PostStatusService.new.call(text: status_params[:status], poll: status_params[:poll], x: status_params[:extra])',
				'  end',
				'',
				'  def update',
				'    UpdateStatusService.new.call(text: status_params[:status], media_ids: status_params[:media_ids])',
				'  end',
				'',
				'  private',
				'',
				'  def set_thread',
				'    @thread = Status.find(status_params[:in_reply_to_id]) if status_params[:in_reply_to_id].present?',
				'  end',
				'',
				'  def status_params',
				'    params.permit(:status, :in_reply_to_id, media_ids: [], poll: [:multiple, options: []], extra: [:a])',
				'  end',
				'end',
				'',
			].join('\n'),
		})
		expect(params('/api/v1/accounts/update_credentials', 'PATCH')).toEqual({
			names: ['attribution_domains[]', 'avatar', 'display_name', 'source[language]', 'source[privacy]'],
			unresolved: [],
		})
		// The Ruby does not fix whether a nested permit is a record or a list of records: poll's is in PERMIT_SHAPES,
		// extra's is not.
		const shape =
			'app/controllers/api/v1/statuses_controller.rb status_params: shape of `extra:` (a record or a list of records: add it to PERMIT_SHAPES)'
		// The callback applies to create only; update reads the keys it takes of status_params, not the whole permit.
		expect(params('/api/v1/statuses', 'POST')).toEqual({
			names: ['in_reply_to_id', 'poll[multiple]', 'poll[options][]', 'status'],
			unresolved: [shape],
		})
		expect(params('/api/v1/statuses/:id', 'PATCH')).toEqual({ names: ['media_ids[]', 'status'], unresolved: [shape] })
	})

	it('reads truthy_param?, limit_param, conditions of callbacks, and Array(params[:x]) as a list', async () => {
		await checkout({
			'config/routes/api.rb': api('    get :search, to: "search#index"\n    resources :relationships, only: :index'),
			'app/controllers/api/v1/search_controller.rb': [
				'class Api::V1::SearchController < Api::BaseController',
				'  before_action :validate_search_params!',
				'  before_action :remote_resolve_error, if: :remote_resolve_requested?',
				'',
				'  def index',
				'    @search = Search.new(search_results)',
				'  end',
				'',
				'  private',
				'',
				'  def validate_search_params!',
				'    params.require(:q)',
				'  end',
				'',
				'  def remote_resolve_error',
				"    render json: { error: 'no' }, status: 401",
				'  end',
				'',
				'  def remote_resolve_requested?',
				'    truthy_param?(:resolve)',
				'  end',
				'',
				'  def search_results',
				'    SearchService.new.call(params[:q], limit_param(RESULTS_LIMIT), search_params.merge(following: truthy_param?(:following)))',
				'  end',
				'',
				'  def search_params',
				'    params.permit(:type, :offset)',
				'  end',
				'end',
				'',
			].join('\n'),
			'app/controllers/api/v1/relationships_controller.rb': [
				'class Api::V1::RelationshipsController < Api::BaseController',
				'  def index',
				'    render json: Account.where(id: account_ids)',
				'  end',
				'',
				'  private',
				'',
				'  def account_ids',
				'    Array(params[:id]).map(&:to_i)',
				'  end',
				'end',
				'',
			].join('\n'),
		})
		expect(params('/api/v1/search')).toEqual({
			names: ['following', 'limit', 'offset', 'q', 'resolve', 'type'],
			unresolved: [],
		})
		expect(params('/api/v1/relationships')).toEqual({ names: ['id[]'], unresolved: [] })
	})

	it('follows helpers through an inherited method and the concerns a controller includes, and ends a cycle', async () => {
		await checkout({
			'config/routes/api.rb':
				'namespace :api do\n  namespace :v2 do\n    resources :media, only: [:create]\n  end\nend\n',
			// v2 media reaches its permit through two hops: its own helper, then one inherited from v1.
			'app/controllers/api/v1/media_controller.rb': [
				'class Api::V1::MediaController < Api::BaseController',
				'  private',
				'',
				'  def media_attachment_params',
				'    params.permit(:file, :thumbnail, :description, :focus)',
				'  end',
				'end',
				'',
			].join('\n'),
			'app/controllers/api/v2/media_controller.rb': [
				'class Api::V2::MediaController < Api::V1::MediaController',
				'  include Api::Paging',
				'',
				'  def create',
				'    @media_attachment = current_account.media_attachments.create!(media_and_delay_params)',
				'    page_hint',
				'  end',
				'',
				'  private',
				'',
				'  def media_and_delay_params',
				'    { delay_processing: true }.merge(media_attachment_params)',
				'  end',
				'end',
				'',
			].join('\n'),
			'app/controllers/concerns/api/paging.rb': [
				'module Api::Paging',
				'  def page_hint',
				'    params[:min_id] if again',
				'  end',
				'',
				'  def again',
				'    page_hint',
				'  end',
				'end',
				'',
			].join('\n'),
		})
		expect(params('/api/v2/media', 'POST')).toEqual({
			names: ['description', 'file', 'focus', 'min_id', 'thumbnail'],
			unresolved: [],
		})
	})

	it('reads expect() records, slice(...).permit, and constants holding a literal list or the keys of a hash', async () => {
		await checkout({
			'config/routes/api.rb': api('    resource :subscription, only: [:create]\n    resources :accounts, only: :index'),
			'app/controllers/api/v1/subscriptions_controller.rb': [
				'class Api::V1::SubscriptionsController < Api::BaseController',
				'  def create',
				'    Web::PushSubscription.create!(endpoint: subscription_params[:endpoint], key_auth: subscription_params[:keys][:auth], data: data_params)',
				'  end',
				'',
				'  private',
				'',
				'  def subscription_params',
				'    params.expect(subscription: [:endpoint, keys: [:auth, :p256dh]])',
				'  end',
				'',
				'  def data_params',
				'    params.expect(data: [:policy, alerts: Notification::TYPES])',
				'  end',
				'end',
				'',
			].join('\n'),
			'app/models/notification.rb': [
				'class Notification < ApplicationRecord',
				'  PROPERTIES = {',
				'    mention: {',
				'      filterable: true,',
				'    }.freeze,',
				"    'admin.sign_up': {",
				'      filterable: false,',
				'    }.freeze,',
				'  }.freeze',
				'',
				'  TYPES = PROPERTIES.keys.freeze',
				'end',
				'',
			].join('\n'),
			'app/controllers/api/v1/accounts_controller.rb': [
				'class Api::V1::AccountsController < Api::BaseController',
				'  FILTER_PARAMS = %i(',
				'    local',
				'    by_domain',
				'  ).freeze',
				'',
				'  def index',
				'    AccountFilter.new(filter_params).results',
				'  end',
				'',
				'  private',
				'',
				'  def filter_params',
				'    params.slice(*FILTER_PARAMS).permit(*FILTER_PARAMS)',
				'  end',
				'end',
				'',
			].join('\n'),
		})
		expect(params('/api/v1/subscription', 'POST')).toEqual({
			names: [
				'data[alerts][admin.sign_up]',
				'data[alerts][mention]',
				'data[policy]',
				'subscription[endpoint]',
				'subscription[keys][auth]',
			],
			unresolved: [],
		})
		expect(params('/api/v1/accounts')).toEqual({ names: ['by_domain', 'local'], unresolved: [] })
	})

	it('leaves what it cannot name unresolved, and drops path parameters and Rails keys', async () => {
		await checkout({
			'config/routes/api.rb': api('    resources :measures, only: [:create, :update]'),
			'app/controllers/api/v1/measures_controller.rb': [
				'class Api::V1::MeasuresController < Api::BaseController',
				'  def create',
				'    Measure.retrieve(params[:keys], params[:id], params[:format], params)',
				'    params[key_name]',
				'    params.permit!',
				'    params.permit(threshold: {})',
				'    missing_params[:a]',
				'  end',
				'',
				'  def update',
				'    Measure.find(params[:id]).update!(params.to_unsafe_h)',
				'  end',
				'end',
				'',
			].join('\n'),
		})
		const file = 'app/controllers/api/v1/measures_controller.rb'
		// params[:format] is Rails' own key.
		expect(params('/api/v1/measures', 'POST')).toEqual({
			names: ['id', 'keys'],
			unresolved: [
				`${file} create: any hash \`threshold: {}\``,
				`${file} create: dynamic key \`params[key_name]\``,
				`${file} create: params used whole \`params)\``,
				`${file} create: unsupported .permit! \`params.permit!\``,
				`${file}: method missing_params not found`,
			],
		})
		// :id is the route's path parameter.
		expect(params('/api/v1/measures/:id', 'PATCH')).toEqual({
			names: [],
			unresolved: [`${file} update: unsupported .to_unsafe_h \`params.to_unsafe_h)\``],
		})
	})
})

describe('mastodon-scopes.mjs parameter helpers and reviewed readings', () => {
	const params = (path: string, method = 'GET') => route(path, method)?.params

	it('reads literal helper arguments, and leaves any other argument unresolved', async () => {
		await checkout({
			'config/routes/api.rb':
				'namespace :api do\n  namespace :v1 do\n    resources :things, only: :index\n  end\nend\n',
			'app/controllers/api/v1/things_controller.rb': [
				'class Api::V1::ThingsController < Api::BaseController',
				'  def index',
				"    truthy_param?('only_media')",
				'    truthy_param? :local',
				'    truthy_param?(key_name)',
				'    params_slice(:max_id, *KEYS)',
				'    limit_param(DEFAULT_LIMIT)',
				'  end',
				'end',
				'',
			].join('\n'),
		})
		const file = 'app/controllers/api/v1/things_controller.rb'
		expect(params('/api/v1/things')).toEqual({
			names: ['limit', 'local', 'only_media'],
			unresolved: [
				`${file} index: unreadable \`params_slice(:max_id, *KEYS)\``,
				`${file} index: unreadable \`truthy_param?(key_name)\``,
			],
		})
	})

	const markers = (timelines: string) => ({
		'config/routes/api.rb':
			'namespace :api do\n  namespace :v1 do\n    resources :markers, only: :create\n  end\nend\n',
		'app/controllers/api/v1/markers_controller.rb': [
			'class Api::V1::MarkersController < Api::BaseController',
			'  def create',
			'    resource_params.each_pair do |timeline, timeline_params|',
			'      Marker.find_or_create_by(timeline: timeline).update!(timeline_params)',
			'    end',
			'  end',
			'',
			'  private',
			'',
			'  def resource_params',
			'    params.slice(*Marker::TIMELINES).permit(*Marker::TIMELINES.map { |timeline| { timeline.to_sym => [:last_read_id] } })',
			'  end',
			'end',
			'',
		].join('\n'),
		'app/models/marker.rb': `class Marker < ApplicationRecord\n  TIMELINES = ${timelines}.freeze\nend\n`,
	})

	it("derives a reviewed reading's names from the list it depends on", async () => {
		await checkout(markers('%w(home notifications lists)'))
		expect(params('/api/v1/markers', 'POST')).toEqual({
			names: ['home[last_read_id]', 'lists[last_read_id]', 'notifications[last_read_id]'],
			unresolved: [],
		})
	})

	it('leaves a reviewed reading unresolved when its list is no longer a literal', async () => {
		await checkout(markers('TIMELINE_NAMES + EXTRA'))
		expect(params('/api/v1/markers', 'POST')).toEqual({
			names: [],
			unresolved: [
				'app/controllers/api/v1/markers_controller.rb resource_params: unreadable `*Marker::TIMELINES.map { |timeline| { timeline.to_sym => [:last_read_id] } }`',
			],
		})
	})

	it('resolves a loop variable by the block that encloses the read, and an ambiguous one not at all', async () => {
		await checkout({
			'config/routes/api.rb':
				'namespace :api do\n  namespace :v1 do\n    resources :things, only: :index\n  end\nend\n',
			'app/controllers/api/v1/things_controller.rb': [
				'class Api::V1::ThingsController < Api::BaseController',
				'  def index',
				'    %i(first).each do |key|',
				'      found = key if params[key].present?',
				'    end',
				'    %i(second).each { |key| found = key if params[key].present? }',
				'    %i(outer).each do |key|',
				'      %i(inner).each do |key|',
				'        found = key if params[key].present?',
				'      end',
				'    end',
				'  end',
				'end',
				'',
			].join('\n'),
		})
		expect(params('/api/v1/things')).toEqual({
			names: ['first', 'second'],
			unresolved: ['app/controllers/api/v1/things_controller.rb index: dynamic key `params[key]`'],
		})
	})

	it('reads the rest of the chain after a resolved loop key, and leaves an unsupported tail unresolved', async () => {
		await checkout({
			'config/routes/api.rb':
				'namespace :api do\n  namespace :v1 do\n    resources :things, only: :index\n  end\nend\n',
			'app/controllers/api/v1/things_controller.rb': [
				'class Api::V1::ThingsController < Api::BaseController',
				'  def index',
				'    %i(first second).each { |key| params[key][:nested] }',
				'    %i(third).each { |key| params[key].each_pair { |k, v| k } }',
				'  end',
				'end',
				'',
			].join('\n'),
		})
		expect(params('/api/v1/things')).toEqual({
			names: ['first[nested]', 'second[nested]'],
			unresolved: [
				'app/controllers/api/v1/things_controller.rb index: unsupported .each_pair `params[key].each_pair { |k, v| k } }`',
			],
		})
	})

	it('reads params[v] in a loop over a literal list as each value, and any other dynamic key as unresolved', async () => {
		await checkout({
			'config/routes/api.rb':
				'namespace :api do\n  namespace :v1 do\n    resources :things, only: :index\n  end\nend\n',
			'app/controllers/api/v1/things_controller.rb': [
				'class Api::V1::ThingsController < Api::BaseController',
				'  def index',
				'    %i(active pending archived).each do |status|',
				'      found = status if params[status].present?',
				'    end',
				'    STATES.each do |state|',
				'      found = state if params[state].present?',
				'    end',
				'  end',
				'end',
				'',
			].join('\n'),
		})
		expect(params('/api/v1/things')).toEqual({
			names: ['active', 'archived', 'pending'],
			unresolved: ['app/controllers/api/v1/things_controller.rb index: dynamic key `params[state]`'],
		})
	})
})

describe('mastodon-scopes.mjs entity fields', () => {
	it("reads a serializer's own fields after its superclass's, inner classes apart, and a method's hash keys", async () => {
		await checkout({
			'app/serializers/rest/account_serializer.rb': [
				'class REST::AccountSerializer < ActiveModel::Serializer',
				'  attributes :id, :username,',
				'             :note',
				'',
				'  has_one :moved_to_account, key: :moved, serializer: REST::AccountSerializer, if: :moved?',
				'  has_many :emojis, serializer: REST::CustomEmojiSerializer',
				'  attribute :silenced, key: :limited, if: :silenced?',
				'',
				'  class FieldSerializer < ActiveModel::Serializer',
				'    attributes :name, :value, :verified_at',
				'',
				'    def value',
				'      object.value',
				'    end',
				'  end',
				'',
				'  has_many :fields',
				'',
				'  def note',
				'    attributes :not_a_field',
				'  end',
				'end',
				'',
			].join('\n'),
			'app/serializers/rest/credential_account_serializer.rb': [
				'class REST::CredentialAccountSerializer < REST::AccountSerializer',
				'  attributes :source',
				'  attributes(*EXTRA)',
				'',
				'  def source',
				'    user = object.user',
				'',
				'    {',
				'      privacy: user.setting_default_privacy,',
				'      fields: object.fields.map(&:to_h),',
				'    }',
				'  end',
				'end',
				'',
			].join('\n'),
		})
		const names = (entity: string) =>
			(entityFields(dir, entity) as { fields: { name: string; optional: boolean }[] }).fields.map(
				(f) => `${f.name}${f.optional ? '?' : ''}`
			)
		expect(names('REST::AccountSerializer')).toEqual([
			'emojis',
			'fields',
			'id',
			'limited?',
			'moved?',
			'note',
			'username',
		])
		expect(names('REST::AccountSerializer::FieldSerializer')).toEqual(['name', 'value', 'verified_at'])
		expect(entityFields(dir, 'REST::CredentialAccountSerializer')).toMatchObject({
			unresolved: ['app/serializers/rest/credential_account_serializer.rb: `attributes(*EXTRA)`'],
		})
		expect(names('REST::CredentialAccountSerializer')).toContain('source')
		expect(names('REST::CredentialAccountSerializer')).toContain('limited?')
		expect(names('REST::CredentialAccountSerializer#source')).toEqual(['fields', 'privacy'])
		expect(entityFields(dir, 'REST::MissingSerializer')).toEqual({
			fields: [],
			unresolved: ['app/serializers/rest/missing_serializer.rb not found'],
		})
	})
})
