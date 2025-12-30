# ActivityPub Endpoints

This document specifies the ActivityPub endpoints for Mastodon-compatible servers.

## Inbox

Receives activities from remote servers.

### Endpoint

```
POST /users/{username}/inbox    # User inbox
POST /actor/inbox               # Instance actor inbox
POST /inbox                     # Shared inbox
```

### Request

| Header | Required | Description |
|--------|----------|-------------|
| `Signature` or `Signature-Input` | MUST | HTTP signature |
| `Digest` or `Content-Digest` | MUST | Body hash |
| `Content-Type` | MUST | `application/activity+json` |

### Response

| Status | Description |
|--------|-------------|
| 202 Accepted | Activity queued for processing |
| 400 Bad Request | Malformed signature header |
| 401 Unauthorized | Signature verification failed |
| 403 Forbidden | Domain blocked |

### Behavior

1. Server MUST verify HTTP signature (see [Security & Signatures](security-signatures.md))
2. Server MUST verify body digest matches
3. Server MUST respond `202 Accepted` after queuing (not after processing)
4. Server SHOULD process activities asynchronously

### Unknown Actor Self-Destruct

When receiving `Delete` or `Update` activities where:
- `actor` equals `object` (self-referential)
- Actor does not exist in local database

Server MUST respond `202 Accepted` without processing. This prevents unnecessary retries for cleanup activities from unknown actors.

### Collection Synchronization Header

Non-standard extension for follower list synchronization:

```
Collection-Synchronization: collectionId="...",digest="...",url="..."
```

Servers MAY process this header to synchronize follower collections. The header mechanism can be disabled with `DISABLE_FOLLOWERS_SYNCHRONIZATION=true` (disables both sending and processing of this header).

### Account Upgrade

When receiving a signed activity from an OStatus (legacy) account, servers SHOULD upgrade the account to ActivityPub by re-resolving via WebFinger.

## Outbox

Serves the actor's published activities.

### Endpoint

```
GET /users/{username}/outbox
GET /actor/outbox
```

### Request

| Header | Required | Description |
|--------|----------|-------------|
| `Signature` | Conditional | Required in Authorized Fetch mode |
| `Accept` | SHOULD | `application/activity+json` |

### Query Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `page` | boolean | Request paginated results |
| `max_id` | string | Return results older than ID |
| `min_id` | string | Return results newer than ID |
| `since_id` | string | Return results after ID |

### Response

Content-Type: `application/activity+json`

#### Collection (without `page`)

```json
{
  "@context": "https://www.w3.org/ns/activitystreams",
  "id": "https://example.com/users/alice/outbox",
  "type": "OrderedCollection",
  "totalItems": 42,
  "first": "https://example.com/users/alice/outbox?page=true",
  "last": "https://example.com/users/alice/outbox?page=true&min_id=0"
}
```

#### Collection Page (with `page=true`)

```json
{
  "@context": "https://www.w3.org/ns/activitystreams",
  "id": "https://example.com/users/alice/outbox?page=true",
  "type": "OrderedCollectionPage",
  "partOf": "https://example.com/users/alice/outbox",
  "prev": "https://example.com/users/alice/outbox?page=true&min_id=123",
  "next": "https://example.com/users/alice/outbox?page=true&max_id=100",
  "orderedItems": [
    { "type": "Create", "object": { ... } },
    { "type": "Announce", "object": "..." }
  ]
}
```

### Pagination

- Page size: 20 items
- Items ordered by ID descending (newest first)
- `prev` links to newer items
- `next` links to older items

### Cache Control

| Mode | Page | Cache-Control |
|------|------|---------------|
| Public fetch | No | `public, max-age=180` (3 min) |
| Public fetch | Yes | `public, max-age=60` (1 min) |
| Authorized fetch | No | `private, max-age=180` |
| Authorized fetch | Yes | `private, max-age=60` |

Servers MUST include `Vary: Signature` header in authorized fetch mode.

### Status Codes

