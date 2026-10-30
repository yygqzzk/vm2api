import '../fixtures/kin-computer-test-env.mjs'
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { TestReports } from '../../src/lib/fork/test-reports/store.mjs'

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-test-report-api-'))
const previous = process.env.KIN_DATA_DIR
process.env.KIN_DATA_DIR = data
after(() => {
  if (previous == null) delete process.env.KIN_DATA_DIR
  else process.env.KIN_DATA_DIR = previous
  fs.rmSync(data, { recursive: true, force: true })
})
const { createPanelHandler } = await import('../../src/lib/admin/panel-routes.mjs')
const { authorizePanelRoute } = await import('../../src/lib/admin/panel-acl.mjs')
const ROOT = '/api/panel/fork/test-reports'

test('report routes enforce tenant scope, pagination, immutable snapshots and all-or-nothing rule writes', async (t) => {
  const root = fs.mkdtempSync(path.join(data, 'project-'))
  fs.mkdirSync(path.join(root, 'vms'))
  for (const [id, owner] of [
    ['vm-mine', 'u-1'],
    ['vm-other', 'u-2'],
  ]) {
    fs.writeFileSync(
      path.join(root, 'vms', `${id}.json`),
      JSON.stringify({ id, platform: 'openai', owner_user_id: owner }),
    )
  }
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)')
  const reports = new TestReports({ db, projectRoot: root })
  const mine = reports.finish(reports.begin('vm-mine', 'manual', { model: 'gpt-test', prompt: 'private question' }), {
    ok: true,
    text: 'mine',
    stop_reason: 'completed',
  })
  const foreign = reports.finish(reports.begin('vm-other', 'scheduled', { model: 'gpt-test' }), {
    ok: true,
    text: 'foreign',
  })
  async function call(role, method, path, body) {
    let response
    const handler = createPanelHandler({
      cfg: { paths: { project: root } },
      routingConfig: {},
      testReports: reports,
      requireAuth(req) {
        Object.assign(req, { panelUser: 'test', panelRole: role, panelUserId: 'u-1' })
        return true
      },
      readBody: async () => (typeof body === 'function' ? body() : body),
      json(_res, status, payload) {
        response = { status, body: payload }
        return true
      },
    })
    await handler({ method, headers: {} }, {}, new URL(`http://localhost${path}`))
    return response
  }
  const page = await call('user', 'GET', ROOT)
  assert.equal(page.status, 200)
  assert.equal(page.body.data.total, 1)
  assert.equal(page.body.data.items[0].vm_id, 'vm-mine')
  assert.equal('request' in page.body.data.items[0], false)
  assert.equal((await call('user', 'GET', `${ROOT}/${mine.id}`)).body.data.item.request.prompt, 'private question')
  const denied = await call('user', 'GET', `${ROOT}/${foreign.id}`)
  const missing = await call('user', 'GET', `${ROOT}/99999`)
  assert.equal(denied.status, 404)
  assert.deepEqual(denied.body, missing.body)
  assert.equal((await call('user', 'GET', `${ROOT}?vm_id=vm-other`)).body.data.total, 0)
  assert.equal((await call('user', 'GET', `${ROOT}?limit=100000`)).status, 400)
  assert.deepEqual(
    (await call('user', 'GET', `${ROOT}/summary`)).body.data.items.map((vm) => vm.vm_id),
    ['vm-mine'],
  )
  const overview = (await call('user', 'GET', `${ROOT}/summary`)).body.data.items
  assert.deepEqual(
    overview[0].history.map((entry) => entry.id),
    [mine.id],
  )
  assert.equal(overview[0].history[0].rule_enabled, false)
  assert.equal('text' in overview[0].history[0], false)
  assert.deepEqual((await call('user', 'GET', `${ROOT}/summary?vm_id=vm-other`)).body.data.items, [])
  assert.equal((await call('super', 'GET', ROOT)).body.data.total, 2)
  const rule = { enabled: true, contains: ['answer'], mode: 'all', when_unmatched: 'pending' }
  assert.equal((await call('user', 'GET', `${ROOT}/rules?vm_id=vm-other`)).status, 404)
  assert.equal((await call('super', 'PUT', `${ROOT}/rules`, { vm_ids: ['vm-mine'], rule })).status, 403)
  assert.equal((await call('user', 'PUT', `${ROOT}/rules`, { vm_ids: ['vm-mine', 'vm-other'], rule })).status, 404)
  assert.equal(reports.rule('vm-mine').enabled, false)
  assert.equal((await call('user', 'PUT', `${ROOT}/rules`, { vm_ids: ['vm-mine'], rule })).status, 200)
  assert.equal(
    (await call('admin', 'PUT', `${ROOT}/rules`, { vm_ids: ['vm-mine', 'vm-other'], rule })).body.data.updated,
    2,
  )
  assert.equal((await call('user', 'GET', `${ROOT}/${mine.id}`)).body.data.item.rule.enabled, false)
  const revision = reports.rule('vm-mine').revision
  const reassigned = await call('user', 'PUT', `${ROOT}/rules`, () => {
    fs.writeFileSync(
      path.join(root, 'vms', 'vm-mine.json'),
      JSON.stringify({ id: 'vm-mine', platform: 'openai', owner_user_id: 'u-2' }),
    )
    return { vm_ids: ['vm-mine'], rule }
  })
  assert.equal(reassigned.status, 404)
  assert.equal(reports.rule('vm-mine').revision, revision)
  for (const role of ['user', 'super']) {
    assert.equal(authorizePanelRoute('GET', ROOT, role).ok, true)
    assert.equal(authorizePanelRoute('DELETE', ROOT, role).ok, false)
    assert.equal(authorizePanelRoute('GET', `${ROOT}/unknown`, role).ok, false)
  }
})
