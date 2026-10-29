-- The version prefix is fork-specific and cannot collide with upstream's numeric migration versions.
CREATE TABLE fork_test_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vm_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('scheduled', 'manual')),
  model TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('pass', 'pending', 'fail')),
  started_at TEXT NOT NULL,
  record_json TEXT NOT NULL CHECK (json_valid(record_json))
);
CREATE INDEX fork_test_reports_vm_recent ON fork_test_reports (vm_id, started_at DESC, id DESC);
CREATE INDEX fork_test_reports_recent ON fork_test_reports (started_at DESC, id DESC);
CREATE INDEX fork_test_reports_verdict_recent ON fork_test_reports (verdict, started_at DESC, id DESC);
