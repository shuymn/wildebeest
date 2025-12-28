# Conformance

This document defines conformance terminology and compliance levels for Mastodon-compatible server implementations.

## RFC 2119 Keywords

This specification uses keywords as defined in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119):

| Keyword | Meaning |
|---------|---------|
| **MUST** | Absolute requirement. Non-compliance means the implementation is not conformant. |
| **MUST NOT** | Absolute prohibition. |
| **SHOULD** | Recommended. Valid reasons may exist to ignore, but implications must be understood. |
| **SHOULD NOT** | Not recommended. Valid reasons may exist to do otherwise. |
| **MAY** | Optional. Implementations may or may not include this feature. |

## Compliance Levels

### Level 1: Federation Core

Minimum requirements for ActivityPub federation interoperability:

- WebFinger discovery (`/.well-known/webfinger`)
- HTTP Signature verification (Draft or RFC 9421)
- ActivityPub Inbox (receive activities)
- ActivityPub Outbox (serve activities)
- Actor profile endpoints

### Level 2: Federation Extended

Additional federation features for full interoperability:

- NodeInfo discovery
- Followers/Following collections
- Featured posts collection
- Authorized fetch mode support
- Collection synchronization

### Level 3: Client API Core

Minimum REST API for basic client support:

- OAuth 2.0 authentication
- Instance information
- Account verification
- Timeline endpoints (home, public)
- Status CRUD operations
- Notifications

### Level 4: Client API Extended

Full client compatibility (Ivory, Elk, official apps):

- All Level 3 requirements
- Search functionality
- Media upload (v1 and v2)
- Markers
- Filters
- Lists
- Scheduled statuses
- Polls

### Level 5: Full Compatibility

Complete Mastodon compatibility:

- All Level 4 requirements
- Streaming API
- Admin API
- Push notifications

## Compliance Verification

Implementations SHOULD document their compliance level and any deviations from this specification.

### Required Documentation

Implementations MUST provide:

1. Declared compliance level
2. List of unsupported MUST requirements (if any)
3. List of unsupported SHOULD requirements
4. Version of this specification used

### Optional Documentation

Implementations MAY provide:

1. Implementation-specific extensions
2. Performance characteristics
3. Rate limiting policies
