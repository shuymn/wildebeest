# NodeInfo Discovery and Schema

This document specifies the NodeInfo endpoints for Mastodon-compatible servers, implementing the [NodeInfo protocol](http://nodeinfo.diaspora.software/protocol) version 2.0.

## Overview

NodeInfo provides a standardized way to expose server metadata for federated social networks. The protocol consists of two endpoints:

1. **Discovery endpoint**: Points clients to the schema document
2. **Schema endpoint**: Contains the actual server metadata

## Discovery Endpoint

```
GET /.well-known/nodeinfo
```

### Purpose

The discovery endpoint provides a JSON document containing links to available NodeInfo schema versions supported by the server.

### Response

#### Content Type

```
Content-Type: application/json
```

#### Response Structure

```json
{
  "links": [
    {
      "rel": "http://nodeinfo.diaspora.software/ns/schema/2.0",
      "href": "https://mastodon.social/nodeinfo/2.0"
    }
  ]
}
```

#### Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `links` | array | List of available NodeInfo schema endpoints |
| `links[].rel` | string | The NodeInfo schema namespace URI |
| `links[].href` | string | URL to the NodeInfo schema document |

### Status Codes

| Code | Description |
|------|-------------|
| 200 | Success |

### Caching

```
Cache-Control: max-age=259200, public
```

- HTTP cache duration: 3 days
- Rails internal cache: 3 days

## Schema Endpoint

```
GET /nodeinfo/2.0
```

### Purpose

The schema endpoint returns detailed metadata about the server, including software information, protocols supported, usage statistics, and server configuration.

### Response

#### Content Type

```
Content-Type: application/json
```

#### Response Structure

```json
{
  "version": "2.0",
  "software": {
    "name": "mastodon",
    "version": "4.2.0"
  },
  "protocols": [
    "activitypub"
  ],
  "services": {
    "outbound": [],
    "inbound": []
  },
  "usage": {
    "users": {
      "total": 123456,
      "activeMonth": 5000,
      "activeHalfyear": 15000
    },
    "localPosts": 987654
  },
  "openRegistrations": true,
  "metadata": {
    "nodeName": "Mastodon",
    "nodeDescription": "A Mastodon instance"
  }
}
```

### Response Fields

#### version

- **Type**: string
- **Value**: `"2.0"`
- **Description**: The NodeInfo schema version

#### software

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Always `"mastodon"` |
| `version` | string | The Mastodon version string (e.g., `"4.2.0"`) |

#### protocols

- **Type**: array of strings
- **Value**: `["activitypub"]`
- **Description**: Federation protocols supported by this server

#### services

| Field | Type | Description |
|-------|------|-------------|
| `outbound` | array | External services the server can post to (empty array) |
| `inbound` | array | External services the server can receive from (empty array) |

Mastodon does not use third-party services integration via NodeInfo, so both arrays are always empty.

#### usage

| Field | Type | Description |
|-------|------|-------------|
| `users` | object | User statistics |
| `users.total` | integer | Total number of confirmed, non-suspended users |
| `users.activeMonth` | integer | Users active in the last 4 weeks |
| `users.activeHalfyear` | integer | Users active in the last 24 weeks |
| `localPosts` | integer | Total number of local statuses |

##### User Statistics Details

- **total**: Count of users where `User.confirmed` is true and associated account is not suspended
- **activeMonth**: Unique logins tracked over the past 4 weeks
- **activeHalfyear**: Unique logins tracked over the past 24 weeks

#### openRegistrations

- **Type**: boolean
- **Description**: Whether the server accepts new user registrations

The value is `true` when:
- `registrations_mode` setting is not `"none"`
- Server is not in single-user mode

The value is `false` when:
- Registrations are closed (`registrations_mode` is `"none"`)
- Server is configured as single-user mode

#### metadata

| Field | Type | Description |
|-------|------|-------------|
| `nodeName` | string | The instance title from settings |
| `nodeDescription` | string | The short description from settings |

### Status Codes

| Code | Description |
|------|-------------|
| 200 | Success |

### Caching

```
Cache-Control: max-age=1800, public
```

- HTTP cache duration: 30 minutes
- Rails internal cache: 30 minutes

## Key Transformation

All response keys use **camelCase** formatting. This is implemented via the `NodeInfo::Adapter` which applies a `:camel_lower` key transformation:

| Internal Key | JSON Key |
|--------------|----------|
| `open_registrations` | `openRegistrations` |
| `local_posts` | `localPosts` |
| `active_month` | `activeMonth` |
| `active_halfyear` | `activeHalfyear` |

## Examples

### Discovery Request

```http
GET /.well-known/nodeinfo HTTP/1.1
Host: mastodon.social
Accept: application/json
```

### Discovery Response

```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
Cache-Control: max-age=259200, public

{
  "links": [
    {
      "rel": "http://nodeinfo.diaspora.software/ns/schema/2.0",
      "href": "https://mastodon.social/nodeinfo/2.0"
    }
  ]
}
```

### Schema Request

```http
GET /nodeinfo/2.0 HTTP/1.1
Host: mastodon.social
Accept: application/json
```

### Schema Response

```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
Cache-Control: max-age=1800, public

{
  "version": "2.0",
  "software": {
    "name": "mastodon",
    "version": "4.2.0"
  },
  "protocols": [
    "activitypub"
  ],
  "services": {
    "outbound": [],
    "inbound": []
  },
  "usage": {
    "users": {
      "total": 150000,
      "activeMonth": 8500,
      "activeHalfyear": 25000
    },
    "localPosts": 1250000
  },
  "openRegistrations": true,
  "metadata": {
    "nodeName": "Mastodon",
    "nodeDescription": "The original server operated by the Mastodon gGmbH non-profit"
  }
}
```

## Implementation Requirements

### Servers MUST:

1. Provide the discovery endpoint at `/.well-known/nodeinfo`
2. Provide the schema endpoint at `/nodeinfo/2.0`
3. Return valid JSON with `application/json` content type
4. Use camelCase for all JSON keys
5. Include all required fields in the schema response
6. Return the `version` field as `"2.0"`
7. Return `"mastodon"` as the software name

### Servers SHOULD:

1. Cache responses appropriately (3 days for discovery, 30 minutes for schema)
2. Provide accurate user statistics
3. Keep the `protocols` array containing `"activitypub"`

### Servers MAY:

1. Include additional metadata fields
2. Support additional NodeInfo schema versions via the discovery endpoint

## Security Considerations

1. NodeInfo exposes aggregate statistics only; no individual user data is revealed
2. User counts exclude suspended accounts
3. The endpoint is publicly accessible without authentication
4. Servers in limited federation mode still expose NodeInfo

## Related Specifications

- [NodeInfo Protocol](http://nodeinfo.diaspora.software/protocol)
- [NodeInfo Schema 2.0](http://nodeinfo.diaspora.software/schema/2.0)
- [ActivityPub - W3C Recommendation](https://www.w3.org/TR/activitypub/)
