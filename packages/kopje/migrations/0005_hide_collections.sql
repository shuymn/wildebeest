-- Kopje Store schema 0005: hiding an account's network. Never edit after release (checksummed).
--
-- local_accounts.hide_collections is Mastodon's Account#hide_collections, set through update_credentials: when 1, the
-- account's followers and following are listed to nobody but the account itself (the API lists and the ActivityPub
-- collections, which then show their size only). Existing accounts keep showing them.

ALTER TABLE local_accounts ADD COLUMN hide_collections INTEGER NOT NULL DEFAULT 0 CHECK (hide_collections IN (0, 1));
