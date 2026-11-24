-- The version prefix is fork-specific and cannot collide with upstream's numeric migration versions.
CREATE TABLE IF NOT EXISTS fork_test_reports (
  id BIGSERIAL PRIMARY KEY,
  vm_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('scheduled', 'manual')),
  model TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('pass', 'pending', 'fail')),
  started_at TEXT NOT NULL,
  record_json TEXT NOT NULL CHECK (record_json::jsonb IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS fork_test_reports_vm_recent ON fork_test_reports (vm_id, started_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS fork_test_reports_recent ON fork_test_reports (started_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS fork_test_reports_verdict_recent ON fork_test_reports (verdict, started_at DESC, id DESC);
