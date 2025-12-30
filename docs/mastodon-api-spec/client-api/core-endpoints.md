# Core Endpoints

This document specifies the essential REST endpoints for Mastodon client applications.

## Instance Information

### GET /api/v1/instance

Retrieve instance information (deprecated, use v2).

**Authentication:** None required

**Deprecation Notice:** Deprecated since 2022-11-14. Clients SHOULD use `/api/v2/instance` instead.

**Response:** See [Instance entity (v1)](entities.md#instance-v1).

**Implementation Reference:** [app/controllers/api/v1/instances_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/instances_controller.rb)

---

### GET /api/v2/instance

Retrieve instance information.

**Authentication:** None required

**Response Example:**

```json
{
  "domain": "mastodon.social",
  "title": "Mastodon",
  "version": "4.3.0",
  "source_url": "https://github.com/mastodon/mastodon",
  "description": "The original server operated by the Mastodon gGmbH non-profit",
  "usage": {
    "users": {
      "active_month": 123456
    }
  },
  "thumbnail": {
    "url": "https://files.mastodon.social/site_uploads/files/000/000/001/original/image.png",
    "blurhash": "UeKUpFxuo~R%0nW;WCnhF6RjaJt757oJodS$"
  },
  "languages": ["en"],
  "configuration": {
    "urls": {
      "streaming": "wss://streaming.mastodon.social",
      "status": null
    },
    "vapid": {
      "public_key": "BCk-QqERU0q-CfYZjcuB6lnyyOYfJ2AifKqfeGIm7Z-HiTU5T9eTG5GxVA0_OH5mMlI4UkkDTpaZwozy0TzdZ2M="
    },
    "accounts": {
      "max_featured_tags": 10,
      "max_pinned_statuses": 5
    },
    "statuses": {
      "max_characters": 500,
      "max_media_attachments": 4,
      "characters_reserved_per_url": 23
    },
    "media_attachments": {
      "supported_mime_types": ["image/jpeg", "image/png", "image/gif", "image/webp", "video/mp4"],
      "image_size_limit": 16777216,
      "image_matrix_limit": 33177600,
      "video_size_limit": 103809024,
      "video_frame_rate_limit": 120,
      "video_matrix_limit": 8294400
    },
    "polls": {
      "max_options": 4,
      "max_characters_per_option": 50,
      "min_expiration": 300,
      "max_expiration": 2629746
    },
    "translation": {
      "enabled": true
    }
  },
  "registrations": {
    "enabled": true,
    "approval_required": false,
    "reason_required": false,
    "message": null,
    "min_age": null
  },
  "contact": {
    "email": "admin@mastodon.social",
    "account": { ... }
  },
  "rules": [
    {
      "id": "1",
      "text": "Sexually explicit or violent media must be marked as sensitive"
    }
  ]
}
```

**Implementation Reference:** [app/controllers/api/v2/instances_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v2/instances_controller.rb)

---

## Accounts

### GET /api/v1/accounts/verify_credentials

Verify and retrieve the authenticated user's account.

**Authentication:** Bearer token required
**Scopes:** `profile`, `read`, `read:accounts`

**Response:** [CredentialAccount entity](entities.md#account) with additional `source` field.

**Response Example:**

```json
{
  "id": "123456",
  "username": "user",
  "acct": "user",
  "display_name": "User Name",
  "locked": false,
  "bot": false,
  "created_at": "2023-01-15T00:00:00.000Z",
  "note": "<p>Bio text</p>",
  "url": "https://mastodon.social/@user",
  "avatar": "https://files.mastodon.social/accounts/avatars/000/123/456/original/avatar.png",
  "header": "https://files.mastodon.social/accounts/headers/000/123/456/original/header.png",
  "followers_count": 100,
  "following_count": 50,
  "statuses_count": 1000,
  "source": {
    "privacy": "public",
    "sensitive": false,
    "language": "en",
    "note": "Bio text (plain)",
    "fields": []
  }
}
```

**Implementation Reference:** [app/controllers/api/v1/accounts/credentials_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/accounts/credentials_controller.rb)

---

### GET /api/v1/accounts/:id

Retrieve an account by ID.

**Authentication:** Optional (provides more data when authenticated)
**Scopes:** `read`, `read:accounts`

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | String | REQUIRED. Account ID |

**Response:** [Account entity](entities.md#account)

**Implementation Reference:** [app/controllers/api/v1/accounts_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/accounts_controller.rb)

---

### GET /api/v1/accounts/lookup

Look up an account by username.

**Authentication:** Optional
**Scopes:** `read`, `read:accounts`

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `acct` | String | REQUIRED. Username or webfinger address (e.g., `user` or `user@example.com`) |

**Response:** [Account entity](entities.md#account)

**Error Responses:**

| Code | Condition |
|------|-----------|
| 404 | Account not found |

**Implementation Reference:** [app/controllers/api/v1/accounts/lookup_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/accounts/lookup_controller.rb)

---

### GET /api/v1/accounts/relationships

Check relationships with accounts.

**Authentication:** Bearer token required
**Scopes:** `read`, `read:follows`

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id[]` | Array | REQUIRED. Array of account IDs to check |
| `with_suspended` | Boolean | Include suspended accounts (default: false) |

**Response:** Array of [Relationship entities](entities.md#relationship)

**Response Example:**

```json
[
  {
    "id": "123456",
    "following": true,
    "showing_reblogs": true,
    "notifying": false,
    "languages": null,
    "followed_by": false,
    "blocking": false,
    "blocked_by": false,
    "muting": false,
    "muting_notifications": false,
    "requested": false,
    "requested_by": false,
    "domain_blocking": false,
    "endorsed": false,
    "note": ""
  }
]
```

**Implementation Reference:** [app/controllers/api/v1/accounts/relationships_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/accounts/relationships_controller.rb)

---

### GET /api/v1/accounts

Retrieve multiple accounts by ID.

**Authentication:** Optional
**Scopes:** `read`, `read:accounts`

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id[]` | Array | REQUIRED. Array of account IDs |

**Response:** Array of [Account entities](entities.md#account)

**Implementation Reference:** [app/controllers/api/v1/accounts_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/accounts_controller.rb)

---

### GET /api/v1/accounts/search

Search for accounts.

**Authentication:** Bearer token required
**Scopes:** `read`, `read:accounts`

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `q` | String | REQUIRED. Search query |
| `limit` | Integer | Maximum results (default: 40) |
| `resolve` | Boolean | Resolve non-local accounts via WebFinger |
| `following` | Boolean | Only return accounts you follow |
| `offset` | Integer | Offset into results |

**Response:** Array of [Account entities](entities.md#account)

**Implementation Reference:** [app/controllers/api/v1/accounts/search_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/accounts/search_controller.rb)

---

### GET /api/v1/accounts/familiar_followers

Get familiar followers for a list of accounts.

**Authentication:** Bearer token required
**Scopes:** `read`, `read:follows`

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id[]` | Array | REQUIRED. Array of account IDs |

**Response:** Array of [FamiliarFollowers entities](entities.md#familiarfollowers)

**Implementation Reference:** [app/controllers/api/v1/accounts/familiar_followers_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/accounts/familiar_followers_controller.rb)

---

### PATCH /api/v1/accounts/update_credentials

Update the authenticated user's account settings.

**Authentication:** Bearer token required
**Scopes:** `write`, `write:accounts`

**Request Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `display_name` | String | Display name |
| `note` | String | Bio/note (HTML will be sanitized) |
| `avatar` | File/String | Avatar image |
| `header` | File/String | Header image |
| `locked` | Boolean | Require follow requests |
| `bot` | Boolean | Mark account as bot |
| `discoverable` | Boolean | Opt into discoverability |
| `hide_collections` | Boolean | Hide followers/following lists |
| `indexable` | Boolean | Opt into search indexing |
| `fields_attributes[][name]` | String | Profile metadata field name |
| `fields_attributes[][value]` | String | Profile metadata field value |
| `source[privacy]` | String | Default post visibility |
| `source[sensitive]` | Boolean | Default sensitive media flag |
| `source[language]` | String | Default post language |
| `source[quote_policy]` | String | Default quote policy |

**Response:** [CredentialAccount entity](entities.md#account) with additional `source` field.

**Implementation Reference:** [app/controllers/api/v1/accounts/credentials_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/accounts/credentials_controller.rb)

---

### GET /api/v1/accounts/:id/statuses

Retrieve statuses for an account.

**Authentication:** Optional
**Scopes:** `read`, `read:statuses`

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `max_id` | String | Return results older than this ID |
| `since_id` | String | Return results newer than this ID |
| `min_id` | String | Return results immediately newer than this ID |
| `limit` | Integer | Maximum results (default: 20, max: 40) |
| `pinned` | Boolean | Only pinned statuses |
| `tagged` | String | Only statuses with the given hashtag |
| `only_media` | Boolean | Only statuses with media |
| `exclude_replies` | Boolean | Exclude replies |
| `exclude_reblogs` | Boolean | Exclude boosts |

**Response:** Array of [Status entities](entities.md#status)

**Implementation Reference:** [app/controllers/api/v1/accounts/statuses_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/accounts/statuses_controller.rb)

---

### GET /api/v1/accounts/:id/followers

Retrieve followers of an account.

**Authentication:** Optional
**Scopes:** `read`, `read:accounts`

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `max_id` | String | Return results older than this ID |
| `since_id` | String | Return results newer than this ID |
| `limit` | Integer | Maximum results (default: 40) |

**Response:** Array of [Account entities](entities.md#account)

**Implementation Reference:** [app/controllers/api/v1/accounts/follower_accounts_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/accounts/follower_accounts_controller.rb)

---

### GET /api/v1/accounts/:id/following

Retrieve accounts followed by an account.

**Authentication:** Optional
**Scopes:** `read`, `read:accounts`

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `max_id` | String | Return results older than this ID |
| `since_id` | String | Return results newer than this ID |
| `limit` | Integer | Maximum results (default: 40) |

**Response:** Array of [Account entities](entities.md#account)

**Implementation Reference:** [app/controllers/api/v1/accounts/following_accounts_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/accounts/following_accounts_controller.rb)

---

### GET /api/v1/accounts/:id/lists

Retrieve lists that include the given account.

**Authentication:** Bearer token required
**Scopes:** `read`, `read:lists`

**Response:** Array of [List entities](entities.md#list)

**Implementation Reference:** [app/controllers/api/v1/accounts/lists_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/accounts/lists_controller.rb)

---

### GET /api/v1/accounts/:id/featured_tags

Retrieve featured tags for an account.

**Authentication:** Optional

**Response:** Array of [FeaturedTag entities](entities.md#featuredtag)

**Implementation Reference:** [app/controllers/api/v1/accounts/featured_tags_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/accounts/featured_tags_controller.rb)

---

### GET /api/v1/accounts/:id/endorsements

Retrieve endorsed accounts for an account.

**Authentication:** Optional
**Scopes:** `read`, `read:accounts`

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `max_id` | String | Return results older than this ID |
| `since_id` | String | Return results newer than this ID |
| `limit` | Integer | Maximum results (default: 40) |

**Response:** Array of [Account entities](entities.md#account)

**Implementation Reference:** [app/controllers/api/v1/accounts/endorsements_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/accounts/endorsements_controller.rb)

---

### GET /api/v1/accounts/:id/identity_proofs

Retrieve identity proofs for an account.

**Authentication:** Bearer token required

**Response:** Array (currently empty)

**Implementation Reference:** [app/controllers/api/v1/accounts/identity_proofs_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/accounts/identity_proofs_controller.rb)

---

### POST /api/v1/accounts/:id/follow

Follow an account.

**Authentication:** Bearer token required
**Scopes:** `follow`, `write`, `write:follows`

**Request Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `reblogs` | Boolean | Show boosts from this account |
| `notify` | Boolean | Receive notifications for this account |
| `languages[]` | Array | Filter by languages |

**Response:** [Relationship entity](entities.md#relationship)

**Implementation Reference:** [app/controllers/api/v1/accounts_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/accounts_controller.rb)

---

### POST /api/v1/accounts/:id/unfollow

Unfollow an account.

**Authentication:** Bearer token required
**Scopes:** `follow`, `write`, `write:follows`

**Response:** [Relationship entity](entities.md#relationship)

**Implementation Reference:** [app/controllers/api/v1/accounts_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/accounts_controller.rb)

---

### POST /api/v1/accounts/:id/remove_from_followers

Remove an account from your followers.

**Authentication:** Bearer token required
**Scopes:** `follow`, `write`, `write:follows`

**Response:** [Relationship entity](entities.md#relationship)

**Implementation Reference:** [app/controllers/api/v1/accounts_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/accounts_controller.rb)

---

### POST /api/v1/accounts/:id/block

Block an account.

**Authentication:** Bearer token required
**Scopes:** `follow`, `write`, `write:blocks`

**Response:** [Relationship entity](entities.md#relationship)

**Implementation Reference:** [app/controllers/api/v1/accounts_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/accounts_controller.rb)

---

### POST /api/v1/accounts/:id/unblock

Unblock an account.

**Authentication:** Bearer token required
**Scopes:** `follow`, `write`, `write:blocks`

**Response:** [Relationship entity](entities.md#relationship)

**Implementation Reference:** [app/controllers/api/v1/accounts_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/accounts_controller.rb)

---

### POST /api/v1/accounts/:id/mute

Mute an account.

**Authentication:** Bearer token required
**Scopes:** `follow`, `write`, `write:mutes`

**Request Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `notifications` | Boolean | Also mute notifications from this account |
| `duration` | Integer | Mute duration in seconds |

**Response:** [Relationship entity](entities.md#relationship)

**Implementation Reference:** [app/controllers/api/v1/accounts_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/accounts_controller.rb)

---

### POST /api/v1/accounts/:id/unmute

Unmute an account.

**Authentication:** Bearer token required
**Scopes:** `follow`, `write`, `write:mutes`

**Response:** [Relationship entity](entities.md#relationship)

**Implementation Reference:** [app/controllers/api/v1/accounts_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/accounts_controller.rb)

---

### POST /api/v1/accounts/:id/note

Set a private note about an account.

**Authentication:** Bearer token required
**Scopes:** `write`, `write:accounts`

**Request Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `comment` | String | Note text (if blank, clears the note) |

**Response:** [Relationship entity](entities.md#relationship)

**Implementation Reference:** [app/controllers/api/v1/accounts/notes_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/accounts/notes_controller.rb)

---

### POST /api/v1/accounts/:id/pin

Endorse (pin) an account.

**Authentication:** Bearer token required
**Scopes:** `write`, `write:accounts`

**Response:** [Relationship entity](entities.md#relationship)

**Implementation Reference:** [app/controllers/api/v1/accounts/endorsements_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/accounts/endorsements_controller.rb)

---

### POST /api/v1/accounts/:id/unpin

Remove an endorsement (unpin) from an account.

**Authentication:** Bearer token required
**Scopes:** `write`, `write:accounts`

**Response:** [Relationship entity](entities.md#relationship)

**Implementation Reference:** [app/controllers/api/v1/accounts/endorsements_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/accounts/endorsements_controller.rb)

---

### POST /api/v1/accounts/:id/endorse

Endorse (pin) an account.

**Authentication:** Bearer token required
**Scopes:** `write`, `write:accounts`

**Response:** [Relationship entity](entities.md#relationship)

**Implementation Reference:** [app/controllers/api/v1/accounts/endorsements_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/accounts/endorsements_controller.rb)

---

### POST /api/v1/accounts/:id/unendorse

Remove an endorsement from an account.

**Authentication:** Bearer token required
**Scopes:** `write`, `write:accounts`

**Response:** [Relationship entity](entities.md#relationship)

**Implementation Reference:** [app/controllers/api/v1/accounts/endorsements_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/accounts/endorsements_controller.rb)

---

## Lists

### GET /api/v1/lists

List your lists.

**Authentication:** Bearer token required
**Scopes:** `read`, `read:lists`

**Response:** Array of [List entities](entities.md#list)

**Implementation Reference:** [app/controllers/api/v1/lists_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/lists_controller.rb)

---

### POST /api/v1/lists

Create a new list.

**Authentication:** Bearer token required
**Scopes:** `write`, `write:lists`

**Request Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `title` | String | REQUIRED. List title |
| `replies_policy` | String | `list`, `followed`, or `none` |
| `exclusive` | Boolean | Whether the list is exclusive |

**Response:** [List entity](entities.md#list)

**Implementation Reference:** [app/controllers/api/v1/lists_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/lists_controller.rb)

---

### GET /api/v1/lists/:id

Retrieve a list.

**Authentication:** Bearer token required
**Scopes:** `read`, `read:lists`

**Response:** [List entity](entities.md#list)

**Implementation Reference:** [app/controllers/api/v1/lists_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/lists_controller.rb)

---

### PATCH /api/v1/lists/:id

Update a list.

**Authentication:** Bearer token required
**Scopes:** `write`, `write:lists`

**Request Parameters:** Same as create.

**Response:** [List entity](entities.md#list)

**Implementation Reference:** [app/controllers/api/v1/lists_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/lists_controller.rb)

---

### PUT /api/v1/lists/:id

Update a list.

**Authentication:** Bearer token required
**Scopes:** `write`, `write:lists`

**Request Parameters:** Same as create.

**Response:** [List entity](entities.md#list)

**Implementation Reference:** [app/controllers/api/v1/lists_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/lists_controller.rb)

---

### DELETE /api/v1/lists/:id

Delete a list.

**Authentication:** Bearer token required
**Scopes:** `write`, `write:lists`

**Response:** Empty object

**Implementation Reference:** [app/controllers/api/v1/lists_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/lists_controller.rb)

---

### GET /api/v1/lists/:id/accounts

List accounts in a list.

**Authentication:** Bearer token required
**Scopes:** `read`, `read:lists`

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `max_id` | String | Return results older than this ID |
| `since_id` | String | Return results newer than this ID |
| `limit` | Integer | Maximum results (default: 40). Use `0` for unlimited |

**Response:** Array of [Account entities](entities.md#account)

**Implementation Reference:** [app/controllers/api/v1/lists/accounts_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/lists/accounts_controller.rb)

---

### POST /api/v1/lists/:id/accounts

Add accounts to a list.

**Authentication:** Bearer token required
**Scopes:** `write`, `write:lists`

**Request Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `account_ids[]` | Array | REQUIRED. Account IDs to add |

**Response:** Empty object

**Implementation Reference:** [app/controllers/api/v1/lists/accounts_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/lists/accounts_controller.rb)

---

### DELETE /api/v1/lists/:id/accounts

Remove accounts from a list.

**Authentication:** Bearer token required
**Scopes:** `write`, `write:lists`

**Request Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `account_ids[]` | Array | REQUIRED. Account IDs to remove |

**Response:** Empty object

**Implementation Reference:** [app/controllers/api/v1/lists/accounts_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/lists/accounts_controller.rb)

---

## Featured Tags

### GET /api/v1/featured_tags

List your featured tags.

**Authentication:** Bearer token required
**Scopes:** `read`, `read:accounts`

**Response:** Array of [FeaturedTag entities](entities.md#featuredtag)

**Implementation Reference:** [app/controllers/api/v1/featured_tags_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/featured_tags_controller.rb)

---

### POST /api/v1/featured_tags

Feature a hashtag on your profile.

**Authentication:** Bearer token required
**Scopes:** `write`, `write:accounts`

**Request Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | String | REQUIRED. Hashtag name (without #) |

**Response:** [FeaturedTag entity](entities.md#featuredtag)

**Implementation Reference:** [app/controllers/api/v1/featured_tags_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/featured_tags_controller.rb)

---

### DELETE /api/v1/featured_tags/:id

Remove a featured tag.

**Authentication:** Bearer token required
**Scopes:** `write`, `write:accounts`

**Response:** Empty object

**Implementation Reference:** [app/controllers/api/v1/featured_tags_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/featured_tags_controller.rb)

---

### GET /api/v1/featured_tags/suggestions

List recently used tags that may be suggested for featuring.

**Authentication:** Bearer token required
**Scopes:** `read`, `read:accounts`

**Response:** Array of Tag objects

**Implementation Reference:** [app/controllers/api/v1/featured_tags/suggestions_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/featured_tags/suggestions_controller.rb)
## Filters

### GET /api/v1/filters

List v1 filters.

**Deprecation Notice:** Deprecated since 2022-11-14. Clients SHOULD use the v2 filters API.

**Authentication:** Bearer token required
**Scopes:** `read`, `read:filters`

**Response:** Array of [Filter (v1) entities](entities.md#filter-v1)

**Implementation Reference:** [app/controllers/api/v1/filters_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/filters_controller.rb)

---

### POST /api/v1/filters

Create a v1 filter.

**Deprecation Notice:** Deprecated since 2022-11-14. Clients SHOULD use the v2 filters API.

**Authentication:** Bearer token required
**Scopes:** `write`, `write:filters`

**Request Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `phrase` | String | REQUIRED. Filter phrase |
| `context[]` | Array | REQUIRED. Filter contexts |
| `expires_in` | Integer | Seconds until expiration |
| `irreversible` | Boolean | Whether filter is irreversible |
| `whole_word` | Boolean | Whole-word matching |

**Response:** [Filter (v1) entity](entities.md#filter-v1)

**Implementation Reference:** [app/controllers/api/v1/filters_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/filters_controller.rb)

---

### GET /api/v1/filters/:id

Retrieve a v1 filter.

**Deprecation Notice:** Deprecated since 2022-11-14. Clients SHOULD use the v2 filters API.

**Authentication:** Bearer token required
**Scopes:** `read`, `read:filters`

**Response:** [Filter (v1) entity](entities.md#filter-v1)

**Implementation Reference:** [app/controllers/api/v1/filters_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/filters_controller.rb)

---

### PATCH /api/v1/filters/:id

Update a v1 filter.

**Deprecation Notice:** Deprecated since 2022-11-14. Clients SHOULD use the v2 filters API.

**Authentication:** Bearer token required
**Scopes:** `write`, `write:filters`

**Request Parameters:** Same as create.

**Response:** [Filter (v1) entity](entities.md#filter-v1)

**Implementation Reference:** [app/controllers/api/v1/filters_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/filters_controller.rb)

---

### PUT /api/v1/filters/:id

Update a v1 filter.

**Deprecation Notice:** Deprecated since 2022-11-14. Clients SHOULD use the v2 filters API.

**Authentication:** Bearer token required
**Scopes:** `write`, `write:filters`

**Request Parameters:** Same as create.

**Response:** [Filter (v1) entity](entities.md#filter-v1)

**Implementation Reference:** [app/controllers/api/v1/filters_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/filters_controller.rb)

---

### DELETE /api/v1/filters/:id

Delete a v1 filter.

**Deprecation Notice:** Deprecated since 2022-11-14. Clients SHOULD use the v2 filters API.

**Authentication:** Bearer token required
**Scopes:** `write`, `write:filters`

**Response:** Empty object

**Implementation Reference:** [app/controllers/api/v1/filters_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/filters_controller.rb)

---

### GET /api/v2/filters

List v2 filters.

**Authentication:** Bearer token required
**Scopes:** `read`, `read:filters`

**Response:** Array of [Filter entities](entities.md#filter)

**Implementation Reference:** [app/controllers/api/v2/filters_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v2/filters_controller.rb)

---

### POST /api/v2/filters

Create a v2 filter.

**Authentication:** Bearer token required
**Scopes:** `write`, `write:filters`

**Request Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `title` | String | REQUIRED. Filter title |
| `expires_in` | Integer | Seconds until expiration |
| `filter_action` | String | Filter action |
| `context[]` | Array | Filter contexts |
| `keywords_attributes[][id]` | String | Existing keyword ID |
| `keywords_attributes[][keyword]` | String | Keyword text |
| `keywords_attributes[][whole_word]` | Boolean | Whole-word matching |
| `keywords_attributes[][_destroy]` | Boolean | Delete keyword rule |

**Response:** [Filter entity](entities.md#filter)

**Implementation Reference:** [app/controllers/api/v2/filters_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v2/filters_controller.rb)

---

### GET /api/v2/filters/:id

Retrieve a v2 filter.

**Authentication:** Bearer token required
**Scopes:** `read`, `read:filters`

**Response:** [Filter entity](entities.md#filter)

**Implementation Reference:** [app/controllers/api/v2/filters_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v2/filters_controller.rb)

---

### PATCH /api/v2/filters/:id

Update a v2 filter.

**Authentication:** Bearer token required
**Scopes:** `write`, `write:filters`

**Request Parameters:** Same as create.

**Response:** [Filter entity](entities.md#filter)

**Implementation Reference:** [app/controllers/api/v2/filters_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v2/filters_controller.rb)

---

### PUT /api/v2/filters/:id

Update a v2 filter.

**Authentication:** Bearer token required
**Scopes:** `write`, `write:filters`

**Request Parameters:** Same as create.

**Response:** [Filter entity](entities.md#filter)

**Implementation Reference:** [app/controllers/api/v2/filters_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v2/filters_controller.rb)

---

### DELETE /api/v2/filters/:id

Delete a v2 filter.

**Authentication:** Bearer token required
**Scopes:** `write`, `write:filters`

**Response:** Empty object

**Implementation Reference:** [app/controllers/api/v2/filters_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v2/filters_controller.rb)

---

### GET /api/v2/filters/:id/keywords

List keyword rules for a filter.

**Authentication:** Bearer token required
**Scopes:** `read`, `read:filters`

**Response:** Array of [FilterKeyword entities](entities.md#filterkeyword)

**Implementation Reference:** [app/controllers/api/v2/filters/keywords_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v2/filters/keywords_controller.rb)

---

### POST /api/v2/filters/:id/keywords

Create a keyword rule for a filter.

**Authentication:** Bearer token required
**Scopes:** `write`, `write:filters`

**Request Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `keyword` | String | REQUIRED. Keyword text |
| `whole_word` | Boolean | Whole-word matching |

**Response:** [FilterKeyword entity](entities.md#filterkeyword)

**Implementation Reference:** [app/controllers/api/v2/filters/keywords_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v2/filters/keywords_controller.rb)

---

### GET /api/v2/filters/keywords/:id

Retrieve a keyword rule.

**Authentication:** Bearer token required
**Scopes:** `read`, `read:filters`

**Response:** [FilterKeyword entity](entities.md#filterkeyword)

**Implementation Reference:** [app/controllers/api/v2/filters/keywords_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v2/filters/keywords_controller.rb)

---

### PATCH /api/v2/filters/keywords/:id

Update a keyword rule.

**Authentication:** Bearer token required
**Scopes:** `write`, `write:filters`

**Request Parameters:** Same as create.

**Response:** [FilterKeyword entity](entities.md#filterkeyword)

**Implementation Reference:** [app/controllers/api/v2/filters/keywords_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v2/filters/keywords_controller.rb)

---

### PUT /api/v2/filters/keywords/:id

Update a keyword rule.

**Authentication:** Bearer token required
**Scopes:** `write`, `write:filters`

**Request Parameters:** Same as create.

**Response:** [FilterKeyword entity](entities.md#filterkeyword)

**Implementation Reference:** [app/controllers/api/v2/filters/keywords_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v2/filters/keywords_controller.rb)

---

### DELETE /api/v2/filters/keywords/:id

Delete a keyword rule.

**Authentication:** Bearer token required
**Scopes:** `write`, `write:filters`

**Response:** Empty object

**Implementation Reference:** [app/controllers/api/v2/filters/keywords_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v2/filters/keywords_controller.rb)

---

### GET /api/v2/filters/:id/statuses

List status rules for a filter.

**Authentication:** Bearer token required
**Scopes:** `read`, `read:filters`

**Response:** Array of [FilterStatus entities](entities.md#filterstatus)

**Implementation Reference:** [app/controllers/api/v2/filters/statuses_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v2/filters/statuses_controller.rb)

---

### POST /api/v2/filters/:id/statuses

Create a status rule for a filter.

**Authentication:** Bearer token required
**Scopes:** `write`, `write:filters`

**Request Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `status_id` | String | REQUIRED. Status ID |

**Response:** [FilterStatus entity](entities.md#filterstatus)

**Implementation Reference:** [app/controllers/api/v2/filters/statuses_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v2/filters/statuses_controller.rb)

---

### GET /api/v2/filters/statuses/:id

Retrieve a status rule.

**Authentication:** Bearer token required
**Scopes:** `read`, `read:filters`

**Response:** [FilterStatus entity](entities.md#filterstatus)

**Implementation Reference:** [app/controllers/api/v2/filters/statuses_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v2/filters/statuses_controller.rb)

---

### DELETE /api/v2/filters/statuses/:id

Delete a status rule.

**Authentication:** Bearer token required
**Scopes:** `write`, `write:filters`

**Response:** Empty object

**Implementation Reference:** [app/controllers/api/v2/filters/statuses_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v2/filters/statuses_controller.rb)

---

## Statuses

### GET /api/v1/statuses

Retrieve multiple statuses by ID.

**Authentication:** Bearer token required
**Scopes:** `read`, `read:statuses`

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id[]` | Array | REQUIRED. Array of status IDs |

**Response:** Array of [Status entities](entities.md#status)

**Implementation Reference:** [app/controllers/api/v1/statuses_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/statuses_controller.rb)

---

### POST /api/v1/statuses

Create a new status (post).

**Authentication:** Bearer token required
**Scopes:** `write`, `write:statuses`

**Headers:**

| Header | Description |
|--------|-------------|
| `Idempotency-Key` | Optional. Prevents duplicate creation |

**Request Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `status` | String | Text content of the status |
| `media_ids[]` | Array | Array of media attachment IDs |
| `poll[options][]` | Array | Poll options (if creating a poll) |
| `poll[expires_in]` | Integer | Poll duration in seconds |
| `poll[multiple]` | Boolean | Allow multiple choices |
| `poll[hide_totals]` | Boolean | Hide vote counts until poll ends |
| `in_reply_to_id` | String | ID of status to reply to |
| `quoted_status_id` | String | ID of status to quote |
| `sensitive` | Boolean | Mark media as sensitive |
| `spoiler_text` | String | Content warning text |
| `visibility` | String | `public`, `unlisted`, `private`, `direct` |
| `language` | String | ISO 639 language code |
| `scheduled_at` | String | ISO 8601 datetime for scheduled post |

**Request Example:**

```http
POST /api/v1/statuses HTTP/1.1
Authorization: Bearer access_token
Content-Type: application/json

{
  "status": "Hello, world!",
  "visibility": "public"
}
```

**Response:** [Status entity](entities.md#status) or [ScheduledStatus entity](entities.md#scheduledstatus) if `scheduled_at` is provided.

**Rate Limiting:** This endpoint has enhanced rate limiting under the `statuses` family.

**Implementation Reference:** [app/controllers/api/v1/statuses_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/statuses_controller.rb)

---

### GET /api/v1/statuses/:id

Retrieve a status by ID.

**Authentication:** Optional
**Scopes:** `read`, `read:statuses`

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | String | REQUIRED. Status ID |

**Response:** [Status entity](entities.md#status)

**Implementation Reference:** [app/controllers/api/v1/statuses_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/statuses_controller.rb)

---

### PUT /api/v1/statuses/:id

Edit an existing status.

**Authentication:** Bearer token required
**Scopes:** `write`, `write:statuses`

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | String | REQUIRED. Status ID |

**Request Parameters:** Same as POST, plus:

| Parameter | Type | Description |
|-----------|------|-------------|
| `media_attributes[][id]` | String | Existing media attachment ID |
| `media_attributes[][description]` | String | Updated description |
| `media_attributes[][focus]` | String | Updated focus point |

**Response:** [Status entity](entities.md#status)

**Authorization:** User MUST own the status.

**Implementation Reference:** [app/controllers/api/v1/statuses_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/statuses_controller.rb)

---

### PATCH /api/v1/statuses/:id

Edit an existing status.

**Authentication:** Bearer token required
**Scopes:** `write`, `write:statuses`

**Request Parameters:** Same as PUT.

**Response:** [Status entity](entities.md#status)

**Implementation Reference:** [app/controllers/api/v1/statuses_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/statuses_controller.rb)

---

### DELETE /api/v1/statuses/:id

Delete a status.

**Authentication:** Bearer token required
**Scopes:** `write`, `write:statuses`

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | String | REQUIRED. Status ID |

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `delete_media` | Boolean | Also delete associated media (default: false) |

**Response:** The deleted [Status entity](entities.md#status) with `text` field (for redraft).

**Authorization:** User MUST own the status.

**Implementation Reference:** [app/controllers/api/v1/statuses_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/statuses_controller.rb)

---

### GET /api/v1/statuses/:id/context

Retrieve ancestors and descendants of a status.

**Authentication:** Optional
**Scopes:** `read`, `read:statuses`

**Response Example:**

```json
{
  "ancestors": [...],
  "descendants": [...]
}
```

**Limits:**
- Unauthenticated: 40 ancestors, 60 descendants (depth 20)
- Authenticated: 4096 each

**Implementation Reference:** [app/controllers/api/v1/statuses_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/statuses_controller.rb)

---

### GET /api/v1/statuses/:id/reblogged_by

List accounts that boosted a status.

**Authentication:** Optional
**Scopes:** `read`, `read:accounts`

**Response:** Array of [Account entities](entities.md#account)

**Implementation Reference:** [app/controllers/api/v1/statuses/reblogged_by_accounts_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/statuses/reblogged_by_accounts_controller.rb)

---

### GET /api/v1/statuses/:id/favourited_by

List accounts that favourited a status.

**Authentication:** Optional
**Scopes:** `read`, `read:accounts`

**Response:** Array of [Account entities](entities.md#account)

**Implementation Reference:** [app/controllers/api/v1/statuses/favourited_by_accounts_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/statuses/favourited_by_accounts_controller.rb)

---

### POST /api/v1/statuses/:id/reblog

Boost a status.

**Authentication:** Bearer token required
**Scopes:** `write`, `write:statuses`

**Request Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `visibility` | String | Override visibility for the boost |

**Response:** [Status entity](entities.md#status)

**Implementation Reference:** [app/controllers/api/v1/statuses/reblogs_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/statuses/reblogs_controller.rb)

---

### POST /api/v1/statuses/:id/unreblog

Remove your boost of a status.

**Authentication:** Bearer token required
**Scopes:** `write`, `write:statuses`

**Response:** [Status entity](entities.md#status)

**Implementation Reference:** [app/controllers/api/v1/statuses/reblogs_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/statuses/reblogs_controller.rb)

---

### POST /api/v1/statuses/:id/favourite

Favourite a status.

**Authentication:** Bearer token required
**Scopes:** `write`, `write:favourites`

**Response:** [Status entity](entities.md#status)

**Implementation Reference:** [app/controllers/api/v1/statuses/favourites_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/statuses/favourites_controller.rb)

---

### POST /api/v1/statuses/:id/unfavourite

Unfavourite a status.

**Authentication:** Bearer token required
**Scopes:** `write`, `write:favourites`

**Response:** [Status entity](entities.md#status)

**Implementation Reference:** [app/controllers/api/v1/statuses/favourites_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/statuses/favourites_controller.rb)

---

### POST /api/v1/statuses/:id/bookmark

Bookmark a status.

**Authentication:** Bearer token required
**Scopes:** `write`, `write:bookmarks`

**Response:** [Status entity](entities.md#status)

**Implementation Reference:** [app/controllers/api/v1/statuses/bookmarks_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/statuses/bookmarks_controller.rb)

---

### POST /api/v1/statuses/:id/unbookmark

Remove bookmark from a status.

**Authentication:** Bearer token required
**Scopes:** `write`, `write:bookmarks`

**Response:** [Status entity](entities.md#status)

**Implementation Reference:** [app/controllers/api/v1/statuses/bookmarks_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/statuses/bookmarks_controller.rb)

---

### POST /api/v1/statuses/:id/mute

Mute notifications from a conversation.

**Authentication:** Bearer token required
**Scopes:** `write`, `write:mutes`

**Response:** [Status entity](entities.md#status)

**Implementation Reference:** [app/controllers/api/v1/statuses/mutes_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/statuses/mutes_controller.rb)

---

### POST /api/v1/statuses/:id/unmute

Unmute notifications from a conversation.

**Authentication:** Bearer token required
**Scopes:** `write`, `write:mutes`

**Response:** [Status entity](entities.md#status)

**Implementation Reference:** [app/controllers/api/v1/statuses/mutes_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/statuses/mutes_controller.rb)

---

### POST /api/v1/statuses/:id/pin

Pin a status to your profile.

**Authentication:** Bearer token required
**Scopes:** `write`, `write:accounts`

**Response:** [Status entity](entities.md#status)

**Implementation Reference:** [app/controllers/api/v1/statuses/pins_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/statuses/pins_controller.rb)

---

### POST /api/v1/statuses/:id/unpin

Unpin a status from your profile.

**Authentication:** Bearer token required
**Scopes:** `write`, `write:accounts`

**Response:** [Status entity](entities.md#status)

**Implementation Reference:** [app/controllers/api/v1/statuses/pins_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/statuses/pins_controller.rb)

---

### GET /api/v1/statuses/:id/history

Retrieve edit history for a status.

**Authentication:** Optional
**Scopes:** `read`, `read:statuses`

**Response:** [StatusEdit entity](entities.md#statusedit)

**Implementation Reference:** [app/controllers/api/v1/statuses/histories_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/statuses/histories_controller.rb)

---

### GET /api/v1/statuses/:id/source

Retrieve the source text of a status.

**Authentication:** Bearer token required
**Scopes:** `read`, `read:statuses`

**Response:** [StatusSource entity](entities.md#statussource)

**Implementation Reference:** [app/controllers/api/v1/statuses/sources_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/statuses/sources_controller.rb)

---

### PATCH /api/v1/statuses/:id/interaction_policy

Update interaction policy for a status.

**Authentication:** Bearer token required
**Scopes:** `write`, `write:statuses`

**Response:** [Status entity](entities.md#status)

**Implementation Reference:** [app/controllers/api/v1/statuses/interaction_policies_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/statuses/interaction_policies_controller.rb)

---

### PUT /api/v1/statuses/:id/interaction_policy

Update interaction policy for a status.

**Authentication:** Bearer token required
**Scopes:** `write`, `write:statuses`

**Response:** [Status entity](entities.md#status)

**Implementation Reference:** [app/controllers/api/v1/statuses/interaction_policies_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/statuses/interaction_policies_controller.rb)

---

### POST /api/v1/statuses/:id/translate

Translate a status into the current locale.

**Authentication:** Bearer token required
**Scopes:** `read`, `read:statuses`

**Response:** [Translation entity](entities.md#translation)

**Implementation Reference:** [app/controllers/api/v1/statuses/translations_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/statuses/translations_controller.rb)

---

### GET /api/v1/statuses/:id/quotes

List statuses that quote a status.

**Authentication:** Optional
**Scopes:** `read`, `read:statuses`

**Response:** Array of [Status entities](entities.md#status)

**Implementation Reference:** [app/controllers/api/v1/statuses/quotes_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/statuses/quotes_controller.rb)

---

### POST /api/v1/statuses/:id/quotes/:id/revoke

Revoke a quote authorization.

**Authentication:** Bearer token required
**Scopes:** `write`, `write:statuses`

**Response:** [Status entity](entities.md#status)

**Implementation Reference:** [app/controllers/api/v1/statuses/quotes_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/statuses/quotes_controller.rb)

---

## Timelines

### GET /api/v1/timelines/home

Retrieve home timeline.

**Authentication:** Bearer token required
**Scopes:** `read`, `read:statuses`

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `max_id` | String | Return results older than this ID |
| `since_id` | String | Return results newer than this ID |
| `min_id` | String | Return results immediately newer than this ID |
| `limit` | Integer | Maximum results (default: 20, max: 40) |
| `local` | Boolean | Only local statuses |

**Response:** Array of [Status entities](entities.md#status)

**Special Response Codes:**

| Code | Meaning |
|------|---------|
| 200 | Success |
| 206 | Feed is regenerating, partial results |

**Implementation Reference:** [app/controllers/api/v1/timelines/home_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/timelines/home_controller.rb)

---

### GET /api/v1/timelines/public

Retrieve public timeline.

**Authentication:** Optional (may be required by server configuration)
**Scopes:** `read`, `read:statuses`

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `local` | Boolean | Only local statuses |
| `remote` | Boolean | Only remote statuses |
| `only_media` | Boolean | Only statuses with media |
| `max_id` | String | Return results older than this ID |
| `since_id` | String | Return results newer than this ID |
| `min_id` | String | Return results immediately newer than this ID |
| `limit` | Integer | Maximum results (default: 20, max: 40) |

**Response:** Array of [Status entities](entities.md#status)

**Implementation Reference:** [app/controllers/api/v1/timelines/public_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/timelines/public_controller.rb)

---

### GET /api/v1/timelines/tag/:hashtag

Retrieve hashtag timeline.

**Authentication:** Optional
**Scopes:** `read`, `read:statuses`

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `hashtag` | String | REQUIRED. Hashtag (without #) |

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `local` | Boolean | Only local statuses |
| `remote` | Boolean | Only remote statuses |
| `only_media` | Boolean | Only statuses with media |
| `any[]` | Array | Additional hashtags to include (OR) |
| `all[]` | Array | Additional hashtags required (AND) |
| `none[]` | Array | Hashtags to exclude |
| `max_id` | String | Return results older than this ID |
| `since_id` | String | Return results newer than this ID |
| `min_id` | String | Return results immediately newer than this ID |
| `limit` | Integer | Maximum results (default: 20, max: 40) |

**Response:** Array of [Status entities](entities.md#status)

**Implementation Reference:** [app/controllers/api/v1/timelines/tag_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/timelines/tag_controller.rb)

---

## Notifications

### GET /api/v1/notifications

Retrieve notifications.

**Authentication:** Bearer token required
**Scopes:** `read`, `read:notifications`

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `max_id` | String | Return results older than this ID |
| `since_id` | String | Return results newer than this ID |
| `min_id` | String | Return results immediately newer than this ID |
| `limit` | Integer | Maximum results (default: 40) |
| `types[]` | Array | Filter to specific notification types |
| `exclude_types[]` | Array | Exclude specific notification types |
| `account_id` | String | Filter to notifications from this account |
| `include_filtered` | Boolean | Include filtered notifications |

**Notification Types:**

- `mention` - Someone mentioned you
- `status` - Someone you follow posted
- `reblog` - Someone boosted your status
- `follow` - Someone followed you
- `follow_request` - Someone requested to follow you
- `favourite` - Someone favourited your status
- `poll` - A poll you voted in has ended
- `update` - A status you interacted with was edited
- `admin.sign_up` - Someone signed up (admin only)
- `admin.report` - New report submitted (admin only)
- `severed_relationships` - Relationships severed due to moderation
- `moderation_warning` - You received a moderation warning
- `quote` - Someone quoted your status
- `quoted_update` - A quoted status was updated

**Response:** Array of [Notification entities](entities.md#notification)

**Implementation Reference:** [app/controllers/api/v1/notifications_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/notifications_controller.rb)

---

### GET /api/v1/notifications/unread_count

Get unread notification count.

**Authentication:** Bearer token required
**Scopes:** `read`, `read:notifications`

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `limit` | Integer | Maximum to count (default: 100, max: 1000) |

**Response Example:**

```json
{
  "count": 42
}
```

**Implementation Reference:** [app/controllers/api/v1/notifications_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/notifications_controller.rb)

---

### GET /api/v1/notifications/:id

Retrieve a notification by ID.

**Authentication:** Bearer token required
**Scopes:** `read`, `read:notifications`

**Response:** [Notification entity](entities.md#notification)

**Implementation Reference:** [app/controllers/api/v1/notifications_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/notifications_controller.rb)

---

### POST /api/v1/notifications/clear

Clear all notifications.

**Authentication:** Bearer token required
**Scopes:** `write`, `write:notifications`

**Response:** Empty object

**Implementation Reference:** [app/controllers/api/v1/notifications_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/notifications_controller.rb)

---

### POST /api/v1/notifications/:id/dismiss

Dismiss a notification by ID.

**Authentication:** Bearer token required
**Scopes:** `write`, `write:notifications`

**Response:** Empty object

**Implementation Reference:** [app/controllers/api/v1/notifications_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/notifications_controller.rb)

---

### GET /api/v1/notifications/policy

Retrieve notification policy (v1 format).

**Authentication:** Bearer token required
**Scopes:** `read`, `read:notifications`

**Response:** [NotificationPolicy (v1) entity](entities.md#notificationpolicy-v1)

**Implementation Reference:** [app/controllers/api/v1/notifications/policies_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/notifications/policies_controller.rb)

---

### PUT /api/v1/notifications/policy

Update notification policy (v1 format).

**Authentication:** Bearer token required
**Scopes:** `write`, `write:notifications`

**Request Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `filter_not_following` | Boolean | Filter notifications from accounts you do not follow |
| `filter_not_followers` | Boolean | Filter notifications from accounts that do not follow you |
| `filter_new_accounts` | Boolean | Filter notifications from new accounts |
| `filter_private_mentions` | Boolean | Filter private mention notifications |

**Response:** [NotificationPolicy (v1) entity](entities.md#notificationpolicy-v1)

**Implementation Reference:** [app/controllers/api/v1/notifications/policies_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/notifications/policies_controller.rb)

---

### GET /api/v1/notifications/requests

List notification requests.

**Authentication:** Bearer token required
**Scopes:** `read`, `read:notifications`

**Response:** Array of [NotificationRequest entities](entities.md#notificationrequest)

**Implementation Reference:** [app/controllers/api/v1/notifications/requests_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/notifications/requests_controller.rb)

---

### GET /api/v1/notifications/requests/merged

Return whether notification request unfilter jobs are merged.

**Authentication:** Bearer token required
**Scopes:** `read`, `read:notifications`

**Response Example:**

```json
{ "merged": true }
```

**Implementation Reference:** [app/controllers/api/v1/notifications/requests_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/notifications/requests_controller.rb)

---

### GET /api/v1/notifications/requests/:id

Retrieve a notification request.

**Authentication:** Bearer token required
**Scopes:** `read`, `read:notifications`

**Response:** [NotificationRequest entity](entities.md#notificationrequest)

**Implementation Reference:** [app/controllers/api/v1/notifications/requests_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/notifications/requests_controller.rb)

---

### POST /api/v1/notifications/requests/:id/accept

Accept a notification request.

**Authentication:** Bearer token required
**Scopes:** `write`, `write:notifications`

**Response:** Empty object

**Implementation Reference:** [app/controllers/api/v1/notifications/requests_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/notifications/requests_controller.rb)

---

### POST /api/v1/notifications/requests/:id/dismiss

Dismiss a notification request.

**Authentication:** Bearer token required
**Scopes:** `write`, `write:notifications`

**Response:** Empty object

**Implementation Reference:** [app/controllers/api/v1/notifications/requests_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/notifications/requests_controller.rb)

---

### POST /api/v1/notifications/requests/accept

Accept multiple notification requests.

**Authentication:** Bearer token required
**Scopes:** `write`, `write:notifications`

**Request Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id[]` | Array | REQUIRED. Request IDs |

**Response:** Empty object

**Implementation Reference:** [app/controllers/api/v1/notifications/requests_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/notifications/requests_controller.rb)

---

### POST /api/v1/notifications/requests/dismiss

Dismiss multiple notification requests.

**Authentication:** Bearer token required
**Scopes:** `write`, `write:notifications`

**Request Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id[]` | Array | REQUIRED. Request IDs |

**Response:** Empty object

**Implementation Reference:** [app/controllers/api/v1/notifications/requests_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/notifications/requests_controller.rb)

---

### GET /api/v2/notifications

Retrieve grouped notifications (v2).

**Authentication:** Bearer token required
**Scopes:** `read`, `read:notifications`

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `max_id` | String | Return results older than this ID |
| `since_id` | String | Return results newer than this ID |
| `min_id` | String | Return results immediately newer than this ID |
| `limit` | Integer | Maximum results (default: 40) |
| `types[]` | Array | Filter to specific notification types |
| `exclude_types[]` | Array | Exclude specific notification types |
| `include_filtered` | Boolean | Include filtered notifications |
| `grouped_types[]` | Array | Grouping types |
| `expand_accounts` | String | `full` or `partial_avatars` |

**Response:** [DedupNotificationGroupResponse entity](entities.md#dedupnotificationgroupresponse)

**Implementation Reference:** [app/controllers/api/v2/notifications_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v2/notifications_controller.rb)

---

### GET /api/v2/notifications/unread_count

Get unread notification count (v2).

**Authentication:** Bearer token required
**Scopes:** `read`, `read:notifications`

**Response Example:**

```json
{ "count": 42 }
```

**Implementation Reference:** [app/controllers/api/v2/notifications_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v2/notifications_controller.rb)

---

### GET /api/v2/notifications/:group_key

Retrieve a single grouped notification entry.

**Authentication:** Bearer token required
**Scopes:** `read`, `read:notifications`

**Response:** [DedupNotificationGroupResponse entity](entities.md#dedupnotificationgroupresponse)

**Implementation Reference:** [app/controllers/api/v2/notifications_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v2/notifications_controller.rb)

---

### POST /api/v2/notifications/clear

Clear all notifications (v2).

**Authentication:** Bearer token required
**Scopes:** `write`, `write:notifications`

**Response:** Empty object

**Implementation Reference:** [app/controllers/api/v2/notifications_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v2/notifications_controller.rb)

---

### POST /api/v2/notifications/:group_key/dismiss

Dismiss a grouped notification entry.

**Authentication:** Bearer token required
**Scopes:** `write`, `write:notifications`

**Response:** Empty object

**Implementation Reference:** [app/controllers/api/v2/notifications_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v2/notifications_controller.rb)

---

### GET /api/v2/notifications/:group_key/accounts

List accounts involved in a notification group.

**Authentication:** Bearer token required
**Scopes:** `read`, `read:notifications`

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `max_id` | String | Return results older than this ID |
| `since_id` | String | Return results newer than this ID |
| `limit` | Integer | Maximum results (default: 40) |

**Response:** Array of [Account entities](entities.md#account)

**Implementation Reference:** [app/controllers/api/v2/notifications/accounts_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v2/notifications/accounts_controller.rb)

---

### GET /api/v2/notifications/policy

Retrieve notification policy (v2 format).

**Authentication:** Bearer token required
**Scopes:** `read`, `read:notifications`

**Response:** [NotificationPolicy entity](entities.md#notificationpolicy)

**Implementation Reference:** [app/controllers/api/v2/notifications/policies_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v2/notifications/policies_controller.rb)

---

### PUT /api/v2/notifications/policy

Update notification policy (v2 format).

**Authentication:** Bearer token required
**Scopes:** `write`, `write:notifications`

**Request Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `for_not_following` | Boolean | Filtering for accounts you do not follow |
| `for_not_followers` | Boolean | Filtering for accounts that do not follow you |
| `for_new_accounts` | Boolean | Filtering for new accounts |
| `for_private_mentions` | Boolean | Filtering for private mentions |
| `for_limited_accounts` | Boolean | Filtering for limited accounts |

**Response:** [NotificationPolicy entity](entities.md#notificationpolicy)

**Implementation Reference:** [app/controllers/api/v2/notifications/policies_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v2/notifications/policies_controller.rb)

---

## Search

### GET /api/v2/search

Search for accounts, statuses, or hashtags.

**Authentication:** Optional (required for some features)
**Scopes:** `read`, `read:search`

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `q` | String | REQUIRED. Search query |
| `type` | String | Limit to: `accounts`, `hashtags`, `statuses` |
| `resolve` | Boolean | Attempt WebFinger lookup (requires auth) |
| `following` | Boolean | Only accounts you follow |
| `account_id` | String | Search within this account's statuses |
| `exclude_unreviewed` | Boolean | Exclude unreviewed hashtags |
| `min_id` | String | Return results newer than this ID |
| `max_id` | String | Return results older than this ID |
| `limit` | Integer | Maximum results per type (default: 20) |
| `offset` | Integer | Skip first N results (requires auth) |

**Response Example:**

```json
{
  "accounts": [...],
  "statuses": [...],
  "hashtags": [...]
}
```

**Implementation Reference:** [app/controllers/api/v2/search_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v2/search_controller.rb)

---

## Media

### POST /api/v1/media

Upload media attachment (synchronous).

**Authentication:** Bearer token required
**Scopes:** `write`, `write:media`

**Request Parameters (multipart/form-data):**

| Parameter | Type | Description |
|-----------|------|-------------|
| `file` | File | REQUIRED. Media file |
| `thumbnail` | File | Custom thumbnail |
| `description` | String | Alt text (max 1500 chars) |
| `focus` | String | Focal point as "x,y" (-1.0 to 1.0) |

**Response:** [MediaAttachment entity](entities.md#mediaattachment)

**Implementation Reference:** [app/controllers/api/v1/media_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/media_controller.rb)

---

### POST /api/v2/media

Upload media attachment (asynchronous).

**Authentication:** Bearer token required
**Scopes:** `write`, `write:media`

Same parameters as v1, but returns immediately with 202 status while processing.

**Response Codes:**

| Code | Meaning |
|------|---------|
| 200 | Processing complete |
| 202 | Processing in background |

Poll `GET /api/v1/media/:id` until `url` is non-null.

**Implementation Reference:** [app/controllers/api/v2/media_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v2/media_controller.rb)

---

### GET /api/v1/media/:id

Get media attachment.

**Authentication:** Bearer token required
**Scopes:** `write`, `write:media`

**Response Codes:**

| Code | Meaning |
|------|---------|
| 200 | Ready |
| 206 | Still processing (`url` may be null) |
| 422 | Processing failed |

**Implementation Reference:** [app/controllers/api/v1/media_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/media_controller.rb)

---

## Markers

### GET /api/v1/markers

Retrieve timeline markers.

**Authentication:** Bearer token required
**Scopes:** `read`, `read:statuses`

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `timeline[]` | Array | Timelines to retrieve: `home`, `notifications` |

**Response Example:**

```json
{
  "home": {
    "last_read_id": "123456789",
    "version": 42,
    "updated_at": "2024-01-15T12:30:45.000Z"
  },
  "notifications": {
    "last_read_id": "987654321",
    "version": 10,
    "updated_at": "2024-01-15T12:30:45.000Z"
  }
}
```

**Implementation Reference:** [app/controllers/api/v1/markers_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/markers_controller.rb)

---

### POST /api/v1/markers

Save timeline markers.

**Authentication:** Bearer token required
**Scopes:** `write`, `write:statuses`

**Request Example:**

```json
{
  "home": {
    "last_read_id": "123456789"
  },
  "notifications": {
    "last_read_id": "987654321"
  }
}
```

**Response:** Updated markers object

**Error Responses:**

| Code | Condition |
|------|-----------|
| 409 | Conflict (concurrent update, retry) |

**Implementation Reference:** [app/controllers/api/v1/markers_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/markers_controller.rb)

---

## Default Limits

| Endpoint | Default | Maximum |
|----------|---------|---------|
| Statuses/Timelines | 20 | 40 |
| Accounts | 40 | 80 |
| Notifications | 40 | 80 |
| Search results | 20 | 40 |

**Base Controller Reference:** [`app/controllers/api/base_controller.rb`](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/base_controller.rb)

```ruby
DEFAULT_STATUSES_LIMIT = 20
DEFAULT_ACCOUNTS_LIMIT = 40
```
