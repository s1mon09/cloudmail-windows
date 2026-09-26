CREATE TABLE IF NOT EXISTS mail_sync (
  account_ref TEXT NOT NULL,
  provider TEXT NOT NULL,
  mail_id TEXT NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0,
  starred INTEGER NOT NULL DEFAULT 0,
  ai_result TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (account_ref, provider, mail_id)
);
CREATE INDEX IF NOT EXISTS idx_mail_sync_account_updated ON mail_sync(account_ref, updated_at DESC);
