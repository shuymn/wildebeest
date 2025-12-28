# HTTP Signatures

This document specifies the HTTP signature requirements for ActivityPub federation requests.

## Overview

All POST requests to federation endpoints MUST be signed. GET requests MAY require signatures when [Authorized Fetch](authorized-fetch.md) mode is enabled.

Mastodon supports two signature schemes:

1. **HTTP Signatures (Draft 6)** - Legacy scheme using `Signature` header
2. **HTTP Message Signatures (RFC 9421)** - Modern scheme using `Signature-Input` header

## Scheme Detection

Servers MUST detect the signature scheme based on headers:

- If `Signature-Input` header is present: Use RFC 9421
- Otherwise: Use HTTP Signatures Draft 6

## HTTP Signatures (Draft 6)

Reference: [draft-cavage-http-signatures-06](https://tools.ietf.org/html/draft-cavage-http-signatures-06)

### Signature Header Format

```
Signature: keyId="https://example.com/users/alice#main-key",
           algorithm="hs2019",
           headers="(request-target) host date digest",
           signature="base64-encoded-signature"
```

### Required Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `keyId` | MUST | URL of the public key |
| `signature` | MUST | Base64-encoded signature |
| `algorithm` | SHOULD | `rsa-sha256` or `hs2019` (default: `hs2019`) |
| `headers` | SHOULD | Space-separated list of signed headers |
| `created` | MAY | Unix timestamp (required for `hs2019`) |
| `expires` | MAY | Unix timestamp |

### Supported Algorithms

| Algorithm | Status |
|-----------|--------|
| `hs2019` | Recommended (default) |
| `rsa-sha256` | Supported |

Other algorithms MUST be rejected with 401 Unauthorized.

### Required Signed Headers

#### GET Requests

The signature MUST include:

- `date` OR `(created)` pseudo-header
- `(request-target)` OR `digest`
- `host`

#### POST Requests

The signature MUST include:

- `date` OR `(created)` pseudo-header
- `(request-target)` OR `digest`
- `digest` (required for POST)

### Pseudo-Headers

| Pseudo-Header | Format | Algorithm |
|---------------|--------|-----------|
| `(request-target)` | `{method} {path}[?{query}]` | All |
| `(created)` | Unix timestamp | `hs2019` only |
| `(expires)` | Unix timestamp | `hs2019` only |

Example `(request-target)`:
```
(request-target): post /inbox
(request-target): get /users/alice?page=1
```

### Digest Header

For POST requests, the `Digest` header MUST be present and signed:

```
Digest: sha-256=X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE=
```

Requirements:

- MUST use SHA-256 algorithm (other algorithms rejected)
- Value MUST be Base64-encoded SHA-256 hash of raw request body
- MUST match computed digest

### Signature String Construction

The signature is computed over a string built from signed headers:

```
(request-target): post /inbox
host: mastodon.example
date: Sun, 06 Nov 1994 08:49:37 GMT
digest: sha-256=X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE=
```

Rules:

- Headers are joined with newlines (`\n`)
- Header names are lowercase
- Pseudo-headers use their literal form (e.g., `(request-target)`)
- Query string SHOULD be included in `(request-target)` (backward compatibility: may be omitted)

## HTTP Message Signatures (RFC 9421)

Reference: [RFC 9421](https://www.rfc-editor.org/rfc/rfc9421.html)

### Headers

```
Signature-Input: sig1=("@method" "@target-uri" "content-digest");created=1704067200;keyid="https://example.com/users/alice#main-key"
Signature: sig1=:base64-encoded-signature:
```

### Required Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `keyid` | MUST | URL of the public key |
| `created` | MUST | Unix timestamp |
| `expires` | MAY | Unix timestamp |

### Required Derived Components

| Component | Required |
|-----------|----------|
| `@method` | MUST |
| `@target-uri` | MUST |

### Content-Digest Header

For POST requests, the `Content-Digest` header MUST be present and signed:

```
Content-Digest: sha-256=:X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE=:
```

Requirements:

- MUST use RFC 8941 structured field dictionary format
- MUST include `sha-256` key
- Value MUST match computed SHA-256 hash of request body

## Time Window Validation

Both schemes enforce time-based validation:

### Constants

| Constant | Value | Description |
|----------|-------|-------------|
| Expiration Window Limit | 12 hours | Maximum signature lifetime |
| Clock Skew Margin | 1 hour | Tolerance for clock differences |
| Default Expiry | 5 minutes | If `expires` not specified |

### Validation Rules

1. **Created Time**: MUST NOT be more than 1 hour in the future
2. **Expiry Time**: Computed as `min(expires, created + 12h)`
3. **Current Time**: MUST be before `expiry + 1h`

### Time Sources

| Scheme | Primary | Fallback |
|--------|---------|----------|
| HTTP Signatures (`hs2019`) | `created` parameter | `Date` header |
| HTTP Signatures (`rsa-sha256`) | `Date` header | N/A |
| RFC 9421 | `created` parameter | N/A |

## Key ID Formats

The `keyId` (or `keyid`) parameter identifies the signing key. Supported formats:

| Format | Example |
|--------|---------|
| Fragment URI | `https://example.com/users/alice#main-key` |
| Acct URI | `acct:alice@example.com` |

Servers MUST resolve the key by:

1. Fetching the actor document from the key ID URL
2. Extracting the `publicKey` property
3. Verifying the key ID matches

## Key Resolution

When a signature cannot be verified with the cached key:

1. Server MAY refresh the actor's key (rate-limited)
2. Server MUST implement circuit breaker (5-minute cooldown after failure)
3. Server MUST NOT retry immediately on failure

## Error Responses

### 400 Bad Request

Returned for malformed headers:

```json
{
  "error": "Content-Digest could not be parsed. It does not contain a valid RFC8941 dictionary."
}
```

### 401 Unauthorized

Returned for signature verification failures:

```json
{
  "error": "Verification failed for alice https://example.com/users/alice"
}
```

Common error messages:

- `Request not signed`
- `Incompatible request signature. keyId, signature are required`
- `Unsupported signature algorithm (only rsa-sha256 and hs2019 are supported)`
- `Signed request date outside acceptable time window`
- `Mastodon requires the Date header or (created) pseudo-header to be signed`
- `Mastodon requires the Digest header to be signed when doing a POST request`
- `Invalid Digest value. Computed SHA-256 digest: {computed}; given: {received}`
- `Public key not found for key {keyId}`

### 403 Forbidden

Returned when the requesting domain is blocked:

```json
{
  "error": "Request from disallowed domain"
}
```

## Implementation Notes

### Backward Compatibility

Some older Mastodon versions incorrectly omit the query string from `(request-target)`. Servers SHOULD verify signatures both with and without the query string for compatibility.

### RSA Key Requirements

- Key type: RSA
- Minimum key size: 2048 bits (recommended: 4096)
- Signature algorithm: RSASSA-PKCS1-v1_5 with SHA-256
