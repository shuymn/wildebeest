# OAuth Authentication

This document specifies the OAuth 2.0 authentication flow for Mastodon client applications.

## Overview

Mastodon implements OAuth 2.0 for client authentication. Clients MUST register an application before initiating the OAuth flow.

## App Registration

### POST /api/v1/apps

Register a new OAuth application.

**Authentication:** None required

**Request Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `client_name` | String | REQUIRED | Application name displayed to users |
| `redirect_uris` | String | REQUIRED | Space-separated list of redirect URIs |
| `scopes` | String | Optional | Space-separated list of scopes (defaults to `read`) |
| `website` | String | Optional | Application website URL |

**Request Example:**

```http
POST /api/v1/apps HTTP/1.1
Content-Type: application/x-www-form-urlencoded

client_name=My+Application&redirect_uris=https://app.example.com/callback&scopes=read+write+push&website=https://app.example.com
```

**Response Example:**

```json
{
  "id": "12345",
  "name": "My Application",
  "website": "https://app.example.com",
  "scopes": ["read", "write", "push"],
  "redirect_uri": "https://app.example.com/callback",
  "client_id": "abc123def456ghi789",
  "client_secret": "secret_abc123def456ghi789",
  "client_secret_expires_at": 0,
  "vapid_key": "BCk-QqERU0q-CfYZjcuB6lnyyOYfJ2AifKqfeGIm7Z-HiTU5T9eTG5GxVA0_OH5mMlI4UkkDTpaZwozy0TzdZ2M="
}
```

The `client_secret_expires_at` value of `0` indicates the secret never expires.

**Implementation Reference:** [app/controllers/api/v1/apps_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/apps_controller.rb)

### Redirect URI Requirements

- Clients MUST provide valid redirect URIs during registration
- The special URI `urn:ietf:wg:oauth:2.0:oob` MAY be used for out-of-band authorization (displays code to user)
- Redirect URIs with `javascript:`, `vbscript:`, or `data:` schemes are FORBIDDEN
- HTTPS is enforced for redirect URIs in production environments

## OAuth Authorization Flow

### Step 1: Authorization Request

Direct users to the authorization endpoint:

```
GET /oauth/authorize
```

**Query Parameters:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `response_type` | REQUIRED | MUST be `code` |
| `client_id` | REQUIRED | Application's client_id |
| `redirect_uri` | REQUIRED | One of the registered redirect URIs |
| `scope` | Optional | Space-separated scopes (defaults to `read`) |
| `state` | RECOMMENDED | Opaque value for CSRF protection |
| `code_challenge` | RECOMMENDED | PKCE code challenge |
| `code_challenge_method` | RECOMMENDED | MUST be `S256` if using PKCE |
| `force_login` | Optional | If `true`, forces re-authentication |

**Example Authorization URL:**

```
https://mastodon.social/oauth/authorize?response_type=code&client_id=abc123&redirect_uri=https://app.example.com/callback&scope=read%20write&state=randomstate123
```

### Step 2: User Authorization

The user authenticates and approves the application. Upon approval, the server redirects to the `redirect_uri` with:

```
https://app.example.com/callback?code=AUTHORIZATION_CODE&state=randomstate123
```

### Step 3: Token Exchange

Exchange the authorization code for an access token:

```
POST /oauth/token
```

**Request Parameters:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `grant_type` | REQUIRED | MUST be `authorization_code` |
| `code` | REQUIRED | Authorization code from step 2 |
| `client_id` | REQUIRED | Application's client_id |
| `client_secret` | REQUIRED | Application's client_secret |
| `redirect_uri` | REQUIRED | Same URI used in authorization request |
| `code_verifier` | Conditional | REQUIRED if PKCE was used |

**Request Example:**

```http
POST /oauth/token HTTP/1.1
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code&code=AUTH_CODE&client_id=abc123&client_secret=secret123&redirect_uri=https://app.example.com/callback
```

**Response Example:**

```json
{
  "access_token": "access_token_abc123",
  "token_type": "Bearer",
  "scope": "read write",
  "created_at": 1705312245
}
```

Access tokens do not expire by default (`access_token_expires_in nil` in configuration).

**Implementation Reference:** [app/controllers/oauth/tokens_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/oauth/tokens_controller.rb)

## PKCE Support

Mastodon supports Proof Key for Code Exchange (PKCE) to protect against authorization code interception attacks.

### Supported Methods

- `S256` - RECOMMENDED. SHA-256 hash of the code verifier.
- `plain` - NOT RECOMMENDED. Plain text code verifier (less secure).

### Implementation

1. Generate a cryptographically random `code_verifier` (43-128 characters)
2. Create `code_challenge`:
   - For S256: `BASE64URL(SHA256(code_verifier))`
   - For plain: `code_verifier`
3. Include `code_challenge` and `code_challenge_method` in authorization request
4. Include `code_verifier` in token exchange request

**Example Code Challenge Generation (S256):**

```javascript
const codeVerifier = generateRandomString(128);
const encoder = new TextEncoder();
const data = encoder.encode(codeVerifier);
const digest = await crypto.subtle.digest('SHA-256', data);
const codeChallenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
  .replace(/\+/g, '-')
  .replace(/\//g, '_')
  .replace(/=+$/, '');
```