| Status | Description |
|--------|-------------|
| 200 OK | Success |
| 401 Unauthorized | Signature required (authorized fetch mode) |
| 404 Not Found | Account not found |
| 410 Gone | Account deleted |

## Actor Profile

Returns the ActivityPub actor document.

### Endpoint

```
GET /users/{username}
```

### Alternative Actor URL (by ID)

Mastodon also serves the same actor resources under an alternative path using the internal numeric ID.

```
GET /ap/users/{id}
POST /ap/users/{id}/inbox
GET /ap/users/{id}/outbox
GET /ap/users/{id}/followers
GET /ap/users/{id}/following
GET /ap/users/{id}/collections/{id}
GET /ap/users/{id}/followers_synchronization
GET /ap/users/{id}/quote_authorizations/{id}
GET /ap/users/{id}/statuses/{id}
GET /ap/users/{id}/statuses/{id}/activity
GET /ap/users/{id}/statuses/{id}/replies
GET /ap/users/{id}/statuses/{id}/likes
GET /ap/users/{id}/statuses/{id}/shares
```

### Response

```json
{
  "@context": [
    "https://www.w3.org/ns/activitystreams",
    "https://w3id.org/security/v1",
    {
      "toot": "http://joinmastodon.org/ns#",
      "discoverable": "toot:discoverable",
      "indexable": "toot:indexable",
      "featured": { "@id": "toot:featured", "@type": "@id" }
    }
  ],
  "id": "https://example.com/users/alice",
  "type": "Person",
  "preferredUsername": "alice",
  "name": "Alice",
  "summary": "<p>Bio here</p>",
  "inbox": "https://example.com/users/alice/inbox",
  "outbox": "https://example.com/users/alice/outbox",
  "followers": "https://example.com/users/alice/followers",
  "following": "https://example.com/users/alice/following",
  "featured": "https://example.com/users/alice/collections/featured",
  "discoverable": true,
  "indexable": true,
  "publicKey": {
    "id": "https://example.com/users/alice#main-key",
    "owner": "https://example.com/users/alice",
    "publicKeyPem": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"
  },
  "endpoints": {
    "sharedInbox": "https://example.com/inbox"
  }
}
```

> **Note**: Mastodon uses `http://joinmastodon.org/ns#` (prefixed as `toot:`) for Mastodon-specific extensions like `discoverable`, `indexable`, `featured`, `blurhash`, and `focalPoint`.

### Actor Types

| Type | Description |
|------|-------------|
| `Person` | Regular user account |
| `Service` | Bot or automated account |
| `Application` | Instance actor |
| `Group` | Group account |

### Required Properties

| Property | Description |
|----------|-------------|
| `id` | Canonical actor URL |
| `type` | Actor type |
| `preferredUsername` | Username (local part) |
| `inbox` | Inbox URL |
| `outbox` | Outbox URL |
| `publicKey` | Signing key for verification |

## Collections

### Followers

```
GET /users/{username}/followers
```

Returns an `OrderedCollection` of follower actor IDs.

### Following

```
GET /users/{username}/following
```

Returns an `OrderedCollection` of followed actor IDs.

### Featured (Pinned Posts)

```
GET /users/{username}/collections/featured
```

Returns an `OrderedCollection` of pinned statuses.

### Featured Tags

```
GET /users/{username}/collections/tags
```

Returns a collection of featured hashtags.

### Collection Response Format

```json
{
  "@context": "https://www.w3.org/ns/activitystreams",
  "id": "https://example.com/users/alice/followers",
  "type": "OrderedCollection",
  "totalItems": 123,
  "first": "https://example.com/users/alice/followers?page=1"
}
```

### Collection Cache Control

Collection caching varies by type:

**Outbox:**
- Root: 3-minute cache
- Pages: 1-minute cache

**Followers/Following:**
- Root: 3-minute cache
- Pages: No caching (`expires_in 0`)
- Hidden if account has `hide_collections` enabled

