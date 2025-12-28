# Versioning

This document defines the version baseline and extension marking conventions for this specification.

## Baseline Version

This specification targets **Mastodon v4.5.x** as the baseline. All MUST and SHOULD requirements are based on this version unless otherwise noted.

## Version Annotations

Features or behaviors specific to certain versions are marked with annotations:

| Annotation | Meaning |
|------------|---------|
| `[v4.0+]` | Available since Mastodon 4.0 |
| `[v4.2+]` | Available since Mastodon 4.2 |
| `[v4.5+]` | Available since Mastodon 4.5 (baseline) |
| `[EXTENSION]` | Optional extension, not in baseline |
| `[DEPRECATED]` | Deprecated, may be removed |
| `[REMOVED:v4.x]` | Removed in specified version |

## Extension Policy

### Adding New Features

New features introduced after v4.5.x:

1. MUST be marked with `[EXTENSION]` or version annotation
2. MUST NOT be required for baseline compliance
3. SHOULD be documented with upgrade path

### Deprecation Process

Deprecated features:

1. MUST be marked with `[DEPRECATED]`
2. SHOULD include removal timeline
3. MUST continue to work until marked `[REMOVED]`

## API Versioning

### REST API

The Mastodon REST API uses path-based versioning:

- `/api/v1/*` - Original API (stable)
- `/api/v2/*` - Updated endpoints with breaking changes

Both versions are active. Clients SHOULD prefer v2 endpoints when available.

### Breaking Changes

Breaking changes in the REST API:

- Introduce a new version path (e.g., `/api/v2/endpoint`)
- The previous version remains available
- Clients can migrate at their own pace

### ActivityPub

ActivityPub objects use `@context` for versioning:

- Standard ActivityPub context: `https://www.w3.org/ns/activitystreams`
- Mastodon extensions: `https://joinmastodon.org/ns`
- Security context: `https://w3id.org/security/v1`

## Specification Updates

This specification follows semantic versioning:

- **Major**: Breaking changes to MUST requirements
- **Minor**: New features, SHOULD changes
- **Patch**: Clarifications, typo fixes

Current specification version: **1.0.0**
