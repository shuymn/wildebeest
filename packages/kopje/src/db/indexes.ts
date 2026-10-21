// The names SQLite gives the indexes of the schema's PRIMARY KEY and UNIQUE constraints (sqlite_autoindex_<table>_<n>,
// numbered in declaration order in migrations/0000_initial.sql), for INDEXED BY: a query that names its index keeps
// its key seeks whatever the Store's statistics say (RES-7). Imports nothing, so any module may build SQL with it at
// load.

export const ACCOUNTS_ID_INDEX = 'sqlite_autoindex_accounts_1'
export const ACCOUNTS_URI_INDEX = 'sqlite_autoindex_accounts_2'
export const STATUSES_ID_INDEX = 'sqlite_autoindex_statuses_1'
// (account_id, name)
export const FEATURED_TAGS_ACCOUNT_INDEX = 'sqlite_autoindex_featured_tags_2'
export const MEDIA_ID_INDEX = 'sqlite_autoindex_media_attachments_1'
export const POLLS_STATUS_INDEX = 'sqlite_autoindex_polls_1'
// (poll_id, generation, account_id, choice)
export const POLL_VOTES_KEY_INDEX = 'sqlite_autoindex_poll_votes_1'
