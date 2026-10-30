import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { normalizeRule, evaluateRule, answerSample } from '../../src/lib/fork/test-reports/rules.mjs'
import { TestReports, runReportedTest } from '../../src/lib/fork/test-reports/store.mjs'
import { VmTestScheduleRunner } from '../../src/lib/admin/vm-test-schedule.mjs'

const vms = [
  { id: 'vm-01', name: 'GPT one', platform: 'openai' },
  { id: 'vm-02', platform: 'anthropic' },
]
const rule = (extra = {}) => ({
  enabled: true,
  contains: ['42', 'answer'],
  mode: 'all',
  when_unmatched: 'pending',
  ...extra,
})
const result = (text = 'answer is 42', extra = {}) => ({
  ok: true,
  status: 200,
  stop_reason: 'completed',
  text,
  body: { output_text: text },
  duration_ms: 20,
  usage: { input_tokens: 0, output_tokens: 3 },
  ...extra,
})
function fixture(t) {
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)')
  let clock = 1793232000000
  let targets = [...vms]
  const reports = new TestReports({ db, vm: (id) => targets.find((vm) => vm.id === id), now: () => ++clock })
  const add = (vmId, text, source = 'scheduled') =>
    reports.finish(reports.begin(vmId, source, { model: 'gpt-test', prompt: 'what is the answer?' }), result(text))
  return {
    db,
    reports,
    add,
    removeVm: () => {
      targets = []
    },
  }
}

test('manual parameter snapshots are bounded and cannot turn invalid JSON field types into SQLite/render failures', (t) => {
  const { reports } = fixture(t)
  const context = reports.begin('vm-01', 'manual', {
    model: { invalid: true },
    prompt: 'x'.repeat(17000),
    max_tokens: { invalid: true },
    reasoning_effort: { invalid: true },
  })
  const saved = reports.finish(context, { ok: false, error: { message: 'invalid parameters' } })
  assert.equal(typeof saved.model, 'string')
  assert.equal(saved.request.prompt.length, 16000)
  assert.equal(saved.request.prompt_truncated, true)
  assert.equal(saved.request.max_tokens, null)
  assert.equal(typeof saved.request.reasoning_effort, 'string')
  const resolved = reports.finish(
    reports.begin('vm-01', 'manual', { model: 'm' }),
    result('answer', { prompt: 'y'.repeat(17000) }),
  )
  assert.equal(resolved.request.prompt.length, 16000)
  assert.equal(resolved.request.prompt_truncated, true)
})

test('rules and records survive reopen without colliding with upstream migrations', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-reports-persist-'))
  let db = createDatabase({ dataDir })
  t.after(() => {
    db.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
  const first = new TestReports({ db, vm: () => vms[0] })
  const originalRule = first.saveRule(['vm-01'], rule())
  const saved = first.finish(first.begin('vm-01', 'manual', { model: 'm', prompt: 'question' }), result())
  db.close()
  db = createDatabase({ dataDir })
  const restored = new TestReports({ db, vm: () => vms[0] })
  assert.equal(restored.detail(['vm-01'], saved.id).verdict, 'pass')
  assert.equal(restored.rule('vm-01').revision, originalRule.revision)
  assert.ok(db.prepare("SELECT version FROM schema_migrations WHERE version = '001'").get())
  assert.ok(db.prepare("SELECT version FROM schema_migrations WHERE version = '001forktests'").get())
})

test('literal matching covers all/any, case sensitivity, pending default and explicit fail', () => {
  const sample = { text: 'answer is 42', complete: true }
  assert.equal(evaluateRule(normalizeRule(rule()), sample, true).verdict, 'pass')
  const missed = evaluateRule(normalizeRule(rule({ contains: ['Answer', '42'] })), sample, true)
  assert.equal(missed.verdict, 'pending')
  assert.deepEqual(missed.matched, ['42'])
  assert.deepEqual(missed.missing, ['Answer'])
  assert.equal(
    evaluateRule(normalizeRule(rule({ mode: 'any', contains: ['missing', '42'] })), sample, true).verdict,
    'pass',
  )
  assert.equal(
    evaluateRule(normalizeRule(rule({ when_unmatched: 'fail', contains: ['missing'] })), sample, true).verdict,
    'fail',
  )
  for (const input of [
    rule({ contains: [] }),
    rule({ contains: [''] }),
    rule({ contains: ['a'.repeat(501)] }),
    rule({ mode: 'regex' }),
    rule({ when_unmatched: 'pass' }),
  ])
    assert.throws(() => normalizeRule(input))
})

test('network errors, empty answers, no rule and incomplete samples remain pending', () => {
  const configured = normalizeRule(rule({ when_unmatched: 'fail' }))
  for (const [sample, ok, reason] of [
    [{ text: '42 answer', complete: true }, false, 'execution_error'],
    [{ text: 'missing', complete: false }, true, 'incomplete_sample'],
    [{ text: '', complete: true }, true, 'empty_answer'],
  ]) {
    assert.deepEqual(evaluateRule(configured, sample, ok), { verdict: 'pending', reason, matched: [], missing: [] })
  }
  assert.equal(
    evaluateRule({ ...configured, enabled: false }, { text: 'answer 42', complete: true }, true).reason,
    'no_rule',
  )
})

test('answer extraction excludes thinking, tools, error JSON and detects capped fallback samples', () => {
  const sample = answerSample(
    result('fallback', {
      body: {
        content: [
          { type: 'thinking', thinking: 'answer 42' },
          { type: 'text', text: 'visible' },
          { type: 'tool_use', input: 'answer 42' },
        ],
      },
    }),
  )
  assert.deepEqual(sample, { text: 'visible', complete: true })
  assert.equal(answerSample(result('x'.repeat(4000), { body: null })).complete, false)
  assert.equal(answerSample(result('answer 42', { stop_reason: 'max_tokens' })).complete, false)
  assert.equal(
    answerSample(result('partial', { stop_reason: null, body: { status: 'completed', output_text: 'partial' } }))
      .complete,
    false,
  )
  assert.equal(
    answerSample(
      result('', { body: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'answer 42' }] }] } }),
    ).text,
    'answer 42',
  )
})

