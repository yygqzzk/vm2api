import { fileURLToPath } from 'node:url'
import { applyMigrations, withTransaction } from '../../db/database.mjs'
import { SettingsRepo } from '../../db/repos/settings-repo.mjs'
import { getVm } from '../../vm/vm-registry.mjs'
import { isCodexVm } from '../../vm/vm-kind.mjs'
import { answerSample, DEFAULT_RULE, evaluateRule, normalizeRule, TestReportError } from './rules.mjs'

export const REPORT_LIMIT_PER_VM = 30
const TEXT_LIMIT = 2000
const ruleKey = (vmId) => `fork_test_rule:${vmId}`

function numberOrNull(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

function decode(row) {
  if (!row) return null
  try {
    return { id: row.id, ...JSON.parse(row.record_json) }
  } catch (error) {
    throw new Error(`测试记录 ${row.id} 的持久化数据无法解析`, { cause: error })
  }
}

function summary(record) {
  const { request, rule, evaluation, text, ...rest } = record
  return { ...rest, rule_enabled: rule.enabled, reason: evaluation.reason, text_preview: text?.slice(0, 160) || null }
}

export class TestReports {
  constructor({ db, projectRoot, vm = (id) => getVm(projectRoot, id), now = () => Date.now() }) {
    applyMigrations(db, { migrationsDir: fileURLToPath(new URL('./migrations/', import.meta.url)) })
    this.db = db
    this.settings = new SettingsRepo(db)
    this.vm = vm
    this.now = now
    this.insert = db.prepare(
      'INSERT INTO fork_test_reports (vm_id, source, model, verdict, started_at, record_json) VALUES (?, ?, ?, ?, ?, ?)',
    )
    this.prune = db.prepare(
      'DELETE FROM fork_test_reports WHERE vm_id = ? AND id NOT IN (SELECT id FROM fork_test_reports WHERE vm_id = ? ORDER BY started_at DESC, id DESC LIMIT ?)',
    )
  }

  rule(vmId) {
    return this.settings.get(ruleKey(vmId), DEFAULT_RULE)
  }

  saveRule(vmIds, input) {
    const rule = normalizeRule(input)
    withTransaction(this.db, () => {
      for (const id of vmIds) this.settings.set(ruleKey(id), rule)
    })
    return rule
  }

  begin(vmId, source, params) {
    const vm = this.vm(vmId)
    if (!vm) throw new TestReportError('vm not found', 404)
    return {
      vm_id: vmId,
      vm_name: vm.name || vmId,
      platform: isCodexVm(vm) ? 'openai' : 'anthropic',
      source,
      started_at: new Date(this.now()).toISOString(),
      model: String(params.model || '').slice(0, 200),
      request: {
        prompt: String(params.prompt || '').slice(0, 16000),
        prompt_truncated: String(params.prompt || '').length > 16000,
        max_tokens: params.max_tokens == null ? null : numberOrNull(Number(params.max_tokens)),
        reasoning_effort: params.reasoning_effort == null ? null : String(params.reasoning_effort).slice(0, 64),
      },
      rule: structuredClone(this.rule(vmId)),
    }
  }

  finish(context, result) {
    // A removed slot must not be resurrected by a late manual test.
    if (!context || !this.vm(context.vm_id)) return null
    const ok = result?.ok === true
    const sample = answerSample(result)
    const evaluation = evaluateRule(context.rule, sample, ok)
    const usage = result?.usage
    const record = {
      ...context,
      model: String(result?.model || context.model).slice(0, 200),
      request: {
        ...context.request,
        prompt: String(result?.prompt ?? context.request.prompt).slice(0, 16000),
        prompt_truncated:
          result?.prompt == null ? context.request.prompt_truncated : String(result.prompt).length > 16000,
        max_tokens: numberOrNull(result?.max_tokens) ?? context.request.max_tokens,
      },
      ok,
      duration_ms: numberOrNull(result?.duration_ms) ?? Math.max(0, this.now() - Date.parse(context.started_at)),
      status: result?.status ?? null,
      stop_reason: result?.stop_reason ?? null,
      input_tokens: numberOrNull(usage?.input_tokens),
      output_tokens: numberOrNull(usage?.output_tokens),
      cache_read_tokens: numberOrNull(usage?.cache_read_input_tokens ?? usage?.input_tokens_details?.cached_tokens),
      error: ok ? null : String(result?.error?.message || result?.error?.code || 'test failed').slice(0, 300),
      text: ok ? sample.text.slice(0, TEXT_LIMIT) || null : null,
      text_truncated: ok && sample.text.length > TEXT_LIMIT,
      sample_complete: sample.complete,
      evaluation,
      verdict: evaluation.verdict,
    }
    return withTransaction(this.db, () => {
      const inserted = this.insert.run(
        record.vm_id,
        record.source,
        record.model,
        record.verdict,
        record.started_at,
        JSON.stringify(record),
      )
      this.prune.run(record.vm_id, record.vm_id, REPORT_LIMIT_PER_VM)
      return { id: Number(inserted.lastInsertRowid), ...record }
    })
  }

  list(vmIds, { vm_id, source, verdict, model, limit = 50, offset = 0 } = {}) {
    limit = Number(limit)
    offset = Number(offset)
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) {
      throw new TestReportError('分页须为 limit 1–100，offset 非负整数')
    }
    if (source && !['manual', 'scheduled'].includes(source)) throw new TestReportError('测试来源无效')
    if (verdict && !['pass', 'pending', 'fail'].includes(verdict)) throw new TestReportError('判定无效')
    if (vm_id) vmIds = vmIds.filter((id) => id === vm_id)
    if (!vmIds.length) return { items: [], total: 0, limit, offset }
    const predicates = [`vm_id IN (${vmIds.map(() => '?').join(',')})`]
    const values = [...vmIds]
    for (const [key, value] of Object.entries({ source, verdict, model })) {
      if (value) {
        predicates.push(`${key} = ?`)
        values.push(value)
      }
    }
    const where = predicates.join(' AND ')
    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM fork_test_reports WHERE ${where}`).get(...values).n
    const rows = this.db
      .prepare(
        `SELECT id, record_json FROM fork_test_reports WHERE ${where} ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?`,
      )
      .all(...values, limit, offset)
    return { items: rows.map((row) => summary(decode(row))), total, limit, offset }
  }

  detail(vmIds, id) {
    if (!Number.isSafeInteger(Number(id)) || Number(id) < 1) throw new TestReportError('记录不存在', 404)
    const row = this.db.prepare('SELECT id, vm_id, record_json FROM fork_test_reports WHERE id = ?').get(Number(id))
    return row && vmIds.includes(row.vm_id) ? decode(row) : null
  }

  overview(vms) {
    if (!vms.length) return []
    const histories = new Map(vms.map((vm) => [vm.id, []]))
    const rows = this.db
      .prepare(
        `SELECT id, vm_id, record_json FROM fork_test_reports
       WHERE vm_id IN (${vms.map(() => '?').join(',')}) ORDER BY started_at DESC, id DESC`,
      )
      .all(...vms.map((vm) => vm.id))
    for (const row of rows) histories.get(row.vm_id).push(decode(row))
    return vms.map((vm) => {
      const records = histories.get(vm.id).slice(0, REPORT_LIMIT_PER_VM)
      return {
        vm_id: vm.id,
        vm_name: vm.name || vm.id,
        platform: isCodexVm(vm) ? 'openai' : 'anthropic',
        latest: records[0] ? summary(records[0]) : null,
        history: records.reverse().map(({ id, started_at, ok, verdict, rule }) => ({
          id,
          started_at,
          ok,
          verdict,
          rule_enabled: rule.enabled,
        })),
      }
    })
  }

  remove(vmId, { slotDeleted = false } = {}) {
    if (slotDeleted) {
      this.db.prepare('DELETE FROM fork_test_reports WHERE vm_id = ?').run(vmId)
      this.settings.remove(ruleKey(vmId))
    } else this.db.prepare("DELETE FROM fork_test_reports WHERE vm_id = ? AND source = 'scheduled'").run(vmId)
  }
}

export async function runReportedTest(reports, vmId, params, run) {
  const context = reports?.begin(vmId, 'manual', params)
  let result
  try {
    result = await run()
  } catch (error) {
    reports?.finish(context, { ok: false, error })
    throw error
  }
  reports?.finish(context, result)
  return result
}
