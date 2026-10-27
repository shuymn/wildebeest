# WebFinger Endpoint

This document specifies the WebFinger endpoint for Mastodon-compatible servers, as defined in [RFC 7033](https://www.rfc-editor.org/rfc/rfc7033).

## Endpoint

```
GET /.well-known/webfinger
```

## Purpose

The WebFinger endpoint enables discovery of account information using the `acct:` URI scheme or HTTPS URLs. Remote servers use this endpoint to resolve user identities during federation.

## Request

### Query Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `resource` | string | Yes | The resource identifier to look up |

### Resource Parameter Formats

The `resource` parameter MUST be in one of the following formats:

1. **acct: URI format**: `acct:username@domain`
   - Example: `acct:alice@mastodon.social`

2. **HTTPS URL format**: `https://domain/@username` or `https://domain/users/username`
   - Example: `https://mastodon.social/@alice`
   - Example: `https://mastodon.social/users/alice`

3. **Domain-only format**: `https://domain` or `domain`
   - Used for resolving the instance actor (server-level actor)
   - Example: `https://mastodon.social`

### Domain Validation

- The domain portion of the resource MUST match either the server's `local_domain` or `web_domain`
- Alternate domains configured via `alternate_domains` are also accepted and normalized to the primary domain

## Response

### Content Type

```
Content-Type: application/jrd+json
```

### Response Structure

```json
{
  "subject": "acct:username@domain",
  "aliases": [
    "https://domain/@username",
    "https://domain/users/username"
  ],
  "links": [
    {
      "rel": "http://webfinger.net/rel/profile-page",
      "type": "text/html",
      "href": "https://domain/@username"
    },
    {
      "rel": "self",
      "type": "application/activity+json",
      "href": "https://domain/users/username"
    },
    {
      "rel": "http://ostatus.org/schema/1.0/subscribe",
      "template": "https://domain/authorize_interaction?uri={uri}"
    },
    {
      "rel": "http://webfinger.net/rel/avatar",
      "type": "image/png",
      "href": "https://domain/path/to/avatar.png"
    }
  ]
}
```

### Response Fields

#### subject

- **Type**: string
- **Format**: `acct:username@local_domain`
- **Description**: The canonical identifier for the account in acct: URI format

#### aliases

- **Type**: array of strings
- **Description**: Alternative identifiers for the account

For regular accounts, aliases include:
1. The short account URL: `https://domain/@username`
2. The ActivityPub actor URI: `https://domain/users/username`

For the instance actor, aliases include:
1. The instance actor URL: `https://domain/actor`

#### links

Each link object contains:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `rel` | string | Yes | The link relation type |
| `type` | string | Conditional | MIME type of the linked resource |
| `href` | string | Conditional | URL of the linked resource |
| `template` | string | Conditional | URI template (for subscribe link) |

##### Required Links

1. **Profile Page** (`http://webfinger.net/rel/profile-page`)
   - `type`: `text/html`
   - `href`: The human-readable profile URL
   - For regular accounts: `https://domain/@username`
   - For instance actor: `https://domain/about/more?instance_actor=true`

2. **Self** (`self`)
   - `type`: `application/activity+json`
   - `href`: The ActivityPub actor URI
   - This is the canonical ActivityPub identifier for federation

3. **Subscribe Template** (`http://ostatus.org/schema/1.0/subscribe`)
   - `template`: `https://domain/authorize_interaction?uri={uri}`
   - Used for remote follow functionality
   - The `{uri}` placeholder is replaced with the account URI to follow

##### Optional Links

4. **Avatar** (`http://webfinger.net/rel/avatar`)
   - Included only when all conditions are met:
     - Account has an avatar uploaded
     - Avatar has a valid content type
     - `DISALLOW_UNAUTHENTICATED_API_ACCESS` is not `true`
     - Server is not in limited federation mode
   - `type`: The MIME type of the avatar (e.g., `image/png`, `image/jpeg`)
   - `href`: Full URL to the original avatar image

## Status Codes

| Code | Description |
|------|-------------|
| 200 | Success - account found |
| 400 | Bad Request - missing or invalid `resource` parameter |
| 404 | Not Found - account does not exist |
| 410 | Gone - account is permanently unavailable (suspended and deletion completed) |

## Caching

### Successful Responses (200)

```
Cache-Control: max-age=259200, public
```

- HTTP cache duration: 3 days
- Responses MAY be cached by intermediaries

### Error Responses (400, 404, 410)

```
Cache-Control: max-age=180, public
```

- HTTP cache duration: 3 minutes
- Short cache prevents rapid repeated lookups for invalid resources

### Vary Header

Responses MAY include a `Vary: Origin` header when CORS is enabled via `Rack::Cors` middleware. This is not explicitly set by the controller but may be added by the CORS middleware configuration.

## Instance Actor

When the resource matches the server's domain (without a username), the endpoint returns information for the instance actor:

- **Resource**: `https://mastodon.social` or just the domain
- **Subject**: `acct:mastodon.social@mastodon.social`
- **Purpose**: Server-to-server authentication and instance-level ActivityPub operations

## Examples

### Request for User Account

```http
GET /.well-known/webfinger?resource=acct:alice@mastodon.social HTTP/1.1
Host: mastodon.social
Accept: application/jrd+json
```

### Response for User Account

```http
HTTP/1.1 200 OK
Content-Type: application/jrd+json; charset=utf-8
Cache-Control: max-age=259200, public

{
  "subject": "acct:alice@mastodon.social",
  "aliases": [
    "https://mastodon.social/@alice",
    "https://mastodon.social/users/alice"
  ],
  "links": [
    {
      "rel": "http://webfinger.net/rel/profile-page",
      "type": "text/html",
      "href": "https://mastodon.social/@alice"
    },
    {
      "rel": "self",
      "type": "application/activity+json",
      "href": "https://mastodon.social/users/alice"
    },
    {
      "rel": "http://ostatus.org/schema/1.0/subscribe",
      "template": "https://mastodon.social/authorize_interaction?uri={uri}"
    },
    {
      "rel": "http://webfinger.net/rel/avatar",
      "type": "image/png",
      "href": "https://mastodon.social/system/accounts/avatars/000/000/001/original/avatar.png"
    }
  ]
}
```

### Request Using HTTPS URL

```http
GET /.well-known/webfinger?resource=https://mastodon.social/@alice HTTP/1.1
Host: mastodon.social
Accept: application/jrd+json
```

### Error Response - Missing Resource

```http
HTTP/1.1 400 Bad Request
Cache-Control: max-age=180, public
Vary: Origin
```

### Error Response - Account Not Found

```http
HTTP/1.1 404 Not Found
Cache-Control: max-age=180, public
Vary: Origin
```

### Error Response - Account Suspended

```http
HTTP/1.1 410 Gone
Cache-Control: max-age=180, public
Vary: Origin
```

## Implementation Requirements

### Servers MUST:

1. Support the `acct:` URI scheme for the `resource` parameter
2. Support HTTPS URLs pointing to account profile pages
3. Return `application/jrd+json` content type
4. Include the `self` link with `application/activity+json` type
5. Return 404 for accounts that do not exist locally
6. Return 410 for accounts that are permanently unavailable

### Servers SHOULD:

1. Support alternate domain configurations
2. Include the avatar link when conditions permit
3. Implement appropriate caching headers

### Servers MAY:

1. Support the instance actor lookup via domain-only resources
2. Support additional link relations beyond those specified

## Security Considerations

1. The WebFinger endpoint only returns information for local accounts
2. Remote account lookups are not performed at this endpoint
3. Suspended accounts return 410 Gone rather than account details
4. The avatar link respects privacy settings and federation mode

## Related Specifications

- [RFC 7033 - WebFinger](https://www.rfc-editor.org/rfc/rfc7033)
- [RFC 7565 - The 'acct' URI Scheme](https://www.rfc-editor.org/rfc/rfc7565)
- [ActivityPub - W3C Recommendation](https://www.w3.org/TR/activitypub/)
