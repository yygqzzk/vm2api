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

test('1.4.076 migrations preserve accounts and correlated usage across lifetime-usage and shop upgrades', (t) => {
  const f = fixture(t)
  const legacy = path.join(f.root, '1.4.076-migrations')
  fs.cpSync(source, legacy, {
    recursive: true,
    filter: (file) => fs.statSync(file).isDirectory() || Number.parseInt(path.basename(file), 10) < 55,
  })
  const db = f.open({ migrationsDir: legacy })
  db.prepare('INSERT INTO accounts (id, email, name, platform) VALUES (?, ?, ?, ?)').run(
    'account',
    'fixture@example.invalid',
    'Existing account',
    'openai',
  )
  db.prepare('INSERT INTO usage_logs (id, request_id, correlation_id, created_at) VALUES (?, ?, ?, ?)').run(
    'log',
    'outer-r1',
    'outer',
    '2026-11-16T00:00:00.000Z',
  )
  const accounts = db.prepare('SELECT * FROM accounts').all()
  assert.deepEqual(applyMigrations(db), [
    '055_account_lifetime_usage.sql',
    '056_crag_shop_orders.sql',
    '057_crag_shop_commerce.sql',
    '058_crag_shop_activation.sql',
    '059_risk_audit_bans.sql',
    '060_crag_shop_order_dispatch.sql',
  ])
  assert.deepEqual(db.prepare('SELECT * FROM accounts').all(), accounts)
  const usage = db.prepare('SELECT id, request_id, correlation_id, usage_account_id FROM usage_logs').get()
  assert.deepEqual({ ...usage }, { id: 'log', request_id: 'outer-r1', correlation_id: 'outer', usage_account_id: null })
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM crag_shop_orders').get().count, 0)
  const reopened = f.open({ migrationsDir: legacy })
  assert.deepEqual(reopened.prepare('SELECT * FROM accounts').all(), accounts)
  assert.equal(reopened.prepare('SELECT request_id FROM usage_logs').get().request_id, 'outer-r1')
})

test('1.4.115 upgrades preserve correlated history and keep the previous schema readable', (t) => {
  const f = fixture(t)
  const legacy = path.join(f.root, '1.4.115-migrations')
  fs.cpSync(source, legacy, {
    recursive: true,
    filter: (file) =>
      fs.statSync(file).isDirectory() ||
      (Number.parseInt(path.basename(file), 10) < 59 && !path.basename(file).startsWith('049_')),
  })
  const db = f.open({ migrationsDir: legacy })
  db.prepare('INSERT INTO accounts (id, email, name, platform) VALUES (?, ?, ?, ?)').run(
    'account',
    'fixture@example.invalid',
    'Existing account',
    'openai',
  )
  db.prepare('INSERT INTO usage_logs (id, request_id, correlation_id, created_at) VALUES (?, ?, ?, ?)').run(
    'log',
    'outer-r1',
    'outer',
    '2026-11-18T00:00:00.000Z',
  )
  const accounts = db.prepare('SELECT * FROM accounts').all()
  assert.deepEqual(applyMigrations(db), [
    '049_api_key_endpoint.sql',
    '059_risk_audit_bans.sql',
    '060_crag_shop_order_dispatch.sql',
  ])
  assert.deepEqual(db.prepare('SELECT * FROM accounts').all(), accounts)
  const reopened = f.open({ migrationsDir: legacy })
  assert.deepEqual(reopened.prepare('SELECT * FROM accounts').all(), accounts)
  assert.equal(reopened.prepare('SELECT correlation_id FROM usage_logs').get().correlation_id, 'outer')
  assert.ok(
    reopened
      .prepare('PRAGMA table_info(api_keys)')
      .all()
      .some((c) => c.name === 'api_endpoint_id'),
  )
  assert.ok(
    reopened
      .prepare('PRAGMA table_info(crag_shop_orders)')
      .all()
      .some((c) => c.name === 'dispatch_state'),
  )
})
