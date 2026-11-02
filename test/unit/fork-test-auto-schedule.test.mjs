import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { TestReports } from '../../src/lib/fork/test-reports/store.mjs'
import { normalizeAutoPolicy, DEFAULT_AUTO_POLICY } from '../../src/lib/fork/test-reports/auto-schedule.mjs'
import { reportOutcome } from '../../src/lib/fork/test-reports/rules.mjs'
import { VmTestScheduleRunner } from '../../src/lib/admin/vm-test-schedule.mjs'
import {
  getVm,
  patchVmRecord,
  setScheduleOff,
  markUnschedulable,
  setScheduleHold,
} from '../../src/lib/vm/vm-registry.mjs'
import { pickScheduleFields, resolveSlotState } from '../../src/lib/pool/schedule-state.mjs'
import { buildRecreatedVmRecord } from '../../src/lib/vm/vm-recreate.mjs'
import { evaluateSlotGate } from '../../src/lib/pool/schedule-eligibility.mjs'
import { pickCodexSlots } from '../../src/lib/pool/codex-slot-pool.mjs'

const policy = (extra = {}) => ({ ...DEFAULT_AUTO_POLICY, enabled: true, ...extra })
const rule = (extra = {}) => ({ enabled: true, contains: ['answer'], mode: 'all', when_unmatched: 'pending', ...extra })
const result = (text = 'answer', extra = {}) => ({
  ok: true,
  text,
  body: { output_text: text },
  stop_reason: 'completed',
  ...extra,
})
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

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-auto-schedule-'))
  fs.mkdirSync(path.join(root, 'vms'))
  fs.writeFileSync(
    path.join(root, 'vms/vm-01.json'),
    JSON.stringify({
      id: 'vm-01',
      name: 'One',
      status: 'running',
      schedulable: true,
      platform: 'anthropic',
      claude: { has_access: true },
      proxy_cli_enabled: true,
      proxy: { host: '127.0.0.1', port: 1080 },
    }),
  )
  const database = path.join(root, 'reports.sqlite')
  let db = new DatabaseSync(database)
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)')
  let clock = 1793232000000
  let reports = new TestReports({ db, projectRoot: root, now: () => ++clock })
  const runner = new VmTestScheduleRunner({
    projectRoot: root,
    settings: reports.settings,
    testReports: reports,
    runTest: async () => result(),
  })
  runner.save('vm-01', plan)
  reports.saveRule(['vm-01'], rule())
  reports.auto.save(['vm-01'], policy())
  t.after(() => {
    runner.stop()
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  return {
    root,
    runner,
    get reports() {
      return reports
    },
    vm: () => getVm(root, 'vm-01'),
    add(text = 'answer', extra = {}, source = 'scheduled') {
      return reports.finish(reports.begin('vm-01', source, plan), result(text, extra))
    },
    reopen() {
      db.close()
      db = new DatabaseSync(database)
      reports = new TestReports({ db, projectRoot: root, now: () => ++clock })
      return reports
    },
  }
}

test('policy validation and execution-first outcomes match the block semantics', () => {
  for (const invalid of [
    { enabled: 'true' },
    { pause_after: 0 },
    { resume_after: 1.5 },
    { pause_on: [] },
    { pause_on: ['pass'] },
    { resume_enabled: null },
    { pause_after: Number.MAX_SAFE_INTEGER + 1 },
  ])
    assert.throws(() => normalizeAutoPolicy(policy(invalid)))
  assert.deepEqual(normalizeAutoPolicy(policy({ pause_on: ['pending', 'pending'] })).pause_on, ['pending'])
  assert.equal(reportOutcome({ ok: false, rule: { enabled: true }, verdict: 'pending' }), 'error')
  assert.equal(reportOutcome({ ok: true, rule: { enabled: false }, verdict: 'pending' }), 'pass')
  for (const verdict of ['pass', 'pending', 'fail']) {
    assert.equal(reportOutcome({ ok: true, rule: { enabled: true }, verdict }), verdict)
  }
})

test('only consecutive scheduled outcomes pause and recover; manual tests do not advance or reset either streak', (t) => {
  const f = fixture(t)
  f.add('miss')
  f.add('miss')
  f.add('answer', {}, 'manual')
  assert.equal(f.reports.auto.view('vm-01').pause_streak, 2)
  const paused = f.add('miss')
  assert.equal(paused.automation.action, 'pause')
  assert.equal(paused.automation.action_status, 'applied')
  assert.equal(f.vm().schedulable, false)
  assert.equal(f.vm().status, 'running')
  assert.equal(f.vm().schedule_off, undefined)
  assert.equal(resolveSlotState({ vm: f.vm() }).restriction_reason, 'test_auto_pause')
  assert.deepEqual(evaluateSlotGate(f.vm()), { ok: false, reason: 'vm_unschedulable' })
  f.add('answer')
  f.add('miss', {}, 'manual')
  assert.equal(f.reports.auto.view('vm-01').resume_streak, 1)
  f.add('miss')
  assert.equal(f.reports.auto.view('vm-01').resume_streak, 0)
  f.add('answer')
  const resumed = f.add('answer')
  assert.equal(resumed.automation.action, 'resume')
  assert.equal(f.vm().test_schedule_hold, undefined)
  assert.equal(f.vm().schedulable, true)
  assert.equal(f.reports.auto.view('vm-01').pause_streak, 0)
  f.add('miss')
  f.add('answer')
  assert.equal(f.reports.auto.view('vm-01').pause_streak, 0)
})

test('transport failures are not yellow; selected outcomes form one consecutive condition and recovery can be disabled', (t) => {
  const f = fixture(t)
  f.add('miss')
  f.add('', { ok: false, error: { message: 'network' } })
  assert.equal(f.reports.auto.view('vm-01').pause_streak, 0)
  f.reports.auto.save(['vm-01'], policy({ pause_on: ['pending', 'error'], pause_after: 2, resume_enabled: false }))
  f.add('miss')
  f.add('', { ok: false })
  assert.ok(f.vm().test_schedule_hold)
  for (let i = 0; i < 3; i++) f.add('answer')
  assert.ok(f.vm().test_schedule_hold)
  assert.equal(f.reports.auto.view('vm-01').resume_streak, 0)
})

test('without a quality rule, successful invocation is green rather than pending', (t) => {
  const f = fixture(t)
  f.reports.saveRule(['vm-01'], rule({ enabled: false }))
  assert.throws(() => f.reports.auto.save(['vm-01'], policy()), /内容判定/)
  f.reports.auto.save(['vm-01'], policy({ pause_on: ['error'], pause_after: 1 }))
  f.add('', { ok: false })
  assert.ok(f.vm().test_schedule_hold)
  assert.equal(f.add('anything').verdict, 'pending')
  f.add('anything')
  assert.equal(f.vm().schedulable, true)
})

test('automatic recovery and explicit test release never clear credential, maintenance, or quota restrictions', (t) => {
  const f = fixture(t)
  f.reports.auto.save(['vm-01'], policy({ pause_after: 1 }))
  f.add('miss')
  markUnschedulable(f.root, 'vm-01', 'oauth_revoked')
  setScheduleHold(f.root, 'vm-01', 'maintenance', { tag: 'upgrade' })
  patchVmRecord(f.root, 'vm-01', (vm) => {
    vm.temp_unschedulable_until = Date.now() + 60_000
  })
  f.add('answer')
  f.add('answer')
  assert.equal(f.vm().test_schedule_hold, undefined)
  assert.equal(f.vm().schedulable, false)
  assert.equal(f.vm().unschedulable.reason, 'oauth_revoked')
  assert.equal(f.vm().schedule_hold.detail.tag, 'upgrade')
  assert.ok(f.vm().temp_unschedulable_until > Date.now())
  f.add('miss')
  f.reports.auto.release('vm-01')
  assert.equal(f.vm().schedulable, false)
  assert.equal(f.vm().unschedulable.reason, 'oauth_revoked')
  assert.equal(f.vm().schedule_hold.reason, 'maintenance')
})

test('manual off wins over late tests and resets observation when manually reopened', (t) => {
  const f = fixture(t)
  f.reports.auto.save(['vm-01'], policy({ pause_after: 1 }))
  f.add('miss')
  const late = f.reports.begin('vm-01', 'scheduled', plan)
  setScheduleOff(f.root, 'vm-01', true)
  assert.equal(f.vm().test_schedule_hold, undefined)
  f.reports.finish(late, result())
  for (let i = 0; i < 3; i++) f.add('answer')
  assert.equal(f.vm().schedule_off, true)
  assert.equal(f.vm().schedulable, false)
  assert.equal(f.reports.auto.view('vm-01').resume_streak, 0)
  setScheduleOff(f.root, 'vm-01', false)
  assert.equal(f.reports.auto.view('vm-01').pause_streak, 0)
  f.add('miss')
  assert.ok(f.vm().test_schedule_hold)
})

test('policy, plan, rule and owner revisions isolate old in-flight tests and never silently release a park', (t) => {
  const f = fixture(t)
  for (const change of [
    () => f.reports.auto.save(['vm-01'], policy()),
    () => f.runner.save('vm-01', { ...plan, prompt: 'new question' }),
    () => f.reports.saveRule(['vm-01'], rule()),
  ]) {
    f.add('miss')
    const late = f.reports.begin('vm-01', 'scheduled', plan)
    change()
    assert.equal(f.reports.auto.view('vm-01').pause_streak, 0)
    assert.equal(f.reports.finish(late, result('miss')).automation.reason, 'stale_test')
  }
  f.reports.auto.save(['vm-01'], policy({ pause_after: 1 }))
  f.add('miss')
  f.reports.saveRule(['vm-01'], rule({ contains: ['new'] }))
  assert.ok(f.vm().test_schedule_hold)
  const late = f.reports.begin('vm-01', 'scheduled', plan)
  patchVmRecord(f.root, 'vm-01', { owner_user_id: 'new-owner' })
  f.reports.finish(late, result('new'))
  assert.ok(f.vm().test_schedule_hold)
  assert.equal(f.reports.auto.view('vm-01').policy.enabled, false)
})

test('disabling a parked policy requires an explicit release or conversion to manual off', (t) => {
  const f = fixture(t)
  f.reports.auto.save(['vm-01'], policy({ pause_after: 1 }))
  f.add('miss')
  assert.throws(() => f.reports.auto.save(['vm-01'], policy({ enabled: false })), /请选择/)
  f.reports.auto.save(['vm-01'], policy({ enabled: false }), 'manual')
  assert.equal(f.vm().schedule_off, true)
  assert.equal(f.vm().test_schedule_hold, undefined)
  setScheduleOff(f.root, 'vm-01', false)
  f.reports.auto.save(['vm-01'], policy({ pause_after: 1 }))
  f.add('miss')
  f.reports.auto.save(['vm-01'], policy({ enabled: false }), 'release')
  assert.equal(f.vm().schedulable, true)
})

test('retention and restart do not lose counters; replaying a finished run cannot count it twice', (t) => {
  const f = fixture(t)
  f.reports.auto.save(['vm-01'], policy({ pause_after: 35 }))
  for (let i = 0; i < 32; i++) f.add('miss')
  assert.equal(f.reports.list(['vm-01']).total, 30)
  f.reopen()
  assert.equal(f.reports.auto.view('vm-01').pause_streak, 32)
  const context = f.reports.begin('vm-01', 'scheduled', plan)
  const first = f.reports.finish(context, result('miss'))
  assert.equal(f.reports.finish(context, result('miss')).id, first.id)
  assert.equal(f.reports.auto.view('vm-01').pause_streak, 33)
  f.add('miss')
  f.add('miss')
  assert.ok(f.vm().test_schedule_hold)
  assert.deepEqual(pickScheduleFields(f.vm()).test_schedule_hold, f.vm().test_schedule_hold)
  const codex = { ...f.vm(), platform: 'openai', has_token: true }
  assert.equal(pickCodexSlots([codex]).error, 'no_codex_vm')
  assert.deepEqual(pickCodexSlots([codex], { pin: codex.id }).ids, [codex.id])
})

test('a committed decision survives a crash before its VM projection and respects a later manual override', (t) => {
  const f = fixture(t)
  f.reports.auto.save(['vm-01'], policy({ pause_after: 1 }))
  const apply = f.reports.auto.applyPending
  f.reports.auto.applyPending = () => null
  f.add('miss')
  assert.equal(f.vm().test_schedule_hold, undefined)
  f.reports.auto.applyPending = apply
  f.reopen().auto.reconcile()
  assert.ok(f.vm().test_schedule_hold)
  f.reports.auto.release('vm-01')
  f.reports.auto.applyPending = () => null
  f.add('miss')
  setScheduleOff(f.root, 'vm-01', true)
  f.reopen().auto.reconcile()
  assert.equal(f.vm().test_schedule_hold, undefined)
  assert.equal(f.vm().schedule_off, true)
})

test('pausing or deleting the test plan retains the park, but prevents automatic recovery until testing resumes', (t) => {
  const f = fixture(t)
  f.reports.auto.save(['vm-01'], policy({ pause_after: 1 }))
  f.add('miss')
  f.runner.save('vm-01', { ...plan, enabled: false })
  assert.match(f.reports.auto.view('vm-01').blocked_reason, /定时测试/)
  f.add('answer')
  assert.ok(f.vm().test_schedule_hold)
  f.runner.remove('vm-01')
  assert.ok(f.vm().test_schedule_hold)
  assert.equal(f.reports.auto.view('vm-01').resume_streak, 0)
  f.runner.save('vm-01', plan)
  f.add('answer')
  f.add('answer')
  assert.equal(f.vm().schedulable, true)
})

test('failed VM writes remain visibly pending and can be reconciled without counting the result again', (t) => {
  const f = fixture(t)
  f.reports.auto.save(['vm-01'], policy({ pause_after: 1 }))
  f.reports.auto.projectRoot = path.join(f.root, 'missing')
  const saved = f.add('miss')
  assert.equal(saved.automation.action_status, 'failed')
  assert.ok(f.reports.auto.view('vm-01').action_error)
  assert.equal(f.reports.auto.view('vm-01').pending_action, 'hold')
  assert.equal(f.vm().schedulable, true)
  f.reports.auto.projectRoot = f.root
  f.reports.auto.reconcile()
  assert.equal(f.reports.auto.view('vm-01').action_error, null)
  assert.ok(f.vm().test_schedule_hold)
  f.reports.auto.release('vm-01')
  f.reports.auto.projectRoot = path.join(f.root, 'missing')
  f.add('miss')
  f.reports.auto.projectRoot = f.root
  f.reports.auto.save(['vm-01'], policy({ enabled: false }), 'manual')
  assert.equal(f.vm().schedule_off, true)
  assert.equal(f.vm().test_schedule_hold, undefined)
})

test('a failed manual conversion keeps its operator revision until the VM write actually succeeds', (t) => {
  const f = fixture(t)
  f.reports.auto.save(['vm-01'], policy({ pause_after: 1 }))
  f.add('miss')
  const rename = fs.renameSync
  fs.renameSync = (...args) => {
    if (args[1] === path.join(f.root, 'vms/vm-01.json')) throw new Error('simulated atomic rename failure')
    return rename(...args)
  }
  try {
    f.reports.auto.save(['vm-01'], policy({ enabled: false }), 'manual')
  } finally {
    fs.renameSync = rename
  }
  assert.equal(f.vm().schedule_off, undefined)
  assert.equal(f.reports.auto.view('vm-01').pending_action, 'manual')
  assert.ok(f.reports.auto.view('vm-01').action_error)
  f.reports.auto.reconcile()
  assert.equal(f.vm().schedule_off, true)
  assert.equal(f.vm().test_schedule_hold, undefined)
  assert.equal(f.reports.auto.view('vm-01').pending_action, null)
  assert.equal(f.reports.auto.view('vm-01').action_error, null)
})

test('runtime rebuilds preserve a test park independently of credentials and keep/fresh mode', (t) => {
  const f = fixture(t)
  f.reports.auto.save(['vm-01'], policy({ pause_after: 1 }))
  f.add('miss')
  for (const mode of ['keep', 'traits']) {
    const next = buildRecreatedVmRecord(f.vm(), null, { mode })
    assert.deepEqual(next.test_schedule_hold, f.vm().test_schedule_hold)
    assert.equal(next.schedulable, false)
  }
  const late = f.reports.begin('vm-01', 'scheduled', plan)
  patchVmRecord(f.root, 'vm-01', (vm) => {
    vm.claude.account_uuid = 'replacement-account'
  })
  assert.equal(f.reports.finish(late, result()).automation.reason, 'stale_test')
})

test('the actual schedule runner keeps testing a parked slot and restores it without a browser', async (t) => {
  const f = fixture(t)
  f.reports.auto.save(['vm-01'], policy({ pause_after: 1 }))
  f.runner.runTest = async () => result('miss')
  f.runner.start()
  await f.runner.jobs.get('vm-01').trigger()
  assert.ok(f.vm().test_schedule_hold)
  f.runner.runTest = async () => result('answer')
  await f.runner.jobs.get('vm-01').trigger()
  await f.runner.jobs.get('vm-01').trigger()
  assert.equal(f.vm().schedulable, true)
  assert.equal(f.reports.list(['vm-01']).total, 3)
})
