export const REPORT_KEY = ['panel', 'fork-test-reports'] as const
export const REPORT_API = '/api/panel/fork/test-reports'
export type Verdict = 'pass' | 'pending' | 'fail'
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
}
export type HistoryEntry = {
  id: number
  started_at: string
  ok: boolean
  verdict: Verdict
  rule_enabled: boolean
}
export type SlotHistory = {
  vm_id: string
  vm_name: string
  platform: string
  latest: ReportSummary | null
  history: HistoryEntry[]
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