**Configuration Reference:** [config/initializers/doorkeeper.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/config/initializers/doorkeeper.rb) - `pkce_code_challenge_methods ['S256']`

## Scopes

### Scope Hierarchy

Mastodon uses a hierarchical scope system. Parent scopes grant access to all child scopes.

| Parent Scope | Child Scopes |
|--------------|--------------|
| `read` | `read:accounts`, `read:blocks`, `read:bookmarks`, `read:favourites`, `read:filters`, `read:follows`, `read:lists`, `read:mutes`, `read:notifications`, `read:search`, `read:statuses` |
| `write` | `write:accounts`, `write:blocks`, `write:bookmarks`, `write:conversations`, `write:favourites`, `write:filters`, `write:follows`, `write:lists`, `write:media`, `write:mutes`, `write:notifications`, `write:reports`, `write:statuses` |
| `admin:read` | `admin:read:accounts`, `admin:read:reports`, `admin:read:domain_allows`, `admin:read:domain_blocks`, `admin:read:ip_blocks`, `admin:read:email_domain_blocks`, `admin:read:canonical_email_blocks` |
| `admin:write` | `admin:write:accounts`, `admin:write:reports`, `admin:write:domain_allows`, `admin:write:domain_blocks`, `admin:write:ip_blocks`, `admin:write:email_domain_blocks`, `admin:write:canonical_email_blocks` |

### Special Scopes

| Scope | Description |
|-------|-------------|
| `profile` | Read basic account information only |
| `follow` | Follow and unfollow accounts |
| `push` | Receive push notifications |

### Default Scope

If no scope is specified, `read` is used as the default.

**Configuration Reference:** [config/initializers/doorkeeper.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/config/initializers/doorkeeper.rb)

## Grant Types

### Supported Grant Types

| Grant Type | Use Case |
|------------|----------|
| `authorization_code` | Standard OAuth flow for user authorization |
| `client_credentials` | App-only access without user context |

### Client Credentials Grant

For accessing public data without user authentication:

```http
POST /oauth/token HTTP/1.1
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials&client_id=abc123&client_secret=secret123&scope=read
```

**Response:**

```json
{
  "access_token": "app_access_token_abc123",
  "token_type": "Bearer",
  "scope": "read",
  "created_at": 1705312245
}
```

**Account Registration:**

Creating user accounts via `POST /api/v1/accounts` requires an OAuth token **without a resource owner** (i.e., no user context). This is typically obtained via the `client_credentials` grant. Tokens obtained via `authorization_code` grant (which have a resource owner) are explicitly rejected for account registration.

### Unsupported Grant Types

The following grant types are disabled for security reasons:

- `password` (Resource Owner Password Credentials)
- `implicit`

## Token Revocation

### POST /oauth/revoke

Revoke an access token.

**Request Parameters:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `client_id` | REQUIRED | Application's client_id |
| `client_secret` | REQUIRED | Application's client_secret |
| `token` | REQUIRED | Access token to revoke |

**Request Example:**

```http
POST /oauth/revoke HTTP/1.1
Content-Type: application/x-www-form-urlencoded

client_id=abc123&client_secret=secret123&token=access_token_abc123
```

**Response:**

Returns 200 OK with empty body on success.

Token revocation also removes any associated push subscriptions.

**Implementation Reference:** [app/controllers/oauth/tokens_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/oauth/tokens_controller.rb)

## Verify Application Credentials

### GET /api/v1/apps/verify_credentials

Verify the current application token.

**Authentication:** Bearer token required

**Response Example:**

```json
{
  "id": "12345",
  "name": "My Application",
  "website": "https://app.example.com",
  "scopes": ["read", "write", "push"],
  "redirect_uri": "https://app.example.com/callback",
  "vapid_key": "BCk-QqERU0q-CfYZjcuB6lnyyOYfJ2AifKqfeGIm7Z-HiTU5T9eTG5GxVA0_OH5mMlI4UkkDTpaZwozy0TzdZ2M="
}
```

Note: `client_id` and `client_secret` are NOT included in this response.

**Implementation Reference:** [app/controllers/api/v1/apps/credentials_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/apps/credentials_controller.rb)

## Security Considerations

### Token Storage

Clients MUST:
- Store access tokens securely
- Never expose tokens in URLs or logs
- Use secure storage mechanisms (Keychain, Credential Manager)

### PKCE Recommendation

Clients SHOULD use PKCE (S256 method) for all authorization code flows, especially:
- Native mobile applications
- Single-page applications
- Desktop applications

### State Parameter

Clients MUST:
- Generate a cryptographically random `state` value
- Verify the `state` matches on callback
- Protect against CSRF attacks

## File References

- App registration: [app/controllers/api/v1/apps_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/apps_controller.rb)
- App credentials: [app/controllers/api/v1/apps/credentials_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/api/v1/apps/credentials_controller.rb)
- Authorization: [app/controllers/oauth/authorizations_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/oauth/authorizations_controller.rb)
- Tokens: [app/controllers/oauth/tokens_controller.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/controllers/oauth/tokens_controller.rb)
- Scopes configuration: [config/initializers/doorkeeper.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/config/initializers/doorkeeper.rb)
- Serializers: [app/serializers/rest/credential_application_serializer.rb](https://github.com/mastodon/mastodon/blob/v4.5.3/app/serializers/rest/credential_application_serializer.rb)
