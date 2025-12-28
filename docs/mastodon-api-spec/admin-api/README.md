# Admin API Appendix

This appendix documents the Mastodon Admin API. This API is intended for administrative tools and server management, not for basic client functionality.

> **Note**: The Admin API is less stable than the client API. Implementations MAY support only a subset of these endpoints. This API is not required for federation or basic client compatibility.

## Authentication

Admin endpoints require OAuth tokens with admin-level scopes.

### Admin Scopes

| Scope | Description |
|-------|-------------|
| `admin:read` | Read-only access to all admin resources |
| `admin:write` | Full read/write access to all admin resources |

### Granular Scopes

For fine-grained access control, the following granular scopes are available:

**Read Scopes:**
- `admin:read:accounts` - View account details and list accounts
- `admin:read:reports` - View reports
- `admin:read:domain_allows` - View allowed domains
- `admin:read:domain_blocks` - View blocked domains
- `admin:read:ip_blocks` - View IP blocks
- `admin:read:email_domain_blocks` - View email domain blocks
- `admin:read:canonical_email_blocks` - View canonical email blocks

**Write Scopes:**
- `admin:write:accounts` - Perform account moderation actions
- `admin:write:reports` - Resolve/update reports
- `admin:write:domain_allows` - Manage allowed domains
- `admin:write:domain_blocks` - Manage blocked domains
- `admin:write:ip_blocks` - Manage IP blocks
- `admin:write:email_domain_blocks` - Manage email domain blocks
- `admin:write:canonical_email_blocks` - Manage canonical email blocks

## Key Endpoints Overview

### Account Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/admin/accounts` | List accounts with filters (local, remote, pending, suspended, etc.) |
| GET | `/api/v1/admin/accounts/:id` | Get account details |
| POST | `/api/v1/admin/accounts/:id/action` | Perform moderation action (disable, silence, suspend, none) |
| POST | `/api/v1/admin/accounts/:id/approve` | Approve pending account |
| POST | `/api/v1/admin/accounts/:id/reject` | Reject pending account |
| POST | `/api/v1/admin/accounts/:id/enable` | Re-enable disabled account |
| POST | `/api/v1/admin/accounts/:id/unsilence` | Remove silence from account |
| POST | `/api/v1/admin/accounts/:id/unsuspend` | Unsuspend account |
| POST | `/api/v1/admin/accounts/:id/unsensitive` | Remove sensitive flag |
| DELETE | `/api/v1/admin/accounts/:id` | Delete account (queues background job) |

**Account Filter Parameters:**
- `local` / `remote` - Filter by origin
- `by_domain` - Filter by domain
- `active` / `pending` / `disabled` / `silenced` / `suspended` - Filter by status
- `username`, `display_name`, `email`, `ip` - Search filters
- `staff` - Show only staff accounts
- `sensitized` - Show sensitized accounts

### Reports

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/admin/reports` | List reports |
| GET | `/api/v1/admin/reports/:id` | Get report details |
| PUT | `/api/v1/admin/reports/:id` | Update report (category, rule_ids) |
| POST | `/api/v1/admin/reports/:id/assign_to_self` | Assign report to current moderator |
| POST | `/api/v1/admin/reports/:id/unassign` | Unassign report |
| POST | `/api/v1/admin/reports/:id/resolve` | Mark report as resolved |
| POST | `/api/v1/admin/reports/:id/reopen` | Reopen resolved report |

**Report Filter Parameters:**
- `resolved` - Filter by resolution status
- `account_id` - Filter by reporter
- `target_account_id` - Filter by reported account

### Domain Management

**Domain Blocks** (federation restrictions):

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/admin/domain_blocks` | List blocked domains |
| GET | `/api/v1/admin/domain_blocks/:id` | Get domain block details |
| POST | `/api/v1/admin/domain_blocks` | Block a domain |
| PUT | `/api/v1/admin/domain_blocks/:id` | Update domain block |
| DELETE | `/api/v1/admin/domain_blocks/:id` | Remove domain block |

Domain block parameters: `domain`, `severity` (silence/suspend/noop), `reject_media`, `reject_reports`, `private_comment`, `public_comment`, `obfuscate`

