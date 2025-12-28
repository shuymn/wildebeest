# Pagination Patterns

This document specifies the pagination patterns used by the Mastodon API.

## Overview

Mastodon uses **ID-based cursor pagination**, not offset-based pagination. This approach:

- Provides stable pagination even when new items are added
- Performs efficiently regardless of page depth
- Prevents duplicate or missing items during pagination

## Link Header

Paginated responses include a `Link` header with navigation URLs.

### Format

```http
Link: <https://mastodon.social/api/v1/timelines/home?max_id=123456>; rel="next", <https://mastodon.social/api/v1/timelines/home?min_id=789012>; rel="prev"
```

### Relationships

| Relationship | Direction | Description |
|--------------|-----------|-------------|
| `next` | Older | URL to fetch older results |
| `prev` | Newer | URL to fetch newer results |

### Parsing

Clients MUST parse the Link header according to RFC 8288. Example parsing:

```javascript
function parseLinkHeader(header) {
  if (!header) return {};

  const links = {};
  const parts = header.split(',');

  for (const part of parts) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match) {
      links[match[2]] = match[1];
    }
  }

  return links;
}
```

**Implementation Reference:** [`app/controllers/concerns/api/pagination.rb`](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/concerns/api/pagination.rb)

## Query Parameters

### Pagination Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `max_id` | String | Return results older than (but not including) this ID |
| `since_id` | String | Return results newer than (but not including) this ID |
| `min_id` | String | Return results immediately newer than this ID |
| `limit` | Integer | Maximum number of results to return |

### Parameter Semantics

#### max_id

Returns items with IDs **less than** (older than) the specified ID.

```
Timeline: [100, 99, 98, 97, 96, 95, 94, 93, 92, 91]
Request:  ?max_id=97
Response: [96, 95, 94, 93, 92, 91, ...]
```

Use `max_id` from the `Link: rel="next"` header to load older content.

#### since_id

Returns items with IDs **greater than** (newer than) the specified ID, up to `limit`.

```
Timeline: [100, 99, 98, 97, 96, 95, 94, 93, 92, 91]
Request:  ?since_id=93&limit=5
Response: [100, 99, 98, 97, 96]  (newest 5 after ID 93)
```

Use `since_id` to check for new content since a known position.

#### min_id

Returns items with IDs **greater than** (newer than) the specified ID, starting from the oldest matching item.

```
Timeline: [100, 99, 98, 97, 96, 95, 94, 93, 92, 91]
Request:  ?min_id=93&limit=5
Response: [98, 97, 96, 95, 94]  (5 items immediately after ID 93)
```

Use `min_id` from the `Link: rel="prev"` header to load newer content while maintaining position.

#### Difference: since_id vs min_id

| Parameter | Returns | Order | Use Case |
|-----------|---------|-------|----------|
| `since_id` | Newest items first | Descending | Check for updates |
| `min_id` | Items after cursor | Ascending | Page forward |

### limit

Controls the maximum number of results returned.

- Default values vary by endpoint (typically 20 or 40)
- Maximum values are typically 2x the default
- Values exceeding the maximum are capped

```
Request:  ?limit=50
Applied:  limit=40  (if max is 40)
```

**Default Limits Reference:** [`app/controllers/api/base_controller.rb`](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/base_controller.rb)

```ruby
DEFAULT_STATUSES_LIMIT = 20
DEFAULT_ACCOUNTS_LIMIT = 40
```

## Endpoint-Specific Limits

| Endpoint | Default | Maximum |
|----------|---------|---------|
| Timelines | 20 | 40 |
| Notifications | 40 | 80 |
| Accounts lists | 40 | 80 |
| Search results | 20 | 40 |
| Conversations | 20 | 40 |
| Favourites | 20 | 40 |
| Bookmarks | 20 | 40 |

## Pagination Flow

### Initial Load

```http
GET /api/v1/timelines/home
```

Response headers:
```http
Link: <https://example.com/api/v1/timelines/home?max_id=100>; rel="next",
      <https://example.com/api/v1/timelines/home?min_id=120>; rel="prev"
```

### Load Older (Scroll Down)

Extract and follow the `rel="next"` link:

```http
GET /api/v1/timelines/home?max_id=100
```

### Load Newer (Pull to Refresh)

Extract and follow the `rel="prev"` link:

```http
GET /api/v1/timelines/home?min_id=120
```

### Gap Filling

When a gap exists between cached content and new content:

1. Note the newest cached ID (e.g., `80`)
2. Fetch with `min_id=80`
3. Merge results with existing cache
4. Repeat if Link header indicates more results

## Special Cases

### Empty Results

When no results match the criteria:

- Response body: `[]`
- No Link header (or empty)

Clients SHOULD stop pagination when receiving an empty response.

