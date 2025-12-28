# Core Endpoints

This document specifies the essential REST endpoints for Mastodon client applications.

## Instance Information

### GET /api/v1/instance

Retrieve instance information (deprecated, use v2).

**Authentication:** None required

**Deprecation Notice:** Deprecated since 2022-11-14. Clients SHOULD use `/api/v2/instance` instead.

**Response:** See [Instance entity (v1)](entities.md#instance-v1).

**Implementation Reference:** [`app/controllers/api/v1/instances_controller.rb`](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/instances_controller.rb)

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

**Implementation Reference:** [`app/controllers/api/v2/instances_controller.rb`](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v2/instances_controller.rb)

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

**Implementation Reference:** [`app/controllers/api/v1/accounts/credentials_controller.rb`](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/accounts/credentials_controller.rb)

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

**Implementation Reference:** [`app/controllers/api/v1/accounts_controller.rb`](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/accounts_controller.rb)

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

**Implementation Reference:** [`app/controllers/api/v1/accounts/lookup_controller.rb`](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/accounts/lookup_controller.rb)

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

**Implementation Reference:** [`app/controllers/api/v1/accounts/relationships_controller.rb`](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/accounts/relationships_controller.rb)

---

## Statuses

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

**Implementation Reference:** [`app/controllers/api/v1/statuses_controller.rb`](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/statuses_controller.rb)

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

**Implementation Reference:** [`app/controllers/api/v1/statuses_controller.rb`](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/statuses_controller.rb)

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

**Implementation Reference:** [`app/controllers/api/v1/statuses_controller.rb`](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/statuses_controller.rb)

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

**Implementation Reference:** [`app/controllers/api/v1/statuses_controller.rb`](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/statuses_controller.rb)

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

**Implementation Reference:** [`app/controllers/api/v1/statuses_controller.rb`](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/statuses_controller.rb)

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

**Implementation Reference:** [`app/controllers/api/v1/timelines/home_controller.rb`](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/timelines/home_controller.rb)

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

**Implementation Reference:** [`app/controllers/api/v1/timelines/public_controller.rb`](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/timelines/public_controller.rb)

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

**Implementation Reference:** [`app/controllers/api/v1/timelines/tag_controller.rb`](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/timelines/tag_controller.rb)

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

**Implementation Reference:** [`app/controllers/api/v1/notifications_controller.rb`](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/notifications_controller.rb)

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

**Implementation Reference:** [`app/controllers/api/v1/notifications_controller.rb`](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/notifications_controller.rb)

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

**Implementation Reference:** [`app/controllers/api/v2/search_controller.rb`](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v2/search_controller.rb)

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

**Implementation Reference:** [`app/controllers/api/v1/media_controller.rb`](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/media_controller.rb)

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

**Implementation Reference:** [`app/controllers/api/v2/media_controller.rb`](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v2/media_controller.rb)

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

**Implementation Reference:** [`app/controllers/api/v1/media_controller.rb`](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/media_controller.rb)

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

**Implementation Reference:** [`app/controllers/api/v1/markers_controller.rb`](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/markers_controller.rb)

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

**Implementation Reference:** [`app/controllers/api/v1/markers_controller.rb`](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/markers_controller.rb)

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
