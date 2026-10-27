// The names SQLite gives the indexes of the schema's PRIMARY KEY and UNIQUE constraints (sqlite_autoindex_<table>_<n>,
// numbered in declaration order in migrations/0000_initial.sql), for INDEXED BY: a query that names its index keeps
// its key seeks whatever the Store's statistics say (RES-7). Imports nothing, so any module may build SQL with it at
// load.

export const ACCOUNTS_ID_INDEX = 'sqlite_autoindex_accounts_1'
export const ACCOUNTS_URI_INDEX = 'sqlite_autoindex_accounts_2'
export const LOCAL_ACCOUNTS_ID_INDEX = 'sqlite_autoindex_local_accounts_1'
export const OAUTH_CLIENTS_ID_INDEX = 'sqlite_autoindex_oauth_clients_1'
export const STATUSES_ID_INDEX = 'sqlite_autoindex_statuses_1'
export const STATUSES_URI_INDEX = 'sqlite_autoindex_statuses_2'
export const FEATURED_TAGS_ID_INDEX = 'sqlite_autoindex_featured_tags_1'
// (account_id, name)
export const FEATURED_TAGS_ACCOUNT_INDEX = 'sqlite_autoindex_featured_tags_2'
export const FILTER_STATUSES_ID_INDEX = 'sqlite_autoindex_filter_statuses_1'
export const MEDIA_ID_INDEX = 'sqlite_autoindex_media_attachments_1'
export const QUOTES_STATUS_INDEX = 'sqlite_autoindex_quotes_1'
export const POLLS_STATUS_INDEX = 'sqlite_autoindex_polls_1'
// (poll_id, generation, account_id, choice)
export const POLL_VOTES_KEY_INDEX = 'sqlite_autoindex_poll_votes_1'
// instance_domain_blocks (domain), migration 0046_instance_domain_blocks.
export const INSTANCE_DOMAIN_BLOCKS_DOMAIN_INDEX = 'sqlite_autoindex_instance_domain_blocks_1'
