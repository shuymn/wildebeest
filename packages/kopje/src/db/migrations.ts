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
import m0033 from '../../migrations/0033_quotes.sql'
import m0034 from '../../migrations/0034_admin_suspension.sql'
import m0035 from '../../migrations/0035_streaming_public.sql'
import m0036 from '../../migrations/0036_quotes_list.sql'
import m0037 from '../../migrations/0037_quote_policy.sql'
import m0038 from '../../migrations/0038_quote_requests.sql'
import m0039 from '../../migrations/0039_quotes_local.sql'
import m0040 from '../../migrations/0040_report_notifications.sql'
import m0041 from '../../migrations/0041_report_notifications_key.sql'
import m0042 from '../../migrations/0042_report_action_fence.sql'
import m0043 from '../../migrations/0043_read_window_indexes.sql'
import m0044 from '../../migrations/0044_delivery_provenance.sql'
import m0045 from '../../migrations/0045_remote_suspension.sql'
import m0046 from '../../migrations/0046_instance_domain_blocks.sql'
import m0047 from '../../migrations/0047_status_mentions_shown.sql'
import m0048 from '../../migrations/0048_stored_bounds.sql'
import m0049 from '../../migrations/0049_instance_bounds.sql'
import m0050 from '../../migrations/0050_follow_recommendation_mutes.sql'
import m0051 from '../../migrations/0051_follow_answer_pairs.sql'
import m0052 from '../../migrations/0052_favourite_likes.sql'
import m0053 from '../../migrations/0053_custom_emoji_snapshots.sql'
import m0054 from '../../migrations/0054_remote_reports.sql'
import m0055 from '../../migrations/0055_local_custom_emojis.sql'
import m0056 from '../../migrations/0056_announcements.sql'
import m0057 from '../../migrations/0057_trends.sql'
import m0058 from '../../migrations/0058_profile_credentials.sql'
import m0059 from '../../migrations/0059_contact_and_activity.sql'
import m0060 from '../../migrations/0060_account_moves.sql'
import m0061 from '../../migrations/0061_account_static_images.sql'
import m0062 from '../../migrations/0062_account_warnings.sql'
import m0063 from '../../migrations/0063_account_warning_notifications_key.sql'
import m0064 from '../../migrations/0064_status_applications.sql'
import m0065 from '../../migrations/0065_media_blurhash.sql'
import m0066 from '../../migrations/0066_field_verification.sql'
import m0067 from '../../migrations/0067_status_cards.sql'
import m0068 from '../../migrations/0068_remote_field_verification.sql'
import m0069 from '../../migrations/0069_card_embeds.sql'
import m0070 from '../../migrations/0070_card_images.sql'
import m0071 from '../../migrations/0071_link_trends.sql'
import m0072 from '../../migrations/0072_activity_tracking.sql'
import m0073 from '../../migrations/0073_actor_document_revision.sql'
import m0074 from '../../migrations/0074_last_status_lookup.sql'
import m0075 from '../../migrations/0075_boost_withdrawal.sql'
import m0076 from '../../migrations/0076_field_link_checks.sql'
import m0077 from '../../migrations/0077_remote_media.sql'
import m0078 from '../../migrations/0078_featured_tags_order.sql'
import m0079 from '../../migrations/0079_filter_text_units.sql'
import m0081 from '../../migrations/0081_account_invitations.sql'

// Store migrations in apply order. Append only: an applied file is recorded by name and checksum and must
// never change. Each file runs in its own transaction, must finish well under 30 seconds, and must be pure SQL with no
// PRAGMA and no DEFERRABLE (test/migration-lint.test.ts). foreignKeys: 'unchanged' only for a file that lint accepts;
// see Migration in src/platform/store-kernel.ts.
export const MIGRATIONS: readonly { name: string; sql: string; foreignKeys?: 'unchanged' }[] = [
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
	{ name: '0033_quotes', sql: m0033 },
	{ name: '0034_admin_suspension', sql: m0034 },
	{ name: '0035_streaming_public', sql: m0035 },
	{ name: '0036_quotes_list', sql: m0036 },
	{ name: '0037_quote_policy', sql: m0037 },
	{ name: '0038_quote_requests', sql: m0038 },
	{ name: '0039_quotes_local', sql: m0039 },
	{ name: '0040_report_notifications', sql: m0040 },
	{ name: '0041_report_notifications_key', sql: m0041 },
	{ name: '0042_report_action_fence', sql: m0042 },
	{ name: '0043_read_window_indexes', sql: m0043 },
	{ name: '0044_delivery_provenance', sql: m0044 },
	{ name: '0045_remote_suspension', sql: m0045 },
	{ name: '0046_instance_domain_blocks', sql: m0046 },
	{ name: '0047_status_mentions_shown', sql: m0047 },
	{ name: '0048_stored_bounds', sql: m0048 },
	{ name: '0049_instance_bounds', sql: m0049 },
	{ name: '0050_follow_recommendation_mutes', sql: m0050 },
	{ name: '0051_follow_answer_pairs', sql: m0051 },
	{ name: '0052_favourite_likes', sql: m0052 },
	{ name: '0053_custom_emoji_snapshots', sql: m0053 },
	{ name: '0054_remote_reports', sql: m0054 },
	{ name: '0055_local_custom_emojis', sql: m0055 },
	{ name: '0056_announcements', sql: m0056 },
	{ name: '0057_trends', sql: m0057 },
	{ name: '0058_profile_credentials', sql: m0058, foreignKeys: 'unchanged' },
	{ name: '0059_contact_and_activity', sql: m0059, foreignKeys: 'unchanged' },
	{ name: '0060_account_moves', sql: m0060, foreignKeys: 'unchanged' },
	{ name: '0061_account_static_images', sql: m0061, foreignKeys: 'unchanged' },
	{ name: '0062_account_warnings', sql: m0062 },
	{ name: '0063_account_warning_notifications_key', sql: m0063 },
	{ name: '0064_status_applications', sql: m0064, foreignKeys: 'unchanged' },
	{ name: '0065_media_blurhash', sql: m0065, foreignKeys: 'unchanged' },
	{ name: '0066_field_verification', sql: m0066, foreignKeys: 'unchanged' },
	{ name: '0067_status_cards', sql: m0067 },
	{ name: '0068_remote_field_verification', sql: m0068 },
	{ name: '0069_card_embeds', sql: m0069 },
	{ name: '0070_card_images', sql: m0070 },
	{ name: '0071_link_trends', sql: m0071 },
	{ name: '0072_activity_tracking', sql: m0072 },
	{ name: '0073_actor_document_revision', sql: m0073, foreignKeys: 'unchanged' },
	{ name: '0074_last_status_lookup', sql: m0074, foreignKeys: 'unchanged' },
	{ name: '0075_boost_withdrawal', sql: m0075 },
	{ name: '0076_field_link_checks', sql: m0076, foreignKeys: 'unchanged' },
	{ name: '0077_remote_media', sql: m0077 },
	{ name: '0078_featured_tags_order', sql: m0078, foreignKeys: 'unchanged' },
	{ name: '0079_filter_text_units', sql: m0079, foreignKeys: 'unchanged' },
	{ name: '0081_account_invitations', sql: m0081 },
]
