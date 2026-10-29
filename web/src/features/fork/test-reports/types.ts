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
