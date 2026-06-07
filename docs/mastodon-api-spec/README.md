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

This specification targets **Mastodon v4.5.11** (pinned reference release). Features introduced in newer versions are marked as optional extensions.

Implementation references link to [`mastodon/mastodon@v4.5.11`](https://github.com/mastodon/mastodon/tree/v4.5.11).

Official API documentation source: [`mastodon/documentation@960eeb05`](https://github.com/mastodon/documentation/commit/960eeb05f61209f2f7e8e97456239a3a8e143c6f) ([docs.joinmastodon.org](https://docs.joinmastodon.org/)).

Local reference clones (developer machine):

| Repository | Path | Pin |
|------------|------|-----|
| Mastodon server | `/Users/shuymn/ghq/github.com/mastodon/mastodon` | `v4.5.11` |
| Mastodon docs | `.../mastodon/documentation` | `960eeb05` |

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
