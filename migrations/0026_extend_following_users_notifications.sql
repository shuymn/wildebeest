-- Phase 1.3: Add columns to actor_following
ALTER TABLE actor_following ADD COLUMN "show_reblogs" INTEGER DEFAULT 1;
ALTER TABLE actor_following ADD COLUMN "notify" INTEGER DEFAULT 0;
ALTER TABLE actor_following ADD COLUMN "languages" TEXT;
ALTER TABLE actor_following ADD COLUMN "uri" TEXT;
ALTER TABLE actor_following ADD COLUMN "updated_at" DATETIME;

-- Phase 1.4: Add columns to users
ALTER TABLE users ADD COLUMN "is_moderator" INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN "approved" INTEGER DEFAULT 1;
ALTER TABLE users ADD COLUMN "disabled" INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN "confirmed_at" DATETIME;
ALTER TABLE users ADD COLUMN "locale" TEXT;
ALTER TABLE users ADD COLUMN "updated_at" DATETIME;

-- Phase 1.5: Add columns to actor_notifications
ALTER TABLE actor_notifications ADD COLUMN "group_key" TEXT;
ALTER TABLE actor_notifications ADD COLUMN "read" INTEGER DEFAULT 0;
ALTER TABLE actor_notifications ADD COLUMN "filtered" INTEGER DEFAULT 0;
ALTER TABLE actor_notifications ADD COLUMN "report_id" TEXT;
ALTER TABLE actor_notifications ADD COLUMN "account_warning_id" INTEGER;
