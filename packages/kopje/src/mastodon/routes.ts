import { Hono } from 'hono'

import { requireAccess, type RouteAccess } from './access'
import * as accounts from './accounts'
import * as blocks from './blocks'
import type { ApiDeps, ApiEnv, ApiHandler } from './context'
import * as conversations from './conversations'
import * as filters from './filters'
import * as instance from './instance'
import * as lists from './lists'
import * as markers from './markers'
import * as media from './media'
import * as notificationGroups from './notification-groups'
import * as notifications from './notifications'
import * as oauth from './oauth'
import * as placeholders from './placeholders'
import * as polls from './polls'
import * as push from './push'
import * as scheduled from './scheduled-statuses'
import * as search from './search'
import * as statuses from './statuses'
import * as tags from './tags'
import * as timelines from './timelines'

// The explicit API route table (design §4): every route names the access it requires, one middleware (requireAccess)
// declares it, and the Store enforces it in each operation. Routes are matched in order, so fixed paths come before
// their :id siblings.

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'

export type Route = {
	method: Method
	path: string
	access: RouteAccess
	handler: ApiHandler
}

export const ROUTES: readonly Route[] = [
	{ method: 'POST', path: '/api/v1/apps', access: 'public', handler: oauth.registerApp },
	{ method: 'GET', path: '/api/v1/apps/verify_credentials', access: 'token', handler: oauth.verifyApp },
	{ method: 'POST', path: '/oauth/token', access: 'public', handler: oauth.tokenHandler },
	{ method: 'POST', path: '/oauth/revoke', access: 'public', handler: oauth.revokeHandler },
	{ method: 'GET', path: '/oauth/userinfo', access: { scope: 'profile' }, handler: oauth.userinfo },
	{ method: 'POST', path: '/oauth/userinfo', access: { scope: 'profile' }, handler: oauth.userinfo },
	{
		method: 'GET',
		path: '/.well-known/oauth-authorization-server',
		access: 'public',
		handler: oauth.authorizationServerMetadata,
	},

	{ method: 'GET', path: '/api/v1/instance', access: 'public', handler: instance.instanceV1 },
	{ method: 'GET', path: '/api/v2/instance', access: 'public', handler: instance.instanceV2 },
	{ method: 'GET', path: '/api/v1/custom_emojis', access: 'public', handler: instance.customEmojis },

	// Reads clients make at startup (instance details, preferences, tags, familiar followers), and the empty answers of
	// features Kopje has no data for yet (mastodon/placeholders.ts). Kept before the accounts routes, so
	// familiar_followers comes before its :id sibling.
	{ method: 'GET', path: '/api/v1/instance/rules', access: 'public', handler: instance.rules },
	{ method: 'GET', path: '/api/v1/instance/peers', access: 'public', handler: instance.peers },
	{
		method: 'GET',
		path: '/api/v1/instance/extended_description',
		access: 'public',
		handler: instance.extendedDescription,
	},
	{ method: 'GET', path: '/api/v1/instance/languages', access: 'public', handler: instance.languages },
	{ method: 'GET', path: '/api/v1/instance/privacy_policy', access: 'public', handler: instance.notConfigured },
	{ method: 'GET', path: '/api/v1/instance/terms_of_service', access: 'public', handler: instance.notConfigured },
	{ method: 'GET', path: '/api/v1/instance/activity', access: 'public', handler: instance.notConfigured },
	{ method: 'GET', path: '/api/v1/instance/domain_blocks', access: 'public', handler: instance.notConfigured },
	{ method: 'GET', path: '/api/v1/preferences', access: { scope: 'read:accounts' }, handler: accounts.preferences },
	{
		method: 'GET',
		path: '/api/v1/accounts/familiar_followers',
		access: { scope: 'read:follows' },
		handler: accounts.familiarFollowers,
	},
	{ method: 'GET', path: '/api/v1/tags/:id', access: { optional: true }, handler: tags.getTag },
	{
		method: 'GET',
		path: '/api/v1/followed_tags',
		access: { scope: 'read:follows' },
		handler: placeholders.emptyUserList,
	},
	{
		method: 'GET',
		path: '/api/v1/featured_tags',
		access: { scope: 'read:accounts' },
		handler: placeholders.emptyUserList,
	},
	{
		method: 'GET',
		path: '/api/v1/accounts/:id/featured_tags',
		access: 'public',
		handler: placeholders.accountFeaturedTags,
	},
	{
		method: 'GET',
		path: '/api/v1/endorsements',
		access: { scope: 'read:accounts' },
		handler: accounts.endorsements,
	},
	{ method: 'GET', path: '/api/v1/announcements', access: 'token', handler: placeholders.emptyUserList },
	{ method: 'GET', path: '/api/v1/trends', access: 'public', handler: placeholders.emptyList },
	{ method: 'GET', path: '/api/v1/trends/tags', access: 'public', handler: placeholders.emptyList },
	{ method: 'GET', path: '/api/v1/trends/statuses', access: 'public', handler: placeholders.emptyList },
	{ method: 'GET', path: '/api/v1/trends/links', access: 'public', handler: placeholders.emptyList },
	{
		method: 'GET',
		path: '/api/v1/suggestions',
		access: { scope: 'read:accounts' },
		handler: placeholders.emptyUserList,
	},
	{
		method: 'GET',
		path: '/api/v2/suggestions',
		access: { scope: 'read:accounts' },
		handler: placeholders.emptyUserList,
	},

	{
		method: 'GET',
		path: '/api/v1/accounts/verify_credentials',
		access: { scope: ['profile', 'read:accounts'] },
		handler: accounts.verifyCredentials,
	},
	{
		method: 'PATCH',
		path: '/api/v1/accounts/update_credentials',
		access: { scope: 'write:accounts' },
		handler: accounts.updateCredentials,
	},
	{
		method: 'GET',
		path: '/api/v1/accounts/relationships',
		access: { scope: 'read:follows' },
		handler: accounts.relationships,
	},
	{
		method: 'GET',
		path: '/api/v1/accounts/search',
		access: { scope: 'read:accounts' },
		handler: accounts.searchAccounts,
	},
	{ method: 'GET', path: '/api/v1/accounts/lookup', access: 'public', handler: accounts.lookupAccount },
	// Accounts by id, as /api/v1/accounts/:id shows them; registration answers as Mastodon's with registrations closed
	// (any token here: the handler checks write:accounts, then that the token has no user).
	{ method: 'GET', path: '/api/v1/accounts', access: 'public', handler: accounts.getAccounts },
	{ method: 'POST', path: '/api/v1/accounts', access: 'token', handler: accounts.register },
	{ method: 'GET', path: '/api/v1/accounts/:id', access: 'public', handler: accounts.getAccount },
	{ method: 'POST', path: '/api/v1/accounts/:id/follow', access: { scope: 'write:follows' }, handler: accounts.follow },
	{
		method: 'POST',
		path: '/api/v1/accounts/:id/unfollow',
		access: { scope: 'write:follows' },
		handler: accounts.unfollow,
	},
	{
		method: 'GET',
		path: '/api/v1/accounts/:id/followers',
		access: { scope: 'read:accounts', optional: true },
		handler: accounts.followers,
	},
	{
		method: 'GET',
		path: '/api/v1/follow_requests',
		access: { scope: 'read:follows' },
		handler: accounts.followRequests,
	},
	{
		method: 'POST',
		path: '/api/v1/follow_requests/:id/authorize',
		access: { scope: 'write:follows' },
		handler: accounts.authorizeFollowRequest,
	},
	{
		method: 'POST',
		path: '/api/v1/follow_requests/:id/reject',
		access: { scope: 'write:follows' },
		handler: accounts.rejectFollowRequest,
	},
	{
		method: 'GET',
		path: '/api/v1/accounts/:id/following',
		access: { scope: 'read:accounts', optional: true },
		handler: accounts.following,
	},
	{
		method: 'GET',
		path: '/api/v1/accounts/:id/statuses',
		access: { scope: 'read:statuses', optional: true },
		handler: timelines.accountStatuses,
	},

	// Removing a follower, private notes and endorsements.
	{
		method: 'POST',
		path: '/api/v1/accounts/:id/remove_from_followers',
		access: { scope: 'write:follows' },
		handler: accounts.removeFromFollowers,
	},
	{ method: 'POST', path: '/api/v1/accounts/:id/note', access: { scope: 'write:accounts' }, handler: accounts.note },
	{
		method: 'POST',
		path: '/api/v1/accounts/:id/endorse',
		access: { scope: 'write:accounts' },
		handler: accounts.endorse,
	},
	{ method: 'POST', path: '/api/v1/accounts/:id/pin', access: { scope: 'write:accounts' }, handler: accounts.endorse },
	{
		method: 'POST',
		path: '/api/v1/accounts/:id/unendorse',
		access: { scope: 'write:accounts' },
		handler: accounts.unendorse,
	},
	{
		method: 'POST',
		path: '/api/v1/accounts/:id/unpin',
		access: { scope: 'write:accounts' },
		handler: accounts.unendorse,
	},
	{
		method: 'GET',
		path: '/api/v1/accounts/:id/endorsements',
		access: { scope: 'read:accounts', optional: true },
		handler: accounts.accountEndorsements,
	},
	// Any token at the route; the handler refuses one without a user (require_user!).
	{
		method: 'GET',
		path: '/api/v1/accounts/:id/identity_proofs',
		access: 'token',
		handler: placeholders.identityProofs,
	},

	{
		method: 'GET',
		path: '/api/v1/accounts/:id/lists',
		access: { scope: 'read:lists' },
		handler: lists.accountLists,
	},

	// Blocks, mutes and domain blocks (mastodon/blocks.ts).
	{ method: 'POST', path: '/api/v1/accounts/:id/block', access: { scope: 'write:blocks' }, handler: blocks.block },
	{ method: 'POST', path: '/api/v1/accounts/:id/unblock', access: { scope: 'write:blocks' }, handler: blocks.unblock },
	{ method: 'POST', path: '/api/v1/accounts/:id/mute', access: { scope: 'write:mutes' }, handler: blocks.mute },
	{ method: 'POST', path: '/api/v1/accounts/:id/unmute', access: { scope: 'write:mutes' }, handler: blocks.unmute },
	{ method: 'GET', path: '/api/v1/blocks', access: { scope: 'read:blocks' }, handler: blocks.blocks },
	{ method: 'GET', path: '/api/v1/mutes', access: { scope: 'read:mutes' }, handler: blocks.mutes },
	{
		method: 'GET',
		path: '/api/v1/domain_blocks/preview',
		// As Mastodon's DomainBlocks::PreviewsController: it previews a write.
		access: { scope: 'write:blocks' },
		handler: blocks.previewDomainBlock,
	},
	{ method: 'GET', path: '/api/v1/domain_blocks', access: { scope: 'read:blocks' }, handler: blocks.domainBlocks },
	{ method: 'POST', path: '/api/v1/domain_blocks', access: { scope: 'write:blocks' }, handler: blocks.blockDomain },
	{
		method: 'DELETE',
		path: '/api/v1/domain_blocks',
		access: { scope: 'write:blocks' },
		handler: blocks.unblockDomain,
	},

	{ method: 'POST', path: '/api/v1/statuses', access: { scope: 'write:statuses' }, handler: statuses.createStatus },
	{
		method: 'GET',
		path: '/api/v1/statuses/:id',
		access: { scope: 'read:statuses', optional: true },
		handler: statuses.getStatus,
	},
	{ method: 'PUT', path: '/api/v1/statuses/:id', access: { scope: 'write:statuses' }, handler: statuses.editStatus },
	{
		method: 'DELETE',
		path: '/api/v1/statuses/:id',
		access: { scope: 'write:statuses' },
		handler: statuses.deleteStatus,
	},
	{
		method: 'GET',
		path: '/api/v1/statuses/:id/context',
		access: { scope: 'read:statuses', optional: true },
		handler: statuses.statusContext,
	},
	{
		method: 'GET',
		path: '/api/v1/statuses/:id/history',
		access: { scope: 'read:statuses', optional: true },
		handler: statuses.statusHistory,
	},
	{
		method: 'GET',
		path: '/api/v1/statuses/:id/source',
		access: { scope: 'read:statuses' },
		handler: statuses.statusSource,
	},
	{
		method: 'GET',
		path: '/api/v1/statuses/:id/favourited_by',
		access: { scope: 'read:accounts', optional: true },
		handler: statuses.favouritedBy,
	},
	{
		method: 'GET',
		path: '/api/v1/statuses/:id/reblogged_by',
		access: { scope: 'read:accounts', optional: true },
		handler: statuses.rebloggedBy,
	},
	{
		method: 'POST',
		path: '/api/v1/statuses/:id/favourite',
		access: { scope: 'write:favourites' },
		handler: statuses.favourite,
	},
	{
		method: 'POST',
		path: '/api/v1/statuses/:id/unfavourite',
		access: { scope: 'write:favourites' },
		handler: statuses.unfavourite,
	},
	{
		method: 'POST',
		path: '/api/v1/statuses/:id/reblog',
		access: { scope: 'write:statuses' },
		handler: statuses.reblog,
	},
	{
		method: 'POST',
		path: '/api/v1/statuses/:id/unreblog',
		access: { scope: 'write:statuses' },
		handler: statuses.unreblog,
	},
	{
		method: 'POST',
		path: '/api/v1/statuses/:id/bookmark',
		access: { scope: 'write:bookmarks' },
		handler: statuses.bookmark,
	},
	{
		method: 'POST',
		path: '/api/v1/statuses/:id/unbookmark',
		access: { scope: 'write:bookmarks' },
		handler: statuses.unbookmark,
	},

	{ method: 'GET', path: '/api/v1/timelines/home', access: { scope: 'read:statuses' }, handler: timelines.home },
	{
		method: 'GET',
		path: '/api/v1/timelines/list/:id',
		access: { scope: 'read:lists' },
		handler: timelines.listTimeline,
	},
	{
		method: 'GET',
		path: '/api/v1/timelines/public',
		access: { scope: 'read:statuses', optional: true },
		handler: timelines.publicTimeline,
	},
	{
		method: 'GET',
		path: '/api/v1/timelines/tag/:hashtag',
		access: { scope: 'read:statuses', optional: true },
		handler: timelines.tagTimeline,
	},
	{ method: 'GET', path: '/api/v1/bookmarks', access: { scope: 'read:bookmarks' }, handler: timelines.bookmarks },
	{ method: 'GET', path: '/api/v1/favourites', access: { scope: 'read:favourites' }, handler: timelines.favourites },

	// Lists (mastodon/lists.ts).
	{ method: 'GET', path: '/api/v1/lists', access: { scope: 'read:lists' }, handler: lists.lists },
	{ method: 'POST', path: '/api/v1/lists', access: { scope: 'write:lists' }, handler: lists.createList },
	{ method: 'GET', path: '/api/v1/lists/:id', access: { scope: 'read:lists' }, handler: lists.getList },
	{ method: 'PUT', path: '/api/v1/lists/:id', access: { scope: 'write:lists' }, handler: lists.updateList },
	{ method: 'PATCH', path: '/api/v1/lists/:id', access: { scope: 'write:lists' }, handler: lists.updateList },
	{ method: 'DELETE', path: '/api/v1/lists/:id', access: { scope: 'write:lists' }, handler: lists.deleteList },
	{ method: 'GET', path: '/api/v1/lists/:id/accounts', access: { scope: 'read:lists' }, handler: lists.listAccounts },
	{
		method: 'POST',
		path: '/api/v1/lists/:id/accounts',
		access: { scope: 'write:lists' },
		handler: lists.addListAccounts,
	},
	{
		method: 'DELETE',
		path: '/api/v1/lists/:id/accounts',
		access: { scope: 'write:lists' },
		handler: lists.removeListAccounts,
	},

	// Filters (mastodon/filters.ts): v2, and v1 over the same filters. Fixed paths before their :id siblings.
	{ method: 'GET', path: '/api/v1/filters', access: { scope: 'read:filters' }, handler: filters.listFiltersV1 },
	{ method: 'POST', path: '/api/v1/filters', access: { scope: 'write:filters' }, handler: filters.createFilterV1 },
	{ method: 'GET', path: '/api/v1/filters/:id', access: { scope: 'read:filters' }, handler: filters.getFilterV1 },
	{ method: 'PUT', path: '/api/v1/filters/:id', access: { scope: 'write:filters' }, handler: filters.updateFilterV1 },
	{ method: 'PATCH', path: '/api/v1/filters/:id', access: { scope: 'write:filters' }, handler: filters.updateFilterV1 },
	{
		method: 'DELETE',
		path: '/api/v1/filters/:id',
		access: { scope: 'write:filters' },
		handler: filters.deleteFilterV1,
	},
	{ method: 'GET', path: '/api/v2/filters', access: { scope: 'read:filters' }, handler: filters.listFilters },
	{ method: 'POST', path: '/api/v2/filters', access: { scope: 'write:filters' }, handler: filters.createFilter },
	{
		method: 'GET',
		path: '/api/v2/filters/keywords/:id',
		access: { scope: 'read:filters' },
		handler: filters.getFilterKeyword,
	},
	{
		method: 'PUT',
		path: '/api/v2/filters/keywords/:id',
		access: { scope: 'write:filters' },
		handler: filters.updateFilterKeyword,
	},
	{
		method: 'PATCH',
		path: '/api/v2/filters/keywords/:id',
		access: { scope: 'write:filters' },
		handler: filters.updateFilterKeyword,
	},
	{
		method: 'DELETE',
		path: '/api/v2/filters/keywords/:id',
		access: { scope: 'write:filters' },
		handler: filters.deleteFilterKeyword,
	},
	{
		method: 'GET',
		path: '/api/v2/filters/statuses/:id',
		access: { scope: 'read:filters' },
		handler: filters.getFilterStatus,
	},
	{
		method: 'DELETE',
		path: '/api/v2/filters/statuses/:id',
		access: { scope: 'write:filters' },
		handler: filters.deleteFilterStatus,
	},
	{
		method: 'GET',
		path: '/api/v2/filters/:filter_id/keywords',
		access: { scope: 'read:filters' },
		handler: filters.listFilterKeywords,
	},
	{
		method: 'POST',
		path: '/api/v2/filters/:filter_id/keywords',
		access: { scope: 'write:filters' },
		handler: filters.createFilterKeyword,
	},
	{
		method: 'GET',
		path: '/api/v2/filters/:filter_id/statuses',
		access: { scope: 'read:filters' },
		handler: filters.listFilterStatuses,
	},
	{
		method: 'POST',
		path: '/api/v2/filters/:filter_id/statuses',
		access: { scope: 'write:filters' },
		handler: filters.createFilterStatus,
	},
	{ method: 'GET', path: '/api/v2/filters/:id', access: { scope: 'read:filters' }, handler: filters.getFilter },
	{ method: 'PUT', path: '/api/v2/filters/:id', access: { scope: 'write:filters' }, handler: filters.updateFilter },
	{ method: 'PATCH', path: '/api/v2/filters/:id', access: { scope: 'write:filters' }, handler: filters.updateFilter },
	{ method: 'DELETE', path: '/api/v2/filters/:id', access: { scope: 'write:filters' }, handler: filters.deleteFilter },
	// Conversations (mastodon/conversations.ts).
	{
		method: 'GET',
		path: '/api/v1/conversations',
		access: { scope: 'read:statuses' },
		handler: conversations.conversations,
	},
	{
		method: 'DELETE',
		path: '/api/v1/conversations/:id',
		access: { scope: 'write:conversations' },
		handler: conversations.deleteConversation,
	},
	{
		method: 'POST',
		path: '/api/v1/conversations/:id/read',
		access: { scope: 'write:conversations' },
		handler: conversations.readConversation,
	},
	{
		method: 'POST',
		path: '/api/v1/conversations/:id/unread',
		access: { scope: 'write:conversations' },
		handler: conversations.unreadConversation,
	},
	// Timeline markers (mastodon/markers.ts).
	{ method: 'GET', path: '/api/v1/markers', access: { scope: 'read:statuses' }, handler: markers.markers },
	{ method: 'POST', path: '/api/v1/markers', access: { scope: 'write:statuses' }, handler: markers.saveMarkers },
	// Polls (mastodon/polls.ts); a poll is posted with its status.
	{
		method: 'GET',
		path: '/api/v1/polls/:id',
		access: { scope: 'read:statuses', optional: true },
		handler: polls.showPoll,
	},
	{ method: 'POST', path: '/api/v1/polls/:id/votes', access: { scope: 'write:statuses' }, handler: polls.votePoll },
	// Scheduled statuses (mastodon/scheduled-statuses.ts); scheduling is POST /api/v1/statuses with scheduled_at.
	{ method: 'GET', path: '/api/v1/scheduled_statuses', access: { scope: 'read:statuses' }, handler: scheduled.list },
	{
		method: 'GET',
		path: '/api/v1/scheduled_statuses/:id',
		access: { scope: 'read:statuses' },
		handler: scheduled.show,
	},
	{
		method: 'PUT',
		path: '/api/v1/scheduled_statuses/:id',
		access: { scope: 'write:statuses' },
		handler: scheduled.update,
	},
	{
		method: 'PATCH',
		path: '/api/v1/scheduled_statuses/:id',
		access: { scope: 'write:statuses' },
		handler: scheduled.update,
	},
	{
		method: 'DELETE',
		path: '/api/v1/scheduled_statuses/:id',
		access: { scope: 'write:statuses' },
		handler: scheduled.destroy,
	},

	{ method: 'POST', path: '/api/v1/media', access: { scope: 'write:media' }, handler: media.uploadMedia },
	{ method: 'POST', path: '/api/v2/media', access: { scope: 'write:media' }, handler: media.uploadMedia },
	{ method: 'GET', path: '/api/v1/media/:id', access: { scope: 'write:media' }, handler: media.getMedia },
	{ method: 'PUT', path: '/api/v1/media/:id', access: { scope: 'write:media' }, handler: media.updateMedia },
	{ method: 'PATCH', path: '/api/v1/media/:id', access: { scope: 'write:media' }, handler: media.updateMedia },
	{ method: 'DELETE', path: '/api/v1/media/:id', access: { scope: 'write:media' }, handler: media.deleteMedia },
	// Profile images (mastodon/accounts.ts); they are set from the settings page.
	{
		method: 'DELETE',
		path: '/api/v1/profile/avatar',
		access: { scope: 'write:accounts' },
		handler: accounts.removeAvatar,
	},
	{
		method: 'DELETE',
		path: '/api/v1/profile/header',
		access: { scope: 'write:accounts' },
		handler: accounts.removeHeader,
	},

	// Unauthenticated search is refused (design §6): it would enumerate accounts and load the Store.
	{ method: 'GET', path: '/api/v2/search', access: { scope: 'read:search' }, handler: search.search },

	{
		method: 'GET',
		path: '/api/v1/notifications',
		access: { scope: 'read:notifications' },
		handler: notifications.listNotifications,
	},
	{
		method: 'POST',
		path: '/api/v1/notifications/clear',
		access: { scope: 'write:notifications' },
		handler: notifications.clearNotifications,
	},
	{
		method: 'GET',
		path: '/api/v1/notifications/unread_count',
		access: { scope: 'read:notifications' },
		handler: notificationGroups.unreadCount,
	},
	{
		method: 'GET',
		path: '/api/v1/notifications/:id',
		access: { scope: 'read:notifications' },
		handler: notifications.getNotification,
	},
	{
		method: 'POST',
		path: '/api/v1/notifications/:id/dismiss',
		access: { scope: 'write:notifications' },
		handler: notifications.dismissNotification,
	},
	// Grouped notifications (mastodon/notification-groups.ts).
	{
		method: 'GET',
		path: '/api/v2/notifications',
		access: { scope: 'read:notifications' },
		handler: notificationGroups.listGroupedNotifications,
	},
	{
		method: 'GET',
		path: '/api/v2/notifications/unread_count',
		access: { scope: 'read:notifications' },
		handler: notificationGroups.unreadGroupCount,
	},
	{
		method: 'POST',
		path: '/api/v2/notifications/clear',
		access: { scope: 'write:notifications' },
		handler: notifications.clearNotifications,
	},
	{
		method: 'GET',
		path: '/api/v2/notifications/:group_key',
		access: { scope: 'read:notifications' },
		handler: notificationGroups.getNotificationGroup,
	},
	{
		method: 'POST',
		path: '/api/v2/notifications/:group_key/dismiss',
		access: { scope: 'write:notifications' },
		handler: notificationGroups.dismissNotificationGroup,
	},
	{
		method: 'GET',
		path: '/api/v2/notifications/:group_key/accounts',
		access: { scope: 'read:notifications' },
		handler: notificationGroups.notificationGroupAccounts,
	},

	{ method: 'POST', path: '/api/v1/push/subscription', access: { scope: 'push' }, handler: push.createSubscription },
	{ method: 'GET', path: '/api/v1/push/subscription', access: { scope: 'push' }, handler: push.getSubscription },
	{ method: 'PUT', path: '/api/v1/push/subscription', access: { scope: 'push' }, handler: push.updateSubscription },
	{ method: 'DELETE', path: '/api/v1/push/subscription', access: { scope: 'push' }, handler: push.deleteSubscription },
]

export function mastodonApi(deps: ApiDeps, routes: readonly Route[] = ROUTES): Hono<ApiEnv> {
	const api = new Hono<ApiEnv>()
	for (const route of routes) {
		api.on(route.method, route.path, requireAccess(route.access), (c) => route.handler(c, deps))
	}
	return api
}