test('rules are captured at start; full body is evaluated before retention truncation', (t) => {
  const { reports } = fixture(t)
  const oldRule = reports.saveRule(['vm-01'], rule({ contains: ['tail marker'] }))
  const context = reports.begin('vm-01', 'scheduled', { model: 'gpt-test', prompt: 'original question' })
  reports.saveRule(['vm-01'], rule({ contains: ['new marker'] }))
  const full = 'x'.repeat(4500) + 'tail marker'
  const saved = reports.finish(context, result(full.slice(0, 4000), { body: { output_text: full } }))
  assert.equal(saved.verdict, 'pass')
  assert.deepEqual(saved.evaluation.matched, ['tail marker'])
  assert.equal(saved.rule.revision, oldRule.revision)
  assert.equal(saved.request.prompt, 'original question')
  assert.equal(saved.text.length, 2000)
  assert.equal(saved.text_truncated, true)
  assert.equal('body' in saved, false)
  assert.equal(saved.input_tokens, 0)
  assert.equal(saved.cache_read_tokens, null)
})

test('cross-slot history is ordered, paginated, scoped and limited to 30 per slot across sources', (t) => {
  const { reports, add } = fixture(t)
  reports.saveRule(['vm-01', 'vm-02'], rule({ contains: ['pass'] }))
  for (let i = 0; i < 35; i++) add('vm-01', `pass ${i}`, i % 2 ? 'manual' : 'scheduled')
  add('vm-02', 'miss', 'manual')
  const page = reports.list(['vm-01', 'vm-02'], { limit: 2 })
  assert.equal(page.total, 31)
  assert.equal(page.items[0].vm_id, 'vm-02')
  assert.equal(page.items[1].text_preview, 'pass 34')
  assert.equal('request' in page.items[0], false)
  assert.equal(reports.list(['vm-01'], { limit: 2, offset: 29 }).items.length, 1)
  assert.equal(reports.list(['vm-01'], { vm_id: 'vm-02' }).total, 0)
  assert.equal(reports.list(['vm-01', 'vm-02'], { source: 'manual', verdict: 'pending' }).total, 1)
  assert.equal(reports.list(['vm-01'], { model: 'gpt-other' }).total, 0)
  assert.equal(reports.detail(['vm-01'], page.items[0].id), null)
  assert.throws(() => reports.list(['vm-01'], { source: 'anything' }))
  assert.throws(() => reports.list(['vm-01'], { limit: 100000 }))
  assert.throws(() => reports.list(['vm-01'], { offset: -1 }))
})

