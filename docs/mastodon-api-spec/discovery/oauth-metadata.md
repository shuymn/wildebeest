# OAuth Authorization Server Metadata

This document specifies the OAuth Authorization Server Metadata endpoint for Mastodon-compatible servers, implementing [RFC 8414](https://www.rfc-editor.org/rfc/rfc8414).

## Endpoint

```
GET /.well-known/oauth-authorization-server
```

## Purpose

The OAuth Authorization Server Metadata endpoint provides clients with information about the OAuth 2.0 authorization server configuration, enabling automatic discovery of authorization endpoints, supported scopes, and authentication methods.

## Response

### Content Type

```
Content-Type: application/json
```

### Response Structure

```json
{
  "issuer": "https://mastodon.social/",
  "authorization_endpoint": "https://mastodon.social/oauth/authorize",
  "token_endpoint": "https://mastodon.social/oauth/token",
  "revocation_endpoint": "https://mastodon.social/oauth/revoke",
  "userinfo_endpoint": "https://mastodon.social/oauth/userinfo",
  "scopes_supported": [
    "read",
    "profile",
    "write",
    "write:accounts",
    "write:blocks",
    "..."
  ],
  "response_types_supported": [
    "code"
  ],
  "response_modes_supported": [
    "query",
    "fragment"
  ],
  "grant_types_supported": [
    "authorization_code",
    "client_credentials"
  ],
  "token_endpoint_auth_methods_supported": [
    "client_secret_basic",
    "client_secret_post"
  ],
  "code_challenge_methods_supported": [
    "S256"
  ],
  "service_documentation": "https://docs.joinmastodon.org/",
  "app_registration_endpoint": "https://mastodon.social/api/v1/apps"
}
```

### Response Fields

#### issuer

- **Type**: string (URL)
- **Description**: The authorization server's issuer identifier
- **Value**: The root URL of the Mastodon instance (e.g., `https://mastodon.social/`)
- **Required**: Yes (per RFC 8414)

#### authorization_endpoint

- **Type**: string (URL)
- **Description**: URL of the authorization endpoint
- **Value**: `{issuer}/oauth/authorize`
- **Required**: Yes

#### token_endpoint

- **Type**: string (URL)
- **Description**: URL of the token endpoint
- **Value**: `{issuer}/oauth/token`
- **Required**: Yes

#### revocation_endpoint

- **Type**: string (URL)
- **Description**: URL of the token revocation endpoint (per RFC 7009)
- **Value**: `{issuer}/oauth/revoke`
- **Required**: No (RECOMMENDED)

#### userinfo_endpoint

- **Type**: string (URL)
- **Description**: URL of the UserInfo endpoint (per OpenID Connect Core 1.0)
- **Value**: `{issuer}/oauth/userinfo`
- **Required**: No

#### scopes_supported

- **Type**: array of strings
- **Description**: List of OAuth 2.0 scope values supported
- **Required**: No (RECOMMENDED)

##### Supported Scopes

| Scope | Description |
|-------|-------------|
| `read` | Read access to all resources |
| `profile` | Read access to user profile information |
| `write` | Write access to all resources |
| `write:accounts` | Modify account information |
| `write:blocks` | Manage blocks |
| `write:bookmarks` | Manage bookmarks |
| `write:conversations` | Manage conversations |
| `write:favourites` | Manage favourites |
| `write:filters` | Manage filters |
| `write:follows` | Manage follows |
| `write:lists` | Manage lists |
| `write:media` | Upload media |
| `write:mutes` | Manage mutes |
| `write:notifications` | Manage notifications |
| `write:reports` | Create reports |
| `write:statuses` | Create and manage statuses |
| `read:accounts` | Read account information |
| `read:blocks` | Read blocks |
| `read:bookmarks` | Read bookmarks |
| `read:favourites` | Read favourites |
| `read:filters` | Read filters |
| `read:follows` | Read follows |
| `read:lists` | Read lists |
| `read:mutes` | Read mutes |
| `read:notifications` | Read notifications |
| `read:search` | Perform searches |
| `read:statuses` | Read statuses |
| `follow` | Legacy scope for follow operations |
| `push` | Web Push API access |
| `admin:read` | Administrative read access |
| `admin:read:accounts` | Read admin account data |
| `admin:read:reports` | Read admin reports |
| `admin:read:domain_allows` | Read domain allows |
| `admin:read:domain_blocks` | Read domain blocks |
| `admin:read:ip_blocks` | Read IP blocks |
| `admin:read:email_domain_blocks` | Read email domain blocks |
| `admin:read:canonical_email_blocks` | Read canonical email blocks |
| `admin:write` | Administrative write access |
| `admin:write:accounts` | Manage admin accounts |
| `admin:write:reports` | Manage admin reports |
| `admin:write:domain_allows` | Manage domain allows |
| `admin:write:domain_blocks` | Manage domain blocks |
| `admin:write:ip_blocks` | Manage IP blocks |
| `admin:write:email_domain_blocks` | Manage email domain blocks |
| `admin:write:canonical_email_blocks` | Manage canonical email blocks |

#### response_types_supported

- **Type**: array of strings
- **Description**: List of OAuth 2.0 response types supported
- **Value**: `["code"]`
- **Required**: Yes

Mastodon supports only the `code` response type (Authorization Code flow).

#### response_modes_supported

- **Type**: array of strings
- **Description**: List of OAuth 2.0 response modes supported
- **Value**: `["query", "fragment"]`
- **Required**: No

#### grant_types_supported

- **Type**: array of strings
- **Description**: List of OAuth 2.0 grant types supported
- **Value**: `["authorization_code", "client_credentials"]`
- **Required**: No (RECOMMENDED)

| Grant Type | Description |
|------------|-------------|
| `authorization_code` | Standard OAuth 2.0 authorization code flow |
| `client_credentials` | Client credentials flow for server-to-server |

Note: Mastodon does not enable refresh tokens by default. If enabled, `refresh_token` would be added to this list.

#### token_endpoint_auth_methods_supported

- **Type**: array of strings
- **Description**: Client authentication methods supported at the token endpoint
- **Value**: `["client_secret_basic", "client_secret_post"]`
- **Required**: No

| Method | Description |
|--------|-------------|
| `client_secret_basic` | HTTP Basic authentication with client credentials |
| `client_secret_post` | Client credentials in POST body |

#### code_challenge_methods_supported

- **Type**: array of strings
- **Description**: PKCE code challenge methods supported
- **Value**: `["S256"]`
- **Required**: No

Mastodon supports PKCE with the `S256` (SHA-256) method only. The `plain` method is not supported for security reasons.

#### service_documentation

- **Type**: string (URL)
- **Description**: URL to the service documentation
- **Value**: `https://docs.joinmastodon.org/`
- **Required**: No

#### app_registration_endpoint (Non-Standard)

- **Type**: string (URL)
- **Description**: URL to the application registration endpoint
- **Value**: `{issuer}/api/v1/apps`
- **Required**: No (Mastodon extension)

This is a **non-standard extension** to the OAuth metadata specification. It points to the Mastodon-specific application registration endpoint, which does not conform to [RFC 7591 (OAuth 2.0 Dynamic Client Registration)](https://www.rfc-editor.org/rfc/rfc7591).

Clients SHOULD use this endpoint to register applications dynamically, but MUST be aware that it follows Mastodon's custom API rather than RFC 7591.

## Status Codes

| Code | Description |
|------|-------------|
| 200 | Success |

## Caching

The OAuth metadata response uses **Rails internal caching only**, not HTTP caching:

- Rails cache duration: 15 minutes
- No `Cache-Control` header is set

This approach is used because the document may change between Mastodon versions as new OAuth scopes are added.

## Examples

### Request

```http
GET /.well-known/oauth-authorization-server HTTP/1.1
Host: mastodon.social
Accept: application/json
```

### Response

```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8

{
  "issuer": "https://mastodon.social/",
  "authorization_endpoint": "https://mastodon.social/oauth/authorize",
  "token_endpoint": "https://mastodon.social/oauth/token",
  "revocation_endpoint": "https://mastodon.social/oauth/revoke",
  "userinfo_endpoint": "https://mastodon.social/oauth/userinfo",
  "scopes_supported": [
    "read",
    "profile",
    "write",
    "write:accounts",
    "write:blocks",
    "write:bookmarks",
    "write:conversations",
    "write:favourites",
    "write:filters",
    "write:follows",
    "write:lists",
    "write:media",
    "write:mutes",
    "write:notifications",
    "write:reports",
    "write:statuses",
    "read:accounts",
    "read:blocks",
    "read:bookmarks",
    "read:favourites",
    "read:filters",
    "read:follows",
    "read:lists",
    "read:mutes",
    "read:notifications",
    "read:search",
    "read:statuses",
    "follow",
    "push",
    "admin:read",
    "admin:read:accounts",
    "admin:read:reports",
    "admin:read:domain_allows",
    "admin:read:domain_blocks",
    "admin:read:ip_blocks",
    "admin:read:email_domain_blocks",
    "admin:read:canonical_email_blocks",
    "admin:write",
    "admin:write:accounts",
    "admin:write:reports",
    "admin:write:domain_allows",
    "admin:write:domain_blocks",
    "admin:write:ip_blocks",
    "admin:write:email_domain_blocks",
    "admin:write:canonical_email_blocks"
  ],
  "response_types_supported": [
    "code"
  ],
  "response_modes_supported": [
    "query",
    "fragment"
  ],
  "grant_types_supported": [
    "authorization_code",
    "client_credentials"
  ],
  "token_endpoint_auth_methods_supported": [
    "client_secret_basic",
    "client_secret_post"
  ],
  "code_challenge_methods_supported": [
    "S256"
  ],
  "service_documentation": "https://docs.joinmastodon.org/",
  "app_registration_endpoint": "https://mastodon.social/api/v1/apps"
}
```

## Implementation Requirements

### Servers MUST:

1. Provide the endpoint at `/.well-known/oauth-authorization-server`
2. Return valid JSON with `application/json` content type
3. Include the `issuer` field matching the server's root URL
4. Include `authorization_endpoint` and `token_endpoint`
5. List all supported scopes in `scopes_supported`
6. Include `code` in `response_types_supported`

### Servers SHOULD:

1. Include `revocation_endpoint` for token revocation
2. Include `code_challenge_methods_supported` with `S256`
3. Include `token_endpoint_auth_methods_supported`
4. Include `grant_types_supported`
5. Cache the response internally to reduce computation

### Servers MAY:

1. Include the non-standard `app_registration_endpoint`
2. Include `userinfo_endpoint`
3. Include `service_documentation`

## Security Considerations

1. The endpoint is publicly accessible without authentication
2. No sensitive information is exposed
3. PKCE with S256 MUST be used for public clients
4. The `plain` PKCE method is intentionally not supported
5. Clients SHOULD verify the `issuer` matches the expected server

## Differences from RFC 7591

The `app_registration_endpoint` points to `/api/v1/apps`, which uses Mastodon's custom registration API:

| Feature | RFC 7591 | Mastodon `/api/v1/apps` |
|---------|----------|-------------------------|
| Request format | Standard OAuth DCR | Custom Mastodon format |
| Response format | Standard OAuth DCR | Custom Mastodon format |
| Client ID/Secret | Generated per RFC | Generated per Mastodon |
| Redirect URIs | `redirect_uris` array | `redirect_uris` string (newline-separated) |

## Related Specifications

- [RFC 8414 - OAuth 2.0 Authorization Server Metadata](https://www.rfc-editor.org/rfc/rfc8414)
- [RFC 6749 - OAuth 2.0 Authorization Framework](https://www.rfc-editor.org/rfc/rfc6749)
- [RFC 7009 - OAuth 2.0 Token Revocation](https://www.rfc-editor.org/rfc/rfc7009)
- [RFC 7636 - PKCE](https://www.rfc-editor.org/rfc/rfc7636)
- [RFC 7591 - OAuth 2.0 Dynamic Client Registration](https://www.rfc-editor.org/rfc/rfc7591)
- [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html)
