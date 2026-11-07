import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyMigrations, createDatabase } from '../../src/lib/db/database.mjs'

const source = fileURLToPath(new URL('../../src/lib/db/migrations/', import.meta.url))
const riskMigration = '048apirisk_api_endpoint_risk_review.sql'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-migration-'))
  const databases = []
  t.after(() => {
    for (const db of databases) db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  return {
    root,
    open(options = {}) {
      const db = createDatabase({ dbPath: path.join(root, 'kin.db'), ...options })
      databases.push(db)
      return db
    },
  }
}

test('fresh fork databases apply correlation and API review under distinct migration identities', (t) => {
  const files = fs.readdirSync(source).filter((file) => /^\d+.*\.sql$/.test(file))
  const versions = files.map((file) => file.split('_')[0])
  assert.equal(new Set(versions).size, files.length, 'migration identity is the prefix, not the full filename')
  const db = fixture(t).open()
  assert.equal(
    db.prepare("SELECT name FROM schema_migrations WHERE version = '048'").get().name,
    '048_usage_logs_correlation.sql',
  )
  assert.equal(db.prepare("SELECT name FROM schema_migrations WHERE version = '048apirisk'").get().name, riskMigration)
  db.prepare('INSERT INTO api_endpoints (id, name, base_url) VALUES (?, ?, ?)').run(
    'endpoint',
    'Example',
    'https://example.invalid',
  )
  assert.equal(db.prepare('SELECT risk_review_enabled FROM api_endpoints').get().risk_review_enabled, 0)
  assert.ok(
    db
      .prepare('PRAGMA table_info(usage_logs)')
      .all()
      .some((column) => column.name === 'correlation_id'),
  )
  assert.deepEqual(applyMigrations(db), [])
})

test('1.4.038 upgrades preserve applied 048, endpoint defaults and correlated history; old migrations still reopen', (t) => {
  const f = fixture(t)
  const legacy = path.join(f.root, 'legacy-migrations')
  fs.cpSync(source, legacy, { recursive: true, filter: (file) => !file.endsWith(riskMigration) })
  const db = f.open({ migrationsDir: legacy })
  const applied048 = db.prepare("SELECT * FROM schema_migrations WHERE version = '048'").get()
  db.prepare('INSERT INTO api_endpoints (id, name, base_url) VALUES (?, ?, ?)').run(
    'endpoint',
    'Example',
    'https://example.invalid',
  )
  db.prepare(
    'INSERT INTO usage_logs (id, request_id, created_at, correlation_id, retry_index) VALUES (?, ?, ?, ?, ?)',
  ).run('log', 'outer-r1', '2026-11-07T00:00:00.000Z', 'outer', 1)
  const history = db.prepare('SELECT * FROM usage_logs').all()
  assert.deepEqual(applyMigrations(db), [riskMigration])
  assert.deepEqual(db.prepare("SELECT * FROM schema_migrations WHERE version = '048'").get(), applied048)
  assert.deepEqual(db.prepare('SELECT * FROM usage_logs').all(), history)
  assert.equal(db.prepare('SELECT risk_review_enabled FROM api_endpoints').get().risk_review_enabled, 0)
  db.prepare('UPDATE api_endpoints SET risk_review_enabled = 1').run()
  assert.deepEqual(applyMigrations(db), [])
  const reopened = f.open({ migrationsDir: legacy })
  assert.equal(reopened.prepare('SELECT risk_review_enabled FROM api_endpoints').get().risk_review_enabled, 1)
  assert.deepEqual(reopened.prepare('SELECT * FROM usage_logs').all(), history)
})