### Partial Results

Some endpoints may return fewer results than `limit`:

- The returned set may be smaller if items were filtered
- This does NOT necessarily indicate end of data
- Continue pagination if Link header is present

### Search Pagination

The `/api/v2/search` endpoint uses a different pagination model:

| Parameter | Type | Description |
|-----------|------|-------------|
| `offset` | Integer | Skip first N results |
| `limit` | Integer | Maximum results per type |

**Note:** Offset pagination requires authentication.

### Notification Pagination

Notifications support additional filtering that interacts with pagination:

```http
GET /api/v1/notifications?types[]=mention&types[]=favourite&max_id=123
```

The pagination IDs refer to notification IDs, not status IDs.

## Implementation Guidelines

### Client Best Practices

1. **Always use Link headers** when available instead of constructing URLs manually
2. **Cache pagination state** to resume loading after app restart
3. **Handle rate limiting** with exponential backoff
4. **Deduplicate results** when merging paginated data
5. **Store IDs as strings** not integers

### ID Handling

```javascript
// CORRECT
const maxId = response.data[response.data.length - 1].id; // String

// INCORRECT - Do not parse as number
const maxId = parseInt(response.data[response.data.length - 1].id);
```

### Efficient Polling

For checking new content, use `since_id` with the newest known ID:

```javascript
async function checkForUpdates(newestKnownId) {
  const response = await fetch(
    `/api/v1/timelines/home?since_id=${newestKnownId}&limit=1`
  );
  const newItems = await response.json();
  return newItems.length > 0;
}
```

### Gap Detection

Detect gaps when the oldest fetched item is not adjacent to cached content:

```javascript
function hasGap(fetchedItems, cachedNewestId) {
  if (fetchedItems.length === 0) return false;

  const oldestFetched = fetchedItems[fetchedItems.length - 1];
  // If there's a significant ID gap, we may have missed items
  // Note: This is heuristic; proper gap detection should use timestamps
  return BigInt(oldestFetched.id) > BigInt(cachedNewestId) + 1n;
}
```

## Error Handling

### Invalid Pagination Parameters

| Error | Status | Description |
|-------|--------|-------------|
| Negative limit/offset | 400 | Pagination values must be positive |
| Non-existent ID | 200 | Returns empty array (not 404) |

### Example Error Response

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json

{
  "error": "Pagination values for `offset` and `limit` must be positive"
}
```

**Validation Reference:** [`app/controllers/concerns/api/pagination.rb`](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/concerns/api/pagination.rb)

```ruby
def require_valid_pagination_options!
  render json: { error: 'Pagination values for `offset` and `limit` must be positive' },
         status: 400 if pagination_options_invalid?
end
```

## File References

- Base pagination: [`app/controllers/concerns/api/pagination.rb`](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/concerns/api/pagination.rb)
- Timeline pagination: [`app/controllers/api/v1/timelines/base_controller.rb`](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/timelines/base_controller.rb)
- Notification pagination: [`app/controllers/api/v1/notifications_controller.rb`](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/notifications_controller.rb)
- Search pagination: [`app/controllers/api/v2/search_controller.rb`](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v2/search_controller.rb)

## Examples

### Timeline Pagination

```http
# Initial request
GET /api/v1/timelines/home HTTP/1.1
Authorization: Bearer token

# Response
HTTP/1.1 200 OK
Link: <https://mastodon.social/api/v1/timelines/home?max_id=109876543210123456>; rel="next",
      <https://mastodon.social/api/v1/timelines/home?min_id=109876543210123500>; rel="prev"

[
  {"id": "109876543210123500", ...},
  {"id": "109876543210123490", ...},
  ...
  {"id": "109876543210123456", ...}
]

# Load older
GET /api/v1/timelines/home?max_id=109876543210123456 HTTP/1.1
Authorization: Bearer token

# Load newer
GET /api/v1/timelines/home?min_id=109876543210123500 HTTP/1.1
Authorization: Bearer token
```

### Account List Pagination

```http
# Get followers
GET /api/v1/accounts/123456/followers HTTP/1.1
Authorization: Bearer token

# Response
HTTP/1.1 200 OK
Link: <https://mastodon.social/api/v1/accounts/123456/followers?max_id=987654>; rel="next"

[
  {"id": "999999", ...},
  {"id": "999998", ...},
  ...
  {"id": "987654", ...}
]
```

### Notification Filtering with Pagination

```http
# Get only mentions, paginated
GET /api/v1/notifications?types[]=mention&limit=20 HTTP/1.1
Authorization: Bearer token

# Load more mentions
GET /api/v1/notifications?types[]=mention&max_id=555555&limit=20 HTTP/1.1
Authorization: Bearer token
```
