# Mastodon Client API Overview

This document provides an overview of the Mastodon Client REST API, designed for client applications such as official Mastodon apps, Ivory, Elk, and other third-party clients.

## Status

This specification is normative for Mastodon server implementations and informative for client developers seeking compatibility.

## Base URL Structure

All API endpoints are served under the `/api/` namespace with versioned paths:

- **v1 API**: `/api/v1/` - Primary stable API surface
- **v2 API**: `/api/v2/` - Newer endpoints with improved semantics

Clients MUST use HTTPS for all API requests in production environments.

**Example Base URL:**
```
https://mastodon.social/api/v1/
```

## Authentication

### Bearer Token Authentication

Authenticated requests MUST include an OAuth 2.0 access token in the `Authorization` header:

```http
Authorization: Bearer <access_token>
```

### Unauthenticated Access

Some endpoints MAY be accessed without authentication:

- `GET /api/v1/instance`
- `GET /api/v2/instance`
- `GET /api/v1/timelines/public` (if server allows)
- `GET /api/v1/accounts/:id`
- `GET /api/v1/accounts/lookup`

Servers MAY disable unauthenticated API access via the `DISALLOW_UNAUTHENTICATED_API_ACCESS` environment variable.

## Common Headers

### Request Headers

| Header | Required | Description |
|--------|----------|-------------|
| `Authorization` | Conditional | Bearer token for authenticated requests |
| `Content-Type` | Conditional | `application/json` for POST/PUT/PATCH with JSON body |
| `Idempotency-Key` | Optional | Prevents duplicate status creation |

### Response Headers

| Header | Description |
|--------|-------------|
| `Link` | Pagination links (rel="next", rel="prev") |
| `X-RateLimit-Limit` | Maximum requests allowed |
| `X-RateLimit-Remaining` | Remaining requests in current window |
| `X-RateLimit-Reset` | Unix timestamp when rate limit resets |

## Rate Limiting

The API implements rate limiting to protect server resources. When rate-limited, the server responds with HTTP 429 Too Many Requests.

Clients SHOULD:
- Respect rate limit headers
- Implement exponential backoff on 429 responses
- Avoid unnecessary polling

Rate limit families include:
- General API requests
- Status creation (`statuses` family)
- Follow operations (`follows` family)

## ID Format

All entity IDs in the Mastodon API are **opaque strings**, not integers. Clients MUST:

- Treat IDs as strings, never parse them as numbers
- Not assume any ordering based on ID values
- Use provided pagination parameters for ordering

**Correct handling:**
```json
{
  "id": "109876543210123456",
  "in_reply_to_id": "109876543210123455"
}
```

IDs are serialized from internal integer identifiers but MUST be treated as opaque values. The numeric format is an implementation detail that MAY change.

## Error Responses

Error responses use standard HTTP status codes with a JSON body:

```json
{
  "error": "Description of the error"
}
```

### Common Status Codes

| Code | Meaning |
|------|---------|
| 200 | Success |
| 201 | Created |
| 202 | Accepted (processing) |
| 206 | Partial Content (feed regenerating, media processing) |
| 400 | Bad Request |
| 401 | Unauthorized (missing or invalid token) |
| 403 | Forbidden (insufficient scopes or permissions) |
| 404 | Not Found |
| 409 | Conflict (optimistic locking failure) |
| 422 | Unprocessable Entity (validation error) |
| 429 | Too Many Requests (rate limited) |
| 500 | Internal Server Error |

### Validation Errors

Validation failures return detailed error information:

```json
{
  "error": "Validation failed: Username has already been taken",
  "details": {
    "username": [
      {
        "error": "ERR_TAKEN",
        "description": "Username has already been taken"
      }
    ]
  }
}
```

## Content Types

### Request Content Types

- `application/json` - For JSON request bodies
- `application/x-www-form-urlencoded` - For form-encoded data
- `multipart/form-data` - For file uploads

### Response Content Type

All API responses use `application/json` unless otherwise specified.

## Timestamps

All timestamps are formatted as ISO 8601 strings:

```
2024-01-15T12:30:45.000Z
```

Clients MUST parse timestamps in UTC and SHOULD display them in the user's local timezone.

## HTML Content

The `content` field in statuses and notes contains sanitized HTML. Clients MUST:

- Properly render HTML content
- Handle custom emoji shortcodes embedded in content
- Support Mastodon's HTML structure (paragraphs, links, mentions, hashtags)

## File References

Key implementation files in the Mastodon codebase:

- Base controller: [`app/controllers/api/base_controller.rb`](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/base_controller.rb)
- Pagination: [`app/controllers/concerns/api/pagination.rb`](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/concerns/api/pagination.rb)
- Rate limiting: [`app/controllers/concerns/api/rate_limit_headers.rb`](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/concerns/api/rate_limit_headers.rb)
- Error handling: [`app/controllers/concerns/api/error_handling.rb`](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/concerns/api/error_handling.rb)

## Related Documents

- [OAuth Authentication](auth-oauth.md) - OAuth 2.0 flow details
- [Core Endpoints](core-endpoints.md) - Essential REST endpoints
- [Entities](entities.md) - Response entity schemas
- [Pagination](pagination.md) - Pagination patterns