test('overview returns bounded chronological blocks with immutable rule state and no content', (t) => {
  const { reports, add } = fixture(t)
  for (let i = 0; i < 35; i++) add('vm-01', `private answer ${i}`)
  reports.saveRule(['vm-01'], rule())
  add('vm-01', 'answer 42', 'manual')
  reports.saveRule(['vm-01'], rule({ enabled: false }))
  add('vm-02', 'foreign answer')
  const overview = reports.overview([vms[0], { id: 'empty', name: 'Empty' }])
  assert.equal(overview.length, 2)
  const { history, latest } = overview[0]
  assert.equal(history.length, 30)
  assert.equal(history[0].id, 7)
  assert.equal(history.at(-1).id, latest.id)
  assert.equal(history[0].rule_enabled, false)
  assert.equal(history.at(-1).rule_enabled, true)
  assert.equal(latest.rule_enabled, true)
  assert.ok(history.every((item, i) => !i || history[i - 1].started_at <= item.started_at))
  assert.deepEqual(Object.keys(history[0]).sort(), ['id', 'ok', 'rule_enabled', 'started_at', 'verdict'])
  assert.deepEqual(overview[1].history, [])
  assert.equal(overview[1].latest, null)
  assert.deepEqual(reports.overview([]), [])
})

test('chronology uses start time, not the completion order of concurrent calls', (t) => {
  const { reports } = fixture(t)
  const earlier = reports.begin('vm-01', 'manual', { model: 'm' })
  const later = reports.begin('vm-02', 'manual', { model: 'm' })
  reports.finish(later, result('later'))
  reports.finish(earlier, result('earlier'))
  assert.deepEqual(
    reports.list(vms.map((vm) => vm.id)).items.map((item) => item.text_preview),
    ['later', 'earlier'],
  )
})

test('deleting a plan clears only scheduled reports; removing a slot clears reports and rules', (t) => {
  const { reports, add, removeVm } = fixture(t)
  reports.saveRule(['vm-01'], rule())
  add('vm-01', 'scheduled')
  add('vm-01', 'manual', 'manual')
  reports.remove('vm-01')
  assert.deepEqual(
    reports.list(['vm-01']).items.map((item) => item.source),
    ['manual'],
  )
  assert.equal(reports.rule('vm-01').enabled, true)
  const late = reports.begin('vm-01', 'manual', { model: 'gpt-test' })
  removeVm()
  reports.remove('vm-01', { slotDeleted: true })
  assert.equal(reports.finish(late, result()), null)
  assert.equal(reports.list(['vm-01']).total, 0)
  assert.equal(reports.rule('vm-01').enabled, false)
})

test('manual execution preserves upstream result and stores thrown failures as pending', async (t) => {
  const { reports } = fixture(t)
  const successful = result()
  assert.equal(await runReportedTest(reports, 'vm-01', { model: 'gpt-test' }, async () => successful), successful)
  await assert.rejects(
    () =>
      runReportedTest(reports, 'vm-01', {}, async () => {
        throw new Error('closed')
      }),
    /closed/,
  )
  const page = reports.list(['vm-01'])
  assert.equal(page.total, 2)
  assert.equal(page.items[0].source, 'manual')
  assert.equal(page.items[0].verdict, 'pending')
  assert.equal(page.items[0].error, 'closed')
})

test('scheduled capture honors plan revisions and does not duplicate a finished run', async (t) => {
  const { reports } = fixture(t)
  const schedule = new VmTestScheduleRunner({
    projectRoot: '/missing',
    list: () => vms,
    settings: reports.settings,
    testReports: reports,
    runTest: async () => result(),
  })
  t.after(() => schedule.stop())
  const plan = {
    enabled: true,
    frequency: 'daily',
    time: '09:00',
    timezone: 'UTC',
    model: 'gpt-test',
    prompt: 'answer?',
    max_tokens: null,
    reasoning_effort: 'high',
  }
  schedule.save('vm-01', plan)
  schedule.start()
  await schedule.jobs.get('vm-01').trigger()
  assert.equal(reports.list(['vm-01']).total, 1)
  let finish
  schedule.runTest = () =>
    new Promise((resolve) => {
      finish = resolve
    })
  const pending = schedule.jobs.get('vm-01').trigger()
  await new Promise((resolve) => setImmediate(resolve))
  schedule.save('vm-01', { ...plan, prompt: 'new question' })
  finish(result('late'))
  await pending
  assert.equal(reports.list(['vm-01']).total, 1)
  schedule.remove('vm-01')
  assert.equal(reports.list(['vm-01']).total, 0)
})
