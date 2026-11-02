import { randomUUID } from 'node:crypto'
import { withTransaction } from '../../db/database.mjs'
import { VM_TEST_SCHEDULE_PREFIX } from '../../admin/vm-test-schedule.mjs'
import { vmOwnerId } from '../../admin/resource-owner.mjs'
import { patchVmRecord } from '../../vm/vm-registry.mjs'
import { applyScheduleOff, deriveScheduleFields } from '../../pool/schedule-state.mjs'
import { reportOutcome, TestReportError } from './rules.mjs'

const PREFIX = 'fork_test_auto_schedule:'
const keyFor = (id) => `${PREFIX}${id}`
export const DEFAULT_AUTO_POLICY = Object.freeze({
  enabled: false,
  pause_on: ['pending'],
  pause_after: 3,
  resume_enabled: true,
  resume_after: 2,
  revision: null,
})

export function normalizeAutoPolicy(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TestReportError('策略必须是对象')
  if (typeof input.enabled !== 'boolean' || typeof input.resume_enabled !== 'boolean') {
    throw new TestReportError('启用策略和自动恢复必须为布尔值')
  }
  if (
    !Array.isArray(input.pause_on) ||
    !input.pause_on.length ||
    input.pause_on.length > 3 ||
    input.pause_on.some((value) => !['pending', 'fail', 'error'].includes(value))
  ) {
    throw new TestReportError('请选择待定、内容不通过或调用失败作为停调条件')
  }
  for (const key of ['pause_after', 'resume_after']) {
    if (!Number.isSafeInteger(input[key]) || input[key] < 1) throw new TestReportError('连续次数须为正整数')
  }
  return {
    enabled: input.enabled,
    pause_on: [...new Set(input.pause_on)],
    pause_after: input.pause_after,
    resume_enabled: input.resume_enabled,
    resume_after: input.resume_after,
    revision: randomUUID(),
  }
}

/** Test automation owns only test_schedule_hold; it never clears another scheduling gate. */
export class TestAutoSchedule {
  constructor({ settings, projectRoot, vm, rule, now }) {
    this.settings = settings
    this.projectRoot = projectRoot
    this.vm = vm
    this.rule = rule
    this.now = now
  }

  plan(id) {
    return this.settings.get(`${VM_TEST_SCHEDULE_PREFIX}${id}`)
  }

  environment(id) {
    const vm = this.vm(id)
    return {
      owner_user_id: vmOwnerId(vm),
      operator_revision: vm?.schedule_operator_revision || 0,
      account_id: vm?.claude?.account_uuid || vm?.codex?.chatgpt_account_id || null,
      device_id: vm?.fingerprint?.device_id || vm?.device_id || null,
      plan_revision: this.plan(id)?.revision || null,
      rule_revision: this.rule(id).revision,
    }
  }

  freshState(id, previous = {}) {
    return {
      ...previous,
      ...this.environment(id),
      generation: randomUUID(),
      pause_streak: 0,
      resume_streak: 0,
      hold: Object.hasOwn(previous, 'hold') ? previous.hold : this.vm(id)?.test_schedule_hold || null,
      pending: null,
      error: null,
    }
  }

  sync(id) {
    const saved = this.settings.get(keyFor(id))
    if (!saved) return { policy: DEFAULT_AUTO_POLICY, state: this.freshState(id) }
    const env = this.environment(id)
    const changed = Object.keys(env).some((key) => env[key] !== saved.state[key])
    if (!changed) return saved
    const ownerChanged = env.owner_user_id !== saved.state.owner_user_id
    const operatorChanged = env.operator_revision !== saved.state.operator_revision
    const state = this.freshState(id, saved.state)
    if (ownerChanged || operatorChanged) {
      state.hold = this.vm(id)?.test_schedule_hold || null
      state.last_action = {
        kind: ownerChanged ? 'owner_changed' : this.vm(id)?.schedule_off ? 'manual_off' : 'manual_on',
        at: new Date(this.now()).toISOString(),
        status: 'applied',
      }
    } else {
      // A changed test must not silently release a park, or lose a committed but unapplied decision.
      state.hold = saved.state.hold
      state.pending = saved.state.pending
      state.error = saved.state.error
    }
    const policy = ownerChanged ? { ...saved.policy, enabled: false, revision: randomUUID() } : saved.policy
    const current = { policy, state }
    this.settings.set(keyFor(id), current)
    return current
  }

