# Authorized Fetch Mode

Authorized fetch (also known as "secure mode") requires HTTP signatures on ActivityPub GET requests for public resources. The exact enforcement depends on the endpoint and content type.

## Overview

By default, ActivityPub resources (actor profiles, outboxes, posts) are publicly accessible without authentication when requested with `Accept: application/activity+json`. Authorized fetch mode adds signature verification to these JSON requests, limiting access to authenticated federation partners.

> **Note**: HTML requests (browser views) are generally not affected by authorized fetch mode. Signature requirements apply specifically to ActivityPub/JSON endpoints.

## Configuration

Authorized fetch mode is enabled when ANY of:

1. Environment variable `AUTHORIZED_FETCH=true`
2. Setting `authorized_fetch` is enabled (and env var not set)
3. Limited federation mode is enabled

```ruby
authorized_fetch_mode? =
  ENV['AUTHORIZED_FETCH'] == 'true' ||
  (Setting.authorized_fetch && !ENV.key?('AUTHORIZED_FETCH')) ||
  limited_federation_mode
```

## Effects

### Endpoints Requiring Signatures

When authorized fetch is enabled, these endpoints require valid HTTP signatures:

| Endpoint | Normal Mode | Authorized Fetch |
|----------|-------------|------------------|
| Actor profile | Public | Signature required |
| Outbox | Public | Signature required |
| Followers collection | Public | Signature required |
| Following collection | Public | Signature required |
| Featured posts | Public | Signature required |
| Single status | Public | Signature required |

### Cache Behavior

| Mode | Vary Header | Cache-Control |
|------|-------------|---------------|
| Public fetch | None | `public` |
| Authorized fetch | `Signature` | `private` |

Including `Vary: Signature` ensures caches don't serve responses to different requesters incorrectly.

## Request Requirements

In authorized fetch mode, GET requests MUST include:

1. `Signature` header (or `Signature-Input` for RFC 9421)
2. Valid signature from a known actor
3. `Date` header (or `(created)` parameter)
4. Signed `host` header

See [Security & Signatures](security-signatures.md) for complete signature requirements.

## Response Codes

### Success

- `200 OK` - Request authenticated successfully

### Failure

- `401 Unauthorized` - Missing or invalid signature

```json
{
  "error": "Request not signed"
}
```

## Use Cases

### Enhanced Privacy

Authorized fetch prevents:

- Anonymous scraping of public posts
- Unauthenticated access to user profiles
- Indexing by non-federated services

### Limited Federation

When combined with domain allowlisting, authorized fetch enables:

- Closed federation networks
- Invite-only instance clusters
- Private community federations

## Implementation Considerations

### Performance

Authorized fetch mode:

- Increases CPU usage (signature verification on every request)
- Reduces cache effectiveness (per-requester caching)
- May increase latency (key fetching)

### Compatibility

Some older ActivityPub implementations may not sign GET requests. Enabling authorized fetch may break federation with:

- Legacy Mastodon versions
- Some third-party ActivityPub implementations
- Relay services without signature support

### Monitoring

Servers SHOULD log signature verification failures separately from other errors to help diagnose federation issues.

## Configuration Override

The `AUTHORIZED_FETCH` environment variable takes precedence over the database setting:

| ENV var | Setting | Result |
|---------|---------|--------|
| `true` | any | Enabled |
| `false` | any | Disabled |
| not set | `true` | Enabled |
| not set | `false` | Disabled |

Limited federation mode always enables authorized fetch regardless of other settings.