**Common behavior:**
- `Vary: Accept, Accept-Language, Cookie` (plus `Signature` in authorized fetch mode)
- Private cache in authorized fetch mode
- Cache enforcement via `CacheConcern` may force `private, no-store` based on request headers

### Followers Synchronization

```
GET /users/{username}/followers_synchronization
```

Returns a subset of followers filtered by the requesting server's domain prefix. Used by remote servers to verify their local follower list matches the origin server.

**Authentication:** Signature REQUIRED (always, regardless of authorized fetch mode)

**Request Headers:**

| Header | Required | Description |
|--------|----------|-------------|
| `Signature` | MUST | HTTP signature from requesting server |

**Behavior:**

1. Server extracts the URI prefix from the signed request account
2. Returns only followers whose actor URIs match the requesting domain
3. Enables efficient follower list reconciliation without transferring full lists

**Response:**

```json
{
  "@context": "https://www.w3.org/ns/activitystreams",
  "id": "https://example.com/users/alice/followers_synchronization",
  "type": "OrderedCollection",
  "orderedItems": [
    "https://remote.example/users/bob",
    "https://remote.example/users/carol"
  ]
}
```

**Cache Control:** No caching (`expires_in 0`, `public: false`)

**Related Configuration:**

The `DISABLE_FOLLOWERS_SYNCHRONIZATION=true` environment variable disables the **synchronization mechanism** (sending/processing the `Collection-Synchronization` header on inbox deliveries), but does not disable this GET endpoint itself. The endpoint will still respond to properly signed requests regardless of this setting.

### Quote Authorizations

```
GET /users/{username}/quote_authorizations/{id}
```

Returns authorization for a quote post. When a status quotes another status, the quoted account's server can verify the quote is authorized by fetching this endpoint.

**Authentication:** Signature required in Authorized Fetch mode

**Response:**

```json
{
  "@context": "https://www.w3.org/ns/activitystreams",
  "id": "https://example.com/users/alice/quote_authorizations/123",
  "type": "QuoteAuthorization",
  "interactionTarget": "https://example.com/users/alice/statuses/456",
  "object": "https://remote.example/users/bob/statuses/789"
}
```

**Status Codes:**

| Status | Description |
|--------|-------------|
| 200 OK | Quote authorization found and accessible |
| 404 Not Found | Authorization not found, not accepted, or status not visible |

**Cache Control:**

| Condition | Cache-Control |
|-----------|---------------|
| Quoted status is public & public fetch mode | `public, max-age=30` |
| Otherwise | No caching |

**Behavior:**

- Only returns `accepted` quote authorizations
- Verifies both the quoting status and quoted status exist
- Authorization check via Pundit policy on quoted status visibility

## Status Endpoints

### Single Status

```
GET /users/{username}/statuses/{id}
```

Returns the status as an ActivityPub `Note` object.

### Status Context

```
GET /users/{username}/statuses/{id}/activity
```

Returns the `Create` activity that created the status.

### Replies Collection

```
GET /users/{username}/statuses/{id}/replies
```

Returns an ActivityPub collection of replies.

### Likes Collection

```
GET /users/{username}/statuses/{id}/likes
```

Returns an ActivityPub collection of likes.

### Shares Collection

```
GET /users/{username}/statuses/{id}/shares
```

Returns an ActivityPub collection of shares.

### Embedded Status HTML

```
GET /users/{username}/statuses/{id}/embed
```

Returns an embeddable HTML representation of the status.

## Context Endpoints

Conversation context endpoints expose a collection of related statuses.

```
GET /contexts/{id}
GET /contexts/{id}/items
```

The `id` parameter is formatted as `{account_id}-{status_id}`.

## Common Headers

### Request Headers

| Header | Description |
|--------|-------------|
| `Accept` | SHOULD include `application/activity+json` |
| `Signature` | HTTP signature (when required) |

### Response Headers

| Header | Description |
|--------|-------------|
| `Content-Type` | `application/activity+json` |
| `Cache-Control` | Caching directives |
| `Vary` | `Signature` (in authorized fetch mode) |
