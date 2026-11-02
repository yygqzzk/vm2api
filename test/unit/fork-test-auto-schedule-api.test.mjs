import '../fixtures/kin-computer-test-env.mjs'
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { TestReports } from '../../src/lib/fork/test-reports/store.mjs'
import { VmTestScheduleRunner } from '../../src/lib/admin/vm-test-schedule.mjs'
import { DEFAULT_AUTO_POLICY } from '../../src/lib/fork/test-reports/auto-schedule.mjs'
import { getVm, patchVmRecord } from '../../src/lib/vm/vm-registry.mjs'

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-auto-api-'))
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

test('auto schedule APIs enforce scope, validate all targets, preserve manual precedence and restrict super to scheduling', async (t) => {
  const root = fs.mkdtempSync(path.join(data, 'project-'))
  fs.mkdirSync(path.join(root, 'vms'))
  for (const [id, owner] of [
    ['vm-mine', 'u-1'],
    ['vm-other', 'u-2'],
  ]) {
    fs.writeFileSync(
      path.join(root, 'vms', `${id}.json`),
      JSON.stringify({
        id,
        owner_user_id: owner,
        status: 'running',
        schedulable: true,
        platform: 'anthropic',
        claude: { has_access: true },
        proxy_cli_enabled: true,
        proxy: { host: '127.0.0.1', port: 1080 },
      }),
    )
  }
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)')
  const reports = new TestReports({ db, projectRoot: root })
  const runner = new VmTestScheduleRunner({ projectRoot: root, settings: reports.settings, testReports: reports })
  const plan = {
    enabled: true,
    frequency: 'hourly',
    minute: 0,
    timezone: 'UTC',
    model: 'claude-test',
    prompt: 'question',
    max_tokens: 128,
    reasoning_effort: null,
  }
  for (const id of ['vm-mine', 'vm-other']) runner.save(id, plan)
  reports.saveRule(['vm-mine', 'vm-other'], {
    enabled: true,
    contains: ['answer'],
    mode: 'all',
    when_unmatched: 'pending',
  })
  async function call(role, method, url, body) {
    let response
    const handler = createPanelHandler({
      cfg: { paths: { project: root } },
      routingConfig: {},
      testReports: reports,
      vmTestSchedule: runner,
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
    await handler({ method, headers: {} }, {}, new URL(`http://localhost${url}`))
    return response
  }
  const policy = { ...DEFAULT_AUTO_POLICY, enabled: true, pause_after: 1 }
  assert.equal((await call('user', 'GET', `${ROOT}/auto-schedule?vm_id=vm-other`)).status, 404)
  assert.equal((await call('super', 'GET', `${ROOT}/auto-schedule?vm_id=vm-other`)).status, 200)
  assert.equal((await call('super', 'PUT', `${ROOT}/auto-schedule`, { vm_ids: ['vm-mine'], policy })).status, 403)
  assert.equal(
    (await call('user', 'PUT', `${ROOT}/auto-schedule`, { vm_ids: ['vm-mine', 'vm-other'], policy })).status,
    404,
  )
  assert.equal(reports.auto.view('vm-mine').policy.enabled, false)
  assert.equal(
    (await call('user', 'PUT', `${ROOT}/auto-schedule`, { vm_ids: ['vm-mine'], policy: { ...policy, pause_after: 0 } }))
      .status,
    400,
  )
  runner.save('vm-other', { ...plan, enabled: false })
  assert.equal(
    (await call('admin', 'PUT', `${ROOT}/auto-schedule`, { vm_ids: ['vm-mine', 'vm-other'], policy })).status,
    400,
  )
  assert.equal(reports.auto.view('vm-mine').policy.enabled, false)
  assert.equal((await call('user', 'PUT', `${ROOT}/auto-schedule`, { vm_ids: ['vm-mine'], policy })).status, 200)
  const report = reports.finish(reports.begin('vm-mine', 'scheduled', plan), {
    ok: true,
    body: { output_text: 'miss' },
    stop_reason: 'completed',
  })
  assert.equal(report.automation.action, 'pause')
  const summary = (await call('user', 'GET', `${ROOT}/summary`)).body.data.items
  assert.equal(summary.length, 1)
  assert.equal(summary[0].automatic.paused, true)
  assert.equal(summary[0].scheduling.schedulable, false)
  assert.equal('claude' in summary[0].scheduling, false)
  assert.equal('proxy' in summary[0].scheduling, false)
  assert.equal(
    (
      await call('user', 'PUT', `${ROOT}/auto-schedule`, {
        vm_ids: ['vm-mine'],
        policy: { ...policy, enabled: false },
      })
    ).status,
    409,
  )
  assert.equal((await call('user', 'POST', `${ROOT}/auto-schedule/release`, { vm_id: 'vm-other' })).status, 404)
  assert.equal((await call('super', 'POST', `${ROOT}/auto-schedule/release`, { vm_id: 'vm-mine' })).status, 200)
  assert.equal(getVm(root, 'vm-mine').schedulable, true)
  reports.finish(reports.begin('vm-mine', 'scheduled', plan), { ok: true, text: 'miss', stop_reason: 'completed' })
  assert.equal((await call('user', 'POST', '/api/panel/vms/vm-mine/schedulable', { schedulable: false })).status, 200)
  assert.equal(getVm(root, 'vm-mine').schedule_off, true)
  assert.equal(getVm(root, 'vm-mine').test_schedule_hold, undefined)
  assert.equal(reports.auto.view('vm-mine').resume_streak, 0)
  const revision = reports.auto.view('vm-mine').policy.revision
  assert.equal(
    (
      await call('user', 'PUT', `${ROOT}/auto-schedule`, () => {
        patchVmRecord(root, 'vm-mine', { owner_user_id: 'u-2' })
        return { vm_ids: ['vm-mine'], policy }
      })
    ).status,
    404,
  )
  assert.equal(reports.settings.get('fork_test_auto_schedule:vm-mine').policy.revision, revision)
  for (const role of ['user', 'super']) {
    assert.equal(authorizePanelRoute('DELETE', `${ROOT}/auto-schedule`, role).ok, false)
    assert.equal(authorizePanelRoute('POST', `${ROOT}/auto-schedule/unknown`, role).ok, false)
  }
})