  blocked(id, policy) {
    const plan = this.plan(id)
    if (!plan?.enabled) return '请先启用定时测试；已停调的槽位不会因此自动放行'
    if (!plan.model || !plan.prompt || !plan.cron || !plan.timezone) return '定时测试计划不完整，请重新保存计划'
    if (!policy.pause_on.includes('error') && !this.rule(id).enabled)
      return '请先启用内容判定规则，才能按待定或内容不通过停调'
    return null
  }

  view(id) {
    const { policy, state } = this.sync(id)
    const vm = this.vm(id)
    return {
      policy,
      pause_streak: state.pause_streak,
      resume_streak: state.resume_streak,
      paused: !!vm?.test_schedule_hold,
      pending_action: state.pending?.kind || null,
      hold: vm?.test_schedule_hold || null,
      blocked_reason: policy.enabled ? this.blocked(id, policy) : null,
      last_action: state.last_action || null,
      action_error: state.error,
    }
  }

  capture(id) {
    this.applyPending(id)
    return this.sync(id).state.generation
  }

  save(ids, input, pausedAction = null) {
    const policy = normalizeAutoPolicy(input)
    if (pausedAction != null && !['manual', 'release'].includes(pausedAction)) {
      throw new TestReportError('停调处理方式须为 manual 或 release')
    }
    for (const id of ids) {
      if (!this.vm(id)) throw new TestReportError('vm not found', 404)
      if (policy.enabled) {
        const blocked = this.blocked(id, policy)
        if (blocked) throw new TestReportError(`${this.vm(id).name || id}：${blocked}`)
      } else if ((this.vm(id).test_schedule_hold || this.sync(id).state.hold) && !pausedAction) {
        throw new TestReportError('关闭策略前请选择保持人工关闭，或解除测试停调', 409)
      }
    }
    withTransaction(this.settings.db, () => {
      for (const id of ids) {
        const previous = this.sync(id)
        const state = this.freshState(id, previous.state)
        if (policy.enabled) {
          state.pending = previous.state.pending
          state.error = previous.state.error
        }
        if (!policy.enabled && (state.hold || this.vm(id)?.test_schedule_hold)) {
          state.pending = {
            kind: pausedAction === 'manual' ? 'manual' : 'release',
            expected_token: this.vm(id)?.test_schedule_hold?.token || null,
          }
          state.hold = null
          state.last_action = {
            kind: pausedAction === 'manual' ? 'disable_manual' : 'release',
            at: new Date(this.now()).toISOString(),
            status: 'pending',
          }
        }
        this.settings.set(keyFor(id), { policy, state })
      }
    })
    for (const id of ids) this.applyPending(id)
    return policy
  }

  release(id) {
    const { policy, state: previous } = this.sync(id)
    const state = this.freshState(id, previous)
    state.hold = null
    state.pending = { kind: 'release', expected_token: this.vm(id)?.test_schedule_hold?.token || null }
    state.last_action = { kind: 'release', at: new Date(this.now()).toISOString(), status: 'pending' }
    this.settings.set(keyFor(id), { policy, state })
    this.applyPending(id)
    return this.view(id)
  }

