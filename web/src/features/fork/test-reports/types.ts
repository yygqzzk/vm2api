export const REPORT_KEY = ['panel', 'fork-test-reports'] as const
export const REPORT_API = '/api/panel/fork/test-reports'
export type Verdict = 'pass' | 'pending' | 'fail'
export type PauseOutcome = 'pending' | 'fail' | 'error'
export type AutoPolicy = {
  enabled: boolean
  pause_on: PauseOutcome[]
  pause_after: number
  resume_enabled: boolean
  resume_after: number
  revision: string | null
}
export type AutoAction = {
  kind: string
  at: string
  report_id?: number
  threshold?: number
  outcome?: string
  status: 'pending' | 'applied' | 'failed'
}
export type AutoSchedule = {
  policy: AutoPolicy
  pause_streak: number
  resume_streak: number
  paused: boolean
  pending_action: 'hold' | 'release' | 'manual' | null
  hold: { at: string; threshold: number; outcome: string } | null
  blocked_reason: string | null
  last_action: AutoAction | null
  action_error: string | null
}
export type TestScheduleSummary = {
  enabled: boolean
  next_run_at: string | null
  parse_error?: boolean
}
export type AutoDecision = {
  participating: boolean
  reason: string
  outcome?: string
  pause_streak?: number
  resume_streak?: number
  policy_revision?: string
  action: 'pause' | 'resume' | null
  action_status?: 'pending' | 'applied' | 'failed'
  action_error?: string | null
  threshold?: number | null
}
export const PAUSE_OUTCOMES: Record<PauseOutcome, string> = {
  pending: '待定',
  fail: '内容不通过',
  error: '调用失败',
}
export const AUTO_ACTIONS: Record<string, string> = {
  pause: '触发测试停调',
  resume: '解除测试停调',
  release: '人工解除测试停调',
  manual_off: '人工关闭调度',
  manual_on: '人工开启调度，重新观察',
  disable_manual: '停用策略并转人工关闭',
  owner_changed: '归属变更，策略已停用',
}
export const AUTO_REASONS: Record<string, string> = {
  manual_test: '手动测试不参与自动调度',
  disabled: '自动策略未启用',
  stale_test: '测试开始后配置或槽位状态已变化，不参与新策略',
  action_pending: '上一次调度动作尚未完成',
  manual_off: '人工关闭优先，不参与自动开关计数',
  not_ready: '定时测试或判定规则尚未就绪',
  duplicate: '重复结果，不重复计数',
}
export type Rule = {
  enabled: boolean
  contains: string[]
  mode: 'all' | 'any'
  when_unmatched: 'pending' | 'fail'
  revision: string | null
}
export type ReportSummary = {
  id: number
  vm_id: string
  vm_name: string
  platform: string
  source: 'manual' | 'scheduled'
  started_at: string
  model: string
  ok: boolean
  status: number | null
  duration_ms: number
  verdict: Verdict
  reason: string
  text_preview: string | null
  error: string | null
  text_truncated: boolean
  sample_complete: boolean
  stop_reason: string | null
  input_tokens: number | null
  output_tokens: number | null
  cache_read_tokens: number | null
  automation?: AutoDecision
}
export type Report = Omit<ReportSummary, 'text_preview' | 'reason'> & {
  text: string | null
  request: {
    prompt: string
    prompt_truncated: boolean
    max_tokens: number | null
    reasoning_effort: string | null
  }
  rule: Rule
  evaluation: {
    verdict: Verdict
    reason: string
    matched: string[]
    missing: string[]
  }
}
export type ReportPage = {
  items: ReportSummary[]
  total: number
  limit: number
  offset: number
}
export type SlotOption = {
  id: string
  name?: string | null
  platform?: string | null
  auto_paused?: boolean
}
export type HistoryEntry = {
  id: number
  started_at: string
  ok: boolean
  verdict: Verdict
  rule_enabled: boolean
  source?: 'manual' | 'scheduled'
  participating?: boolean
}
export type SlotHistory = {
  vm_id: string
  vm_name: string
  platform: string
  latest: ReportSummary | null
  history: HistoryEntry[]
  scheduling: {
    schedule_state: 'on' | 'off' | 'unschedulable' | 'restricted'
    restriction_reason: string | null
    restriction_text: string | null
    restriction_until: number | null
    unschedulable_text: string | null
    schedule_off: boolean
    schedulable: boolean
    status: string | null
  }
  automatic: AutoSchedule
  test_schedule: TestScheduleSummary
}

// Color summarizes execution first, then the rule captured when this test began.
export function testOutcome(
  item: Pick<HistoryEntry, 'ok' | 'verdict' | 'rule_enabled'>
) {
  if (!item.ok) return { tone: 'fail' as const, label: '调用失败' }
  if (!item.rule_enabled) return { tone: 'pass' as const, label: '调用成功' }
  return {
    tone: item.verdict,
    label:
      item.verdict === 'pass'
        ? '匹配通过'
        : item.verdict === 'fail'
          ? '匹配不通过'
          : '待定',
  }
}

export const VERDICTS: Record<Verdict, string> = {
  pass: '通过',
  pending: '待定',
  fail: '不通过',
}
export const REASONS: Record<string, string> = {
  matched: '符合字符串规则',
  unmatched: '未满足字符串规则',
  no_rule: '未启用规则',
  execution_error: '调用失败，不能判断回答质量',
  incomplete_sample: '样本不完整，不能据此判失败',
  empty_answer: '没有可见正文',
}
