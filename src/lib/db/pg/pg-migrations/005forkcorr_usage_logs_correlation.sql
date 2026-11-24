-- The outer gateway request groups independent pool executions without changing their unique ids.
-- Fork-specific version prefix cannot collide with upstream numeric PostgreSQL migrations.
ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS correlation_id TEXT;
ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS retry_index INTEGER CHECK (retry_index >= 0);
CREATE INDEX IF NOT EXISTS idx_usage_logs_correlation_created ON usage_logs (correlation_id, created_at DESC);
