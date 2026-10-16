import m0000 from '../../migrations/0000_initial.sql'
import m0001 from '../../migrations/0001_blocks_and_mutes.sql'
import m0002 from '../../migrations/0002_web_push.sql'
import m0003 from '../../migrations/0003_domain_block_form.sql'
import m0004 from '../../migrations/0004_status_tags_public.sql'
import m0005 from '../../migrations/0005_hide_collections.sql'
import m0006 from '../../migrations/0006_account_deletion.sql'
import m0007 from '../../migrations/0007_list_members.sql'
import m0008 from '../../migrations/0008_status_mentions_requires_mention.sql'
import m0009 from '../../migrations/0009_conversations.sql'
import m0010 from '../../migrations/0010_markers.sql'
import m0011 from '../../migrations/0011_scheduled_statuses.sql'
import m0012 from '../../migrations/0012_filters.sql'
import m0013 from '../../migrations/0013_polls.sql'
import m0014 from '../../migrations/0014_account_notes_and_pins.sql'
import m0015 from '../../migrations/0015_media_shown.sql'
import m0016 from '../../migrations/0016_tags.sql'
import m0017 from '../../migrations/0017_notification_groups.sql'
import m0018 from '../../migrations/0018_status_pins_and_conversation_mutes.sql'
import m0019 from '../../migrations/0019_tag_normalization.sql'
import m0020 from '../../migrations/0020_notification_policies.sql'
import m0021 from '../../migrations/0021_directory.sql'
import m0022 from '../../migrations/0022_reports.sql'
import m0023 from '../../migrations/0023_notification_clears.sql'
import m0024 from '../../migrations/0024_attribution_domains.sql'
import m0025 from '../../migrations/0025_remote_collections.sql'
import m0026 from '../../migrations/0026_streaming.sql'
import m0028 from '../../migrations/0028_streaming_home.sql'
import m0029 from '../../migrations/0029_admin_reports.sql'
import m0030 from '../../migrations/0030_admin_accounts.sql'
import m0031 from '../../migrations/0031_admin_accounts_available.sql'
import m0032 from '../../migrations/0032_streaming_lists.sql'

// Store migrations in apply order. Append only: an applied file is recorded by name and checksum and must
// never change. Each file runs in its own transaction, must finish well under 30 seconds, and must be pure SQL.
export const MIGRATIONS: readonly { name: string; sql: string }[] = [
	{ name: '0000_initial', sql: m0000 },
	{ name: '0001_blocks_and_mutes', sql: m0001 },
	{ name: '0002_web_push', sql: m0002 },
	{ name: '0003_domain_block_form', sql: m0003 },
	{ name: '0004_status_tags_public', sql: m0004 },
	{ name: '0005_hide_collections', sql: m0005 },
	{ name: '0006_account_deletion', sql: m0006 },
	{ name: '0007_list_members', sql: m0007 },
	{ name: '0008_status_mentions_requires_mention', sql: m0008 },
	{ name: '0009_conversations', sql: m0009 },
	{ name: '0010_markers', sql: m0010 },
	{ name: '0011_scheduled_statuses', sql: m0011 },
	{ name: '0012_filters', sql: m0012 },
	{ name: '0013_polls', sql: m0013 },
	{ name: '0014_account_notes_and_pins', sql: m0014 },
	{ name: '0015_media_shown', sql: m0015 },
	{ name: '0016_tags', sql: m0016 },
	{ name: '0017_notification_groups', sql: m0017 },
	{ name: '0018_status_pins_and_conversation_mutes', sql: m0018 },
	{ name: '0019_tag_normalization', sql: m0019 },
	{ name: '0020_notification_policies', sql: m0020 },
	{ name: '0021_directory', sql: m0021 },
	{ name: '0022_reports', sql: m0022 },
	{ name: '0023_notification_clears', sql: m0023 },
	{ name: '0024_attribution_domains', sql: m0024 },
	{ name: '0025_remote_collections', sql: m0025 },
	{ name: '0026_streaming', sql: m0026 },
	{ name: '0028_streaming_home', sql: m0028 },
	{ name: '0029_admin_reports', sql: m0029 },
	{ name: '0030_admin_accounts', sql: m0030 },
	{ name: '0031_admin_accounts_available', sql: m0031 },
	{ name: '0032_streaming_lists', sql: m0032 },
]
