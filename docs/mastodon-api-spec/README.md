# Mastodon-Compatible API Specification

This specification defines the requirements for implementing a Mastodon-compatible server. It targets ActivityPub federation interoperability and broad client compatibility.

## Scope

This specification covers:

- **Federation Protocol** - ActivityPub, HTTP Signatures, WebFinger
- **Discovery Endpoints** - Server metadata and account lookup
- **Client REST API** - Authentication, timelines, statuses, accounts
- **Streaming API** - Real-time event delivery
- **Admin API** - Server administration (appendix)

## Baseline Version

This specification targets **Mastodon v4.5.x** (latest stable release line). Features introduced in newer versions are marked as optional extensions.

## Client Compatibility

The Client API section prioritizes compatibility with:

- Official Mastodon apps (iOS, Android, Web)
- Ivory
- Elk
- Other popular third-party clients

## Document Structure

| Section | Description |
|---------|-------------|
| [Conformance](conformance.md) | MUST/SHOULD/MAY terminology and compliance levels |
| [Versioning](versioning.md) | Version baseline and extension markers |
| [Federation](federation/) | ActivityPub protocol and HTTP signatures |
| [Discovery](discovery/) | WebFinger, NodeInfo, OAuth metadata |
| [Client API](client-api/) | REST API for client applications |
| [Streaming](streaming/) | WebSocket real-time events |
| [Admin API](admin-api/) | Administrative endpoints (appendix) |
| [OpenAPI](openapi/) | Supplemental OpenAPI 3.1 schema |

## Normative vs Informative

- **Normative sections** use RFC 2119 keywords (MUST, SHOULD, MAY)
- **Informative sections** provide context and examples
- The Markdown documents are the **primary source of truth**
- The OpenAPI document is **supplemental** and non-normative

## Contributing

When updating this specification:

1. Update the relevant Markdown document first
2. Update the OpenAPI schema to match if applicable
3. Mark new features with version annotations
