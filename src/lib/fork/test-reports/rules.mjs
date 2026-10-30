import { randomUUID } from 'node:crypto'

export class TestReportError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.status = status
  }
}

export const DEFAULT_RULE = Object.freeze({
  enabled: false,
  contains: [],
  mode: 'all',
  when_unmatched: 'pending',
  revision: null,
})

export function normalizeRule(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TestReportError('规则必须是对象')
  if (typeof input.enabled !== 'boolean') throw new TestReportError('enabled 必须是布尔值')
  if (!['all', 'any'].includes(input.mode)) throw new TestReportError('mode 必须是 all 或 any')
  if (!['pending', 'fail'].includes(input.when_unmatched)) throw new TestReportError('未命中结果必须是 pending 或 fail')
  if (!Array.isArray(input.contains) || input.contains.length > 20) throw new TestReportError('最多配置 20 个字符串')
  if (input.contains.some((text) => typeof text !== 'string' || !text.trim() || text.length > 500)) {
    throw new TestReportError('每个字符串须为 1–500 字符，不能为空')
  }
  const contains = [...new Set(input.contains.map((text) => text.trim()))]
  if (input.enabled && !contains.length) throw new TestReportError('启用规则至少需要一个字符串')
  return {
    enabled: input.enabled,
    contains,
    mode: input.mode,
    when_unmatched: input.when_unmatched,
    revision: randomUUID(),
  }
}

// Only visible answer text is eligible; thinking, tools and serialized error objects are not answers.
export function answerSample(result) {
  const body = result?.body
  let text
  if (Array.isArray(body?.content)) {
    text = body.content
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n')
  } else if (typeof body?.output_text === 'string') text = body.output_text
  else if (Array.isArray(body?.output)) {
    text = body.output
      .filter((part) => part?.type === 'message')
      .flatMap((part) => part.content || [])
      .filter((part) => part?.type === 'output_text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n')
  }
  const fromBody = typeof text === 'string'
  if (!fromBody) text = typeof result?.text === 'string' ? result.text : ''
  // The Responses SSE collector may synthesize body.status='completed' without a terminal event.
  const stop = result?.stop_reason
  const complete =
    result?.ok === true &&
    ['end_turn', 'stop', 'stop_sequence', 'completed'].includes(stop) &&
    (fromBody || text.length < 4000)
  return { text, complete }
}

export function evaluateRule(rule, sample, executionOk) {
  let reason
  if (!executionOk) reason = 'execution_error'
  else if (!rule.enabled) reason = 'no_rule'
  else if (!sample.complete) reason = 'incomplete_sample'
  else if (!sample.text.trim()) reason = 'empty_answer'
  if (reason) return { verdict: 'pending', reason, matched: [], missing: [] }
  const matched = rule.contains.filter((text) => sample.text.includes(text))
  const missing = rule.contains.filter((text) => !sample.text.includes(text))
  const pass = rule.mode === 'all' ? missing.length === 0 : matched.length > 0
  return { verdict: pass ? 'pass' : rule.when_unmatched, reason: pass ? 'matched' : 'unmatched', matched, missing }
}
