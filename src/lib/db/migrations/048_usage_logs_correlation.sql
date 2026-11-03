-- The outer gateway request groups independent pool executions without changing their unique ids.
ALTER TABLE usage_logs ADD COLUMN correlation_id TEXT;
ALTER TABLE usage_logs ADD COLUMN retry_index INTEGER CHECK(retry_index >= 0);
CREATE INDEX idx_usage_logs_correlation_created ON usage_logs(correlation_id, created_at DESC);