**Domain Allows** (for limited federation mode):

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/admin/domain_allows` | List allowed domains |
| GET | `/api/v1/admin/domain_allows/:id` | Get domain allow details |
| POST | `/api/v1/admin/domain_allows` | Allow a domain |
| DELETE | `/api/v1/admin/domain_allows/:id` | Remove domain from allowlist |

### IP Blocks

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/admin/ip_blocks` | List IP blocks |
| GET | `/api/v1/admin/ip_blocks/:id` | Get IP block details |
| POST | `/api/v1/admin/ip_blocks` | Create IP block |
| PUT | `/api/v1/admin/ip_blocks/:id` | Update IP block |
| DELETE | `/api/v1/admin/ip_blocks/:id` | Remove IP block |

Parameters: `ip`, `severity`, `comment`, `expires_in`

### Email Domain Blocks

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/admin/email_domain_blocks` | List email domain blocks |
| GET | `/api/v1/admin/email_domain_blocks/:id` | Get email domain block details |
| POST | `/api/v1/admin/email_domain_blocks` | Block email domain |
| DELETE | `/api/v1/admin/email_domain_blocks/:id` | Remove email domain block |

Parameters: `domain`, `allow_with_approval`

### Canonical Email Blocks

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/admin/canonical_email_blocks` | List canonical email blocks |
| GET | `/api/v1/admin/canonical_email_blocks/:id` | Get block details |
| POST | `/api/v1/admin/canonical_email_blocks/test` | Test if email would be blocked |
| POST | `/api/v1/admin/canonical_email_blocks` | Create block |
| DELETE | `/api/v1/admin/canonical_email_blocks/:id` | Remove block |

### Tags

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/admin/tags` | List tags |
| GET | `/api/v1/admin/tags/:id` | Get tag details |
| PUT | `/api/v1/admin/tags/:id` | Update tag settings |

Tag settings: `display_name`, `listable`, `trendable`, `usable`

### Trends Management

**Trending Statuses:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/admin/trends/statuses` | List trending statuses (includes pending review) |
| POST | `/api/v1/admin/trends/statuses/:id/approve` | Approve status for trending |
| POST | `/api/v1/admin/trends/statuses/:id/reject` | Reject status from trending |

**Trending Links:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/admin/trends/links` | List trending links |
| POST | `/api/v1/admin/trends/links/:id/approve` | Approve link for trending |
| POST | `/api/v1/admin/trends/links/:id/reject` | Reject link from trending |

**Trending Tags:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/admin/trends/tags` | List trending tags |
| POST | `/api/v1/admin/trends/tags/:id/approve` | Approve tag for trending |
| POST | `/api/v1/admin/trends/tags/:id/reject` | Reject tag from trending |

### Analytics/Metrics

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/admin/dimensions` | Get analytics dimensions |
| POST | `/api/v1/admin/measures` | Get analytics measures |
| POST | `/api/v1/admin/retention` | Get user retention cohort data |

These endpoints accept `start_at`, `end_at`, and `keys` parameters to specify the metrics and time range.

## Common Patterns

### Pagination

Admin API endpoints use the same pagination pattern as the regular API:
- Pagination via `Link` HTTP headers
- Parameters: `max_id`, `since_id`, `min_id`, `limit`
- Default limit is typically 100, maximum varies by endpoint (up to 500 for some)

### Error Responses

Error responses follow the standard format:

```json
{
  "error": "Error message describing the issue"
}
```

For validation errors:

```json
{
  "error": "Validation failed: Field error description"
}
```

### Background Jobs

Many moderation actions queue background jobs for processing:
- Account suspension/unsuspension
- Domain blocking/unblocking
- Account deletion

The API returns immediately; actions complete asynchronously.

### Action Logging

All moderation actions are logged to the audit log with:
- The action performed
- The target of the action
- The account that performed the action
- Timestamp

## Implementation Notes

- The Admin API requires appropriate user roles/permissions beyond just the OAuth scope
- Some endpoints require the target account to be local (approve, reject, enable)
- Domain blocks may conflict with existing blocks; check for 422 responses
- Account deletion is permanent and queues a background job
- Unsuspension of accounts also triggers a background job to restore data

## Reference

For implementation details, see:
- [`app/controllers/api/v1/admin/`](https://github.com/mastodon/mastodon/tree/main/app/controllers/api/v1/admin) - Controller implementations
- [`app/serializers/rest/admin/`](https://github.com/mastodon/mastodon/tree/main/app/serializers/rest/admin) - Response serializers
- [`app/policies/`](https://github.com/mastodon/mastodon/tree/main/app/policies) - Authorization policies
