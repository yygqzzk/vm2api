import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RequestLogStore, logsToCsv, logsToJsonl } from '../../src/lib/admin/request-log.mjs'
import { requestCorrelation } from '../../src/lib/fork/request-correlation.mjs'
import { UsageLogsView } from '../../src/lib/db/repos/usage-logs-view.mjs'
import { applyMigrations, createDatabase, openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { usageRead } from '../../src/lib/db/sqlite-pool.mjs'
import { flushWrites, pendingWrites } from '../../src/lib/db/write-behind.mjs'
import { RequestAttemptsRepo } from '../../src/lib/db/repos/request-attempts-repo.mjs'
import { fileURLToPath } from 'node:url'

test('normal and debug logs keep outer identity separate from unique pool execution ids', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-correlation-'))
  const store = new RequestLogStore({ dataDir: root, mode: 'debug' })
  t.after(() => {
    store.db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  for (const [execution, index, userId, status] of [
    ['outer', '0', 'alice', 200],
    ['outer-r1', '1', 'alice', 401],
    ['other-tenant', '2', 'bob', 200],
  ]) {
    const ctx = store.start({
      headers: { 'x-request-id': execution, 'x-oneapi-request-id': 'outer', 'x-oneapi-retry-index': index },
    })
    store.finish(ctx, { user_id: userId, status, error_code: status === 401 ? 'invalid_api_key' : null })
    assert.equal(store.getDebug(execution).correlation_id, 'outer')
    assert.equal(store.getDebug(execution).retry_index, Number(index))
  }
  const view = new UsageLogsView(store.db)
  const filters = { correlation_id: 'outer', owner_user_id: 'alice' }
  const rows = view.listBatch(filters).logs
  assert.equal(rows.length, 2, 'exact lookup includes normally muted auth errors, not other tenants')
  assert.deepEqual(new Set(rows.map((row) => row.requestId)), new Set(['outer', 'outer-r1']))
  assert.ok(rows.every((row) => row.correlationId === 'outer'))
  assert.equal(view.summary(filters).totalRequests, 2)
  assert.equal(view.exportRows(filters).total, 2)
  assert.equal(view.listBatch({ ...filters, request_id: 'outer-r1' }).logs[0].retryIndex, 1)
  assert.equal(view.listBatch({ ...filters, request_id: 'outer%' }).logs.length, 0)
  assert.equal(view.listBatch({ ...filters, status_code: 200 }).logs.length, 1)
  assert.equal(store.queryNormal({ ...filters, request_id: 'outer-r1' }).total, 1)
  const exported = view.exportRows(filters).items
  assert.equal(JSON.parse(logsToJsonl(exported).split('\n')[0]).correlation_id, 'outer')
  assert.match(logsToCsv(exported), /request_id,correlation_id,retry_index/)
})

test('migration preserves existing execution ids and leaves historical correlation unknown', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-correlation-upgrade-'))
  const source = fileURLToPath(new URL('../../src/lib/db/migrations/', import.meta.url))
  const migrationsDir = path.join(root, 'migrations')
  fs.cpSync(source, migrationsDir, {
    recursive: true,
    filter: (file) => !file.endsWith('048_usage_logs_correlation.sql'),
  })
  const db = createDatabase({ dbPath: path.join(root, 'logs.db'), migrationsDir })
  t.after(() => {
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  db.prepare('INSERT INTO usage_logs (id, request_id, created_at) VALUES (?, ?, ?)').run(
    'log_old',
    'caller-r1',
    new Date().toISOString(),
  )
  fs.copyFileSync(
    path.join(source, '048_usage_logs_correlation.sql'),
    path.join(migrationsDir, '048_usage_logs_correlation.sql'),
  )
  applyMigrations(db, { migrationsDir })
  const row = db.prepare('SELECT request_id, correlation_id, retry_index FROM usage_logs').get()
  assert.equal(row.request_id, 'caller-r1')
  assert.equal(row.correlation_id, null)
  assert.equal(row.retry_index, null)
  assert.throws(
    () =>
      db
        .prepare('INSERT INTO usage_logs (id, request_id, created_at) VALUES (?, ?, ?)')
        .run('log_duplicate', 'caller-r1', new Date().toISOString()),
    /UNIQUE/,
  )
  assert.equal(new UsageLogsView(db).listBatch({ request_id: 'caller-r1' }).logs.length, 1)
})

test('pooled writes preserve correlation, attempts and tenant scope through worker reads and close', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-correlated-pool-'))
  const dbPath = path.join(root, 'logs.db')
  const db = openDatabase({ dbPath, pooled: true })
  t.after(() => {
    closeDatabase()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const store = new RequestLogStore({ db, dataDir: root, mode: 'debug' })
  const attempts = new RequestAttemptsRepo(db)
  for (const [execution, userId, retryIndex] of [
    ['pooled-root', 'alice', 0],
    ['pooled-root-r1', 'bob', 1],
  ]) {
    const ctx = store.start({
      headers: {
        'x-request-id': execution,
        'x-oneapi-request-id': 'pooled-root',
        'x-oneapi-retry-index': String(retryIndex),
      },
    })
    attempts.begin({ requestId: execution, attemptNo: 1, model: 'test' })
    attempts.complete(execution, 1, { upstreamStatus: 401, terminalState: 'rejected' })
    store.finish(ctx, { status: 401, error_code: 'invalid_api_key', user_id: userId, attempt_count: 1 })
  }
  assert.ok(pendingWrites() > 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM usage_logs').get().n, 0)
  flushWrites()
  const filters = { correlation_id: 'pooled-root', owner_user_id: 'alice' }
  const listed = await usageRead({ kind: 'view', method: 'listBatch', args: [filters], mutedErrorClasses: ['auth'] })
  assert.equal(listed.logs.length, 1)
  assert.equal(listed.logs[0].requestId, 'pooled-root')
  assert.equal(listed.logs[0].retryIndex, 0)
  assert.equal(listed.logs[0].providerChain[0].upstreamStatus, 401)
  const summary = await usageRead({ kind: 'view', method: 'summary', args: [filters] })
  const exported = await usageRead({ kind: 'view', method: 'exportRows', args: [filters] })
  assert.equal(summary.totalRequests, 1)
  assert.equal(exported.items[0].correlation_id, 'pooled-root')
  assert.equal(exported.total, 1)
  assert.equal(store.getDebug('pooled-root', { owner_user_id: 'alice' }).retry_index, 0)
  const last = store.start({ headers: { 'x-request-id': 'on-close', 'x-oneapi-request-id': 'pooled-root' } })
  store.finish(last, { status: 200, user_id: 'alice' })
  closeDatabase()
  assert.equal(pendingWrites(), 0)
  const reopened = createDatabase({ dbPath })
  try {
    assert.equal(
      new UsageLogsView(reopened).listBatch({ request_id: 'on-close', owner_user_id: 'alice' }).logs.length,
      1,
    )
  } finally {
    reopened.close()
  }
})

test('correlation metadata is bounded and never inferred by stripping an execution suffix', () => {
  assert.deepEqual(requestCorrelation({ headers: { 'x-request-id': 'arbitrary-r1' } }), {
    correlation_id: null,
    retry_index: null,
  })
  for (const id of ['x'.repeat(129), 'bad\nvalue', ['array']]) {
    assert.deepEqual(requestCorrelation({ headers: { 'x-oneapi-request-id': id, 'x-oneapi-retry-index': '1' } }), {
      correlation_id: null,
      retry_index: null,
    })
  }
  for (const index of ['-1', '1x', '1.5', '', '9999999']) {
    assert.equal(
      requestCorrelation({ headers: { 'x-oneapi-request-id': 'outer', 'x-oneapi-retry-index': index } }).retry_index,
      null,
    )
  }
})
