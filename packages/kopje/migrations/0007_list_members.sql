-- Kopje Store schema 0007: list members are accounts their list's owner follows. Never edit after release (checksummed).
--
-- A list holds its owner and accounts the owner follows or has asked to follow, as Mastodon's ListAccount does (its
-- follow or follow request; a member's statuses reach the list once the follow is accepted). Mastodon deletes the
-- membership with the follow (list_accounts.follow_id and follow_request_id, ON DELETE CASCADE); here the trigger
-- list_members_follow_ended does it: whatever ends a follow (an unfollow, a block either way, a domain block's cleanup,
-- a Reject, a Move, a purge), the followed account leaves the follower's lists in the same statement. A request
-- accepted later keeps its row: the member is then active (the read rule reads the follow's state).
--
-- Converters before this release carried every legacy member, followed or not. Such a row, whose owner neither follows
-- nor has asked to follow the member, goes here, so it can never come back with a later follow (Mastodon would have
-- deleted it with the follow). Each row is checked once, through the lists primary key and the (account_id,
-- target_account_id) index of follows.

DELETE FROM list_accounts WHERE NOT EXISTS (SELECT 1 FROM lists l WHERE l.id = list_accounts.list_id
  AND (l.account_id = list_accounts.account_id OR EXISTS (SELECT 1 FROM follows f
    WHERE f.account_id = l.account_id AND f.target_account_id = list_accounts.account_id)));

-- Reads the owner's lists (lists_account) and seeks each list's row of the account: as many rows as the owner has
-- lists, however many lists hold the account.
CREATE TRIGGER list_members_follow_ended AFTER DELETE ON follows
BEGIN
  DELETE FROM list_accounts WHERE account_id = OLD.target_account_id
    AND list_id IN (SELECT id FROM lists WHERE account_id = OLD.account_id);
END;
