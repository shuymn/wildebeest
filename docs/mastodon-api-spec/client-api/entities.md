# Entity Schemas

This document specifies the JSON response entity schemas returned by Mastodon API endpoints.

## Common Conventions

### ID Fields

All `id` fields are **opaque strings**. Clients MUST NOT:
- Parse IDs as integers
- Assume ordering based on ID values
- Rely on ID format or length

### Timestamps

All timestamps use ISO 8601 format in UTC:
```
2024-01-15T12:30:45.000Z
```

### Nullable Fields

Fields marked as nullable MAY be `null` in responses. Clients MUST handle null values appropriately.

---

## Account

Represents a user account.

**Serializer Reference:** [`app/serializers/rest/account_serializer.rb`](https://github.com/mastodon/mastodon/blob/v4.5.3/app/serializers/rest/account_serializer.rb)

### Attributes

| Field | Type | Nullable | Description |
|-------|------|----------|-------------|
| `id` | String | No | Account ID |
| `username` | String | No | Local username |
| `acct` | String | No | Webfinger address (`username` or `username@domain`) |
| `display_name` | String | No | Display name |
| `locked` | Boolean | No | Requires follow approval |
| `bot` | Boolean | No | Is an automated account |
| `discoverable` | Boolean | Yes | Opted into discovery features |
| `indexable` | Boolean | No | Opted into search indexing |
| `group` | Boolean | No | Is a group actor |
| `created_at` | String | No | Account creation date (midnight) |
| `note` | String | No | Bio (HTML) |
| `url` | String | No | Profile URL |
| `uri` | String | No | ActivityPub URI |
| `avatar` | String | No | Avatar image URL |
| `avatar_static` | String | No | Static avatar URL (for GIFs) |
| `header` | String | No | Header image URL |
| `header_static` | String | No | Static header URL |
| `followers_count` | Integer | No | Number of followers |
| `following_count` | Integer | No | Number following |
| `statuses_count` | Integer | No | Number of statuses |
| `last_status_at` | String | Yes | Date of last status (YYYY-MM-DD) |
| `hide_collections` | Boolean | No | Hide followers/following lists |
| `emojis` | Array | No | Custom emojis in bio |
| `fields` | Array | No | Profile metadata fields |
| `moved` | Account | Yes | Account migrated to (if moved) |
| `suspended` | Boolean | Conditional | True if suspended (only if suspended) |
| `limited` | Boolean | Conditional | True if silenced (only if silenced) |
| `noindex` | Boolean | Conditional | No indexing preference (local only) |
| `memorial` | Boolean | Conditional | Memorial account (only if true) |
| `roles` | Array | Conditional | Highlighted roles (local only) |

### Field Object

| Field | Type | Description |
|-------|------|-------------|
| `name` | String | Field label |
| `value` | String | Field value (HTML) |
| `verified_at` | String | Verification timestamp (nullable) |

### Role Object

| Field | Type | Description |
|-------|------|-------------|
| `id` | String | Role ID |
| `name` | String | Role name |
| `color` | String | Role color (hex) |

### Example

```json
{
  "id": "123456",
  "username": "user",
  "acct": "user",
  "display_name": "User Name",
  "locked": false,
  "bot": false,
  "discoverable": true,
  "indexable": true,
  "group": false,
  "created_at": "2023-01-15T00:00:00.000Z",
  "note": "<p>Hello, world!</p>",
  "url": "https://mastodon.social/@user",
  "uri": "https://mastodon.social/users/user",
  "avatar": "https://files.mastodon.social/accounts/avatars/000/123/456/original/avatar.png",
  "avatar_static": "https://files.mastodon.social/accounts/avatars/000/123/456/original/avatar.png",
  "header": "https://files.mastodon.social/accounts/headers/000/123/456/original/header.png",
  "header_static": "https://files.mastodon.social/accounts/headers/000/123/456/original/header.png",
  "followers_count": 1234,
  "following_count": 567,
  "statuses_count": 8901,
  "last_status_at": "2024-01-15",
  "hide_collections": false,
  "emojis": [],
  "fields": [
    {
      "name": "Website",
      "value": "<a href=\"https://example.com\" rel=\"nofollow noopener noreferrer\" target=\"_blank\">example.com</a>",
      "verified_at": "2024-01-01T00:00:00.000Z"
    }
  ]
}
```

---

## Status

Represents a post/status.

**Serializer Reference:** [`app/serializers/rest/status_serializer.rb`](https://github.com/mastodon/mastodon/blob/v4.5.3/app/serializers/rest/status_serializer.rb)

### Attributes

| Field | Type | Nullable | Description |
|-------|------|----------|-------------|
| `id` | String | No | Status ID |
| `created_at` | String | No | Creation timestamp |
| `in_reply_to_id` | String | Yes | Replied-to status ID |
| `in_reply_to_account_id` | String | Yes | Replied-to account ID |
| `sensitive` | Boolean | No | Media is sensitive |
| `spoiler_text` | String | No | Content warning |
| `visibility` | String | No | `public`, `unlisted`, `private`, `direct` |
| `language` | String | Yes | ISO 639 language code |
| `uri` | String | No | ActivityPub URI |
| `url` | String | Yes | Web URL |
| `replies_count` | Integer | No | Number of replies |
| `reblogs_count` | Integer | No | Number of boosts |
| `favourites_count` | Integer | No | Number of favourites |
| `quotes_count` | Integer | No | Number of quotes |
| `edited_at` | String | Yes | Last edit timestamp |
| `content` | String | No | HTML content |
| `reblog` | Status | Yes | Boosted status (if reblog) |
| `application` | Application | Yes | Posting application |
| `account` | Account | No | Author account |
| `media_attachments` | Array | No | Attached media |
| `mentions` | Array | No | Mentioned accounts |
| `tags` | Array | No | Hashtags |
| `emojis` | Array | No | Custom emojis |
| `card` | PreviewCard | Yes | Link preview |
| `poll` | Poll | Yes | Poll (if any) |
| `quote` | Quote | Yes | Quoted status |

### Authenticated-Only Fields

These fields are only present when authenticated:

| Field | Type | Description |
|-------|------|-------------|
| `favourited` | Boolean | User favourited this |
| `reblogged` | Boolean | User boosted this |
| `muted` | Boolean | User muted this conversation |
| `bookmarked` | Boolean | User bookmarked this |
| `pinned` | Boolean | Status is pinned (own statuses only) |
| `filtered` | Array | Filter results |

### Mention Object

| Field | Type | Description |
|-------|------|-------------|
| `id` | String | Account ID |
| `username` | String | Username |
| `url` | String | Profile URL |
| `acct` | String | Webfinger address |

### Tag Object

| Field | Type | Description |
|-------|------|-------------|
| `name` | String | Hashtag (without #) |
| `url` | String | Hashtag page URL |

### Application Object

| Field | Type | Description |
|-------|------|-------------|
| `name` | String | Application name |
| `website` | String | Application website (nullable) |

### Example

```json
{
  "id": "109876543210123456",
  "created_at": "2024-01-15T12:30:45.000Z",
  "in_reply_to_id": null,
  "in_reply_to_account_id": null,
  "sensitive": false,
  "spoiler_text": "",
  "visibility": "public",
  "language": "en",
  "uri": "https://mastodon.social/users/user/statuses/109876543210123456",
  "url": "https://mastodon.social/@user/109876543210123456",
  "replies_count": 5,
  "reblogs_count": 10,
  "favourites_count": 25,
  "quotes_count": 2,
  "edited_at": null,
  "content": "<p>Hello, world!</p>",
  "reblog": null,
  "application": {
    "name": "Web",
    "website": null
  },
  "account": { ... },
  "media_attachments": [],
  "mentions": [],
  "tags": [
    {
      "name": "mastodon",
      "url": "https://mastodon.social/tags/mastodon"
    }
  ],
  "emojis": [],
  "card": null,
  "poll": null,
  "favourited": true,
  "reblogged": false,
  "muted": false,
  "bookmarked": false
}
```

---

## MediaAttachment

Represents an uploaded media file.

**Serializer Reference:** [`app/serializers/rest/media_attachment_serializer.rb`](https://github.com/mastodon/mastodon/blob/v4.5.3/app/serializers/rest/media_attachment_serializer.rb)

### Attributes

| Field | Type | Nullable | Description |
|-------|------|----------|-------------|
| `id` | String | No | Attachment ID |
| `type` | String | No | `image`, `gifv`, `video`, `audio`, `unknown` |
| `url` | String | Yes | Full URL (null if processing) |
| `preview_url` | String | Yes | Preview/thumbnail URL |
| `remote_url` | String | Yes | Original remote URL |
| `preview_remote_url` | String | Yes | Remote thumbnail URL |
| `text_url` | String | Yes | Short URL (deprecated) |
| `meta` | Object | Yes | Media metadata |
| `description` | String | Yes | Alt text |
| `blurhash` | String | Yes | BlurHash placeholder |

### Meta Object

Contains dimension and duration information:

```json
{
  "original": {
    "width": 1920,
    "height": 1080,
    "size": "1920x1080",
    "aspect": 1.7777777777777777
  },
  "small": {
    "width": 400,
    "height": 225,
    "size": "400x225",
    "aspect": 1.7777777777777777
  },
  "focus": {
    "x": 0.0,
    "y": 0.0
  }
}
```

For video/audio:
```json
{
  "length": "0:30:00.50",
  "duration": 1800.5,
  "fps": 30,
  "audio_encode": "aac",
  "audio_bitrate": "128 Kb/s",
  "audio_channels": "stereo"
}
```

### Example

```json
{
  "id": "123456789",
  "type": "image",
  "url": "https://files.mastodon.social/media_attachments/files/123/456/789/original/image.png",
  "preview_url": "https://files.mastodon.social/media_attachments/files/123/456/789/small/image.png",
  "remote_url": null,
  "preview_remote_url": null,
  "text_url": null,
  "meta": {
    "original": {
      "width": 1920,
      "height": 1080,
      "size": "1920x1080",
      "aspect": 1.7777777777777777
    },
    "small": {
      "width": 400,
      "height": 225,
      "size": "400x225",
      "aspect": 1.7777777777777777
    }
  },
  "description": "A beautiful sunset",
  "blurhash": "UBL_:rOpGG-oBUNG,qRj2so}xWR-P*WBR-Rj"
}
```

---

## Notification

Represents a notification of an event.

**Serializer Reference:** [`app/serializers/rest/notification_serializer.rb`](https://github.com/mastodon/mastodon/blob/v4.5.3/app/serializers/rest/notification_serializer.rb)

### Attributes

| Field | Type | Nullable | Description |
|-------|------|----------|-------------|
| `id` | String | No | Notification ID |
| `type` | String | No | Notification type |
| `created_at` | String | No | Notification timestamp |
| `group_key` | String | No | Grouping key |
| `filtered` | Boolean | Conditional | If notification was filtered |
| `account` | Account | No | Source account |
| `status` | Status | Conditional | Related status |
| `report` | Report | Conditional | Related report (admin) |
| `event` | Event | Conditional | Relationship severance event |
| `moderation_warning` | Warning | Conditional | Moderation warning |

### Notification Types

| Type | `account` | `status` | Description |
|------|-----------|----------|-------------|
| `mention` | Mentioner | The mention | Someone mentioned you |
| `status` | Poster | The status | Someone you follow posted |
| `reblog` | Booster | Your status | Someone boosted your status |
| `follow` | Follower | - | Someone followed you |
| `follow_request` | Requester | - | Someone requested to follow |
| `favourite` | Favouriter | Your status | Someone favourited your status |
| `poll` | Poll owner | Poll status | A poll has ended |
| `update` | Editor | Updated status | A status was edited |
| `quote` | Quoter | The quote | Someone quoted your status |
| `quoted_update` | Editor | Updated quote | A quote post was edited |
| `admin.sign_up` | New user | - | Someone signed up |
| `admin.report` | Reporter | - | New report filed |
| `severed_relationships` | - | - | Relationships severed |
| `moderation_warning` | - | - | You received a warning |

### Example

```json
{
  "id": "123456789",
  "type": "favourite",
  "created_at": "2024-01-15T12:30:45.000Z",
  "group_key": "favourite-123456789",
  "account": {
    "id": "987654321",
    "username": "other_user",
    "acct": "other_user@example.com",
    ...
  },
  "status": {
    "id": "109876543210123456",
    "content": "<p>My status</p>",
    ...
  }
}
```

---

## Relationship

Represents the relationship between accounts.

**Serializer Reference:** [`app/serializers/rest/relationship_serializer.rb`](https://github.com/mastodon/mastodon/blob/v4.5.3/app/serializers/rest/relationship_serializer.rb)

### Attributes

| Field | Type | Description |
|-------|------|-------------|
| `id` | String | Target account ID |
| `following` | Boolean | You follow them |
| `showing_reblogs` | Boolean | Showing their boosts |
| `notifying` | Boolean | Notified of their posts |
| `languages` | Array | Followed languages (nullable) |
| `followed_by` | Boolean | They follow you |
| `blocking` | Boolean | You block them |
| `blocked_by` | Boolean | They block you |
| `muting` | Boolean | You mute them |
| `muting_notifications` | Boolean | Muting their notifications |
| `requested` | Boolean | You requested to follow |
| `requested_by` | Boolean | They requested to follow |
| `domain_blocking` | Boolean | You block their domain |
| `endorsed` | Boolean | You endorsed them |
| `note` | String | Private note about them |

### Example

```json
{
  "id": "123456",
  "following": true,
  "showing_reblogs": true,
  "notifying": false,
  "languages": null,
  "followed_by": true,
  "blocking": false,
  "blocked_by": false,
  "muting": false,
  "muting_notifications": false,
  "requested": false,
  "requested_by": false,
  "domain_blocking": false,
  "endorsed": false,
  "note": "Met at conference"
}
```

---

## Instance (v2)

Represents instance information.

**Serializer Reference:** [`app/serializers/rest/instance_serializer.rb`](https://github.com/mastodon/mastodon/blob/v4.5.3/app/serializers/rest/instance_serializer.rb)

### Attributes

| Field | Type | Description |
|-------|------|-------------|
| `domain` | String | Instance domain |
| `title` | String | Instance title |
| `version` | String | Mastodon version |
| `source_url` | String | Source code URL |
| `description` | String | Instance description |
| `usage` | Object | Usage statistics |
| `thumbnail` | Object | Instance thumbnail |
| `icon` | Array | Instance icons |
| `languages` | Array | Primary languages |
| `configuration` | Object | Server configuration |
| `registrations` | Object | Registration settings |
| `contact` | Object | Contact information |
| `rules` | Array | Instance rules |
| `api_versions` | Object | Supported API versions |

### Configuration Object

```json
{
  "urls": {
    "streaming": "wss://streaming.example.com",
    "status": "https://status.example.com"
  },
  "vapid": {
    "public_key": "..."
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
    "supported_mime_types": [...],
    "image_size_limit": 16777216,
    "video_size_limit": 103809024,
    ...
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
}
```

---

## Instance (v1)

Deprecated instance representation.

**Serializer Reference:** [`app/serializers/rest/v1/instance_serializer.rb`](https://github.com/mastodon/mastodon/blob/v4.5.3/app/serializers/rest/v1/instance_serializer.rb)

### Attributes

| Field | Type | Description |
|-------|------|-------------|
| `uri` | String | Instance domain |
| `title` | String | Instance title |
| `short_description` | String | Short description |
| `description` | String | Full description |
| `email` | String | Admin contact email |
| `version` | String | Mastodon version |
| `urls` | Object | `{ streaming_api: "..." }` |
| `stats` | Object | `{ user_count, status_count, domain_count }` |
| `thumbnail` | String | Thumbnail URL |
| `languages` | Array | Primary languages |
| `registrations` | Boolean | Registrations enabled |
| `approval_required` | Boolean | Approval required |
| `invites_enabled` | Boolean | User invites enabled |
| `configuration` | Object | Server limits |
| `contact_account` | Account | Admin account |
| `rules` | Array | Instance rules |

---

## Marker

Represents a read position marker.

**Serializer Reference:** [`app/serializers/rest/marker_serializer.rb`](https://github.com/mastodon/mastodon/blob/v4.5.3/app/serializers/rest/marker_serializer.rb)

### Attributes

| Field | Type | Description |
|-------|------|-------------|
| `last_read_id` | String | Last read item ID |
| `version` | Integer | Marker version (optimistic locking) |
| `updated_at` | String | Last update timestamp |

### Example

```json
{
  "home": {
    "last_read_id": "109876543210123456",
    "version": 42,
    "updated_at": "2024-01-15T12:30:45.000Z"
  },
  "notifications": {
    "last_read_id": "987654321012345678",
    "version": 10,
    "updated_at": "2024-01-15T12:30:45.000Z"
  }
}
```

---

## CustomEmoji

Represents a custom emoji.

### Attributes

| Field | Type | Description |
|-------|------|-------------|
| `shortcode` | String | Emoji shortcode |
| `url` | String | Full image URL |
| `static_url` | String | Static image URL |
| `visible_in_picker` | Boolean | Shown in picker |
| `category` | String | Emoji category (nullable) |

---

## Poll

Represents a poll attached to a status.

### Attributes

| Field | Type | Description |
|-------|------|-------------|
| `id` | String | Poll ID |
| `expires_at` | String | Expiration timestamp (nullable) |
| `expired` | Boolean | Poll has ended |
| `multiple` | Boolean | Multiple choice allowed |
| `votes_count` | Integer | Total votes |
| `voters_count` | Integer | Total voters (nullable) |
| `options` | Array | Poll options |
| `emojis` | Array | Custom emojis |
| `voted` | Boolean | User has voted (auth only) |
| `own_votes` | Array | User's votes (auth only) |

### Poll Option

| Field | Type | Description |
|-------|------|-------------|
| `title` | String | Option text |
| `votes_count` | Integer | Votes (null if hide_totals) |

---

## PreviewCard

Represents a link preview.

### Attributes

| Field | Type | Description |
|-------|------|-------------|
| `url` | String | Link URL |
| `title` | String | Page title |
| `description` | String | Page description |
| `type` | String | `link`, `photo`, `video`, `rich` |
| `author_name` | String | Author name |
| `author_url` | String | Author URL |
| `provider_name` | String | Provider name |
| `provider_url` | String | Provider URL |
| `html` | String | oEmbed HTML |
| `width` | Integer | Width |
| `height` | Integer | Height |
| `image` | String | Preview image URL (nullable) |
| `embed_url` | String | Embed URL |
| `blurhash` | String | BlurHash (nullable) |

---

## Search

Represents search results.

### Attributes

| Field | Type | Description |
|-------|------|-------------|
| `accounts` | Array | Matching accounts |
| `statuses` | Array | Matching statuses |
| `hashtags` | Array | Matching hashtags |

---

## File References

- Account: [`app/serializers/rest/account_serializer.rb`](https://github.com/mastodon/mastodon/blob/v4.5.3/app/serializers/rest/account_serializer.rb)
- Status: [`app/serializers/rest/status_serializer.rb`](https://github.com/mastodon/mastodon/blob/v4.5.3/app/serializers/rest/status_serializer.rb)
- MediaAttachment: [`app/serializers/rest/media_attachment_serializer.rb`](https://github.com/mastodon/mastodon/blob/v4.5.3/app/serializers/rest/media_attachment_serializer.rb)
- Notification: [`app/serializers/rest/notification_serializer.rb`](https://github.com/mastodon/mastodon/blob/v4.5.3/app/serializers/rest/notification_serializer.rb)
- Relationship: [`app/serializers/rest/relationship_serializer.rb`](https://github.com/mastodon/mastodon/blob/v4.5.3/app/serializers/rest/relationship_serializer.rb)
- Instance v2: [`app/serializers/rest/instance_serializer.rb`](https://github.com/mastodon/mastodon/blob/v4.5.3/app/serializers/rest/instance_serializer.rb)
- Instance v1: [`app/serializers/rest/v1/instance_serializer.rb`](https://github.com/mastodon/mastodon/blob/v4.5.3/app/serializers/rest/v1/instance_serializer.rb)
- Marker: [`app/serializers/rest/marker_serializer.rb`](https://github.com/mastodon/mastodon/blob/v4.5.3/app/serializers/rest/marker_serializer.rb)

TypeScript type definitions are maintained in:
- [`app/javascript/mastodon/api_types/accounts.ts`](https://github.com/mastodon/mastodon/blob/v4.5.3/app/javascript/mastodon/api_types/accounts.ts)
- [`app/javascript/mastodon/api_types/statuses.ts`](https://github.com/mastodon/mastodon/blob/v4.5.3/app/javascript/mastodon/api_types/statuses.ts)
- [`app/javascript/mastodon/api_types/media_attachments.ts`](https://github.com/mastodon/mastodon/blob/v4.5.3/app/javascript/mastodon/api_types/media_attachments.ts)
- [`app/javascript/mastodon/api_types/relationships.ts`](https://github.com/mastodon/mastodon/blob/v4.5.3/app/javascript/mastodon/api_types/relationships.ts)
- [`app/javascript/mastodon/api_types/markers.ts`](https://github.com/mastodon/mastodon/blob/v4.5.3/app/javascript/mastodon/api_types/markers.ts)
