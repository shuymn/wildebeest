-- Kopje Store schema 0024: attribution domains. Never edit after release (checksummed).
--
-- local_accounts.attribution_domains is Mastodon's Account#attribution_domains, set through update_credentials
-- (attribution_domains[]): the websites allowed to credit the account as the author of their articles, as a JSON
-- array of domain names, at most 100. The credential account shows it in `source`, and the actor document publishes
-- it as `attributionDomains` when it is not empty. Existing accounts start with none.
--
-- Adding a column with a constant default reads no row, so its work does not grow with the Store.

ALTER TABLE local_accounts ADD COLUMN attribution_domains TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(attribution_domains) AND json_type(attribution_domains) = 'array');