  consume(record, generation) {
    const ignored = (reason) => ({ participating: false, reason, action: null })
    if (record.source !== 'scheduled') return ignored('manual_test')
    const { policy, state } = this.sync(record.vm_id)
    if (!policy.enabled) return ignored('disabled')
    if (generation !== state.generation) return ignored('stale_test')
    if (state.pending) return ignored('action_pending')
    const vm = this.vm(record.vm_id)
    if (vm?.schedule_off || vm?.schedule_manual) return ignored('manual_off')
    if (this.blocked(record.vm_id, policy)) return ignored('not_ready')
    if (record.id <= (state.last_report_id || 0) || record.run_id === state.last_run_id) return ignored('duplicate')
    const outcome = reportOutcome(record)
    let action = null
    let threshold = null
    if (state.hold) {
      state.pause_streak = 0
      state.resume_streak = policy.resume_enabled && outcome === 'pass' ? state.resume_streak + 1 : 0
      if (policy.resume_enabled && state.resume_streak >= policy.resume_after) {
        action = 'resume'
        threshold = policy.resume_after
        state.pending = { kind: 'release', expected_token: state.hold.token }
        state.hold = null
      }
    } else {
      state.resume_streak = 0
      state.pause_streak = policy.pause_on.includes(outcome) ? state.pause_streak + 1 : 0
      if (state.pause_streak >= policy.pause_after) {
        action = 'pause'
        threshold = policy.pause_after
        state.hold = {
          token: randomUUID(),
          at: new Date(this.now()).toISOString(),
          report_id: record.id,
          policy_revision: policy.revision,
          outcome,
          threshold,
        }
        state.pending = { kind: 'hold', expected_token: null }
      }
    }
    const decision = {
      participating: true,
      reason: 'counted',
      outcome,
      pause_streak: state.pause_streak,
      resume_streak: state.resume_streak,
      policy_revision: policy.revision,
      action,
      threshold,
    }
    if (action) {
      state.last_action = {
        kind: action,
        at: new Date(this.now()).toISOString(),
        report_id: record.id,
        outcome,
        threshold,
        status: 'pending',
      }
      state.pause_streak = 0
      state.resume_streak = 0
    }
    state.last_report_id = record.id
    state.last_run_id = record.run_id
    this.settings.set(keyFor(record.vm_id), { policy, state })
    return decision
  }

  applyPending(id) {
    const saved = this.sync(id)
    const { state } = saved
    const intent = state.pending
    if (!intent) return null
    try {
      const current = this.vm(id)
      if (!current) return null
      const token = current.test_schedule_hold?.token || null
      if (token !== intent.expected_token && token !== state.hold?.token) {
        throw new Error('测试停调状态已变化，请刷新后重试')
      }
      const updated = patchVmRecord(this.projectRoot, id, (vm) => {
        if (vmOwnerId(vm) !== state.owner_user_id || (vm.schedule_operator_revision || 0) !== state.operator_revision) {
          throw new Error('槽位归属或人工调度状态已变化，请刷新后重试')
        }
        const liveToken = vm.test_schedule_hold?.token || null
        if (liveToken !== intent.expected_token && liveToken !== state.hold?.token) {
          throw new Error('测试停调状态已变化，请刷新后重试')
        }
        if (intent.kind === 'hold' && (vm.schedule_off || vm.schedule_manual)) {
          throw new Error('槽位已被人工关闭，不再执行自动停调')
        }
        if (intent.kind === 'manual') applyScheduleOff(vm, true)
        else {
          if (intent.kind === 'hold') vm.test_schedule_hold = state.hold
          else delete vm.test_schedule_hold
          deriveScheduleFields(vm)
        }
      })
      if (!updated) throw new Error('槽位已删除')
      state.operator_revision = updated.schedule_operator_revision || 0
      state.pending = null
      state.error = null
      state.last_action.status = 'applied'
    } catch (error) {
      state.error = `调度动作未完成：${error.code || error.message}`.slice(0, 240)
      state.last_action.status = 'failed'
    }
    this.settings.set(keyFor(id), saved)
    return state.last_action
  }

  reconcile() {
    for (const key of Object.keys(this.settings.all())) {
      if (!key.startsWith(PREFIX)) continue
      const id = key.slice(PREFIX.length)
      if (!this.vm(id)) this.remove(id)
      else this.applyPending(id)
    }
  }

  remove(id) {
    this.settings.remove(keyFor(id))
  }
}
