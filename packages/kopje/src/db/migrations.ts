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
import m0015 from '../../migrations/0015_media_shown.sql'

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
	{ name: '0015_media_shown', sql: m0015 },
]
