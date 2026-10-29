import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ReportBody } from './record-detail'
import type { Report } from './types'

const report: Report = {
  id: 1,
  vm_id: 'vm-01',
  vm_name: 'GPT 测试槽',
  platform: 'openai',
  source: 'manual',
  started_at: '2026-10-29T00:00:00.000Z',
  model: 'gpt-test',
  ok: true,
  status: 200,
  duration_ms: 20,
  verdict: 'pass',
  text: '<script>not executed</script>',
  text_truncated: true,
  sample_complete: true,
  error: null,
  stop_reason: 'completed',
  input_tokens: 0,
  output_tokens: 3,
  cache_read_tokens: null,
  request: {
    prompt: 'original question',
    prompt_truncated: true,
    max_tokens: null,
    reasoning_effort: 'high',
  },
  rule: {
    enabled: true,
    contains: ['expected answer'],
    mode: 'all',
    when_unmatched: 'pending',
    revision: 'original-rule-version',
  },
  evaluation: {
    verdict: 'pass',
    reason: 'matched',
    matched: ['expected answer'],
    missing: [],
  },
}

describe('test report detail', () => {
  it('renders escaped output and immutable request/rule evidence separately from execution success', () => {
    const html = renderToStaticMarkup(<ReportBody item={report} />)
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
    expect(html).toContain('调用成功')
    expect(html).toContain('内容通过')
    expect(html).toContain('original question')
    expect(html).toContain('original-rule-version')
    expect(html).toContain('命中：expected answer')
    expect(html).toContain('展示截断前评估')
    expect(html).toContain('Prompt 快照仅留存前 16000 字符，已截断')
    expect(html).toContain('输入 0 / 输出 3 / 缓存读取 —')
  })
  it('displays a failed content assertion without falsely showing a transport error', () => {
    const html = renderToStaticMarkup(
      <ReportBody
        item={{
          ...report,
          verdict: 'fail',
          evaluation: {
            verdict: 'fail',
            reason: 'unmatched',
            matched: [],
            missing: ['expected answer'],
          },
        }}
      />
    )
    expect(html).toContain('调用成功')
    expect(html).toContain('内容不通过')
    expect(html).toContain('未命中：expected answer')
  })
  it('does not equate incomplete output or network errors with degraded account ability', () => {
    const html = renderToStaticMarkup(
      <ReportBody
        item={{
          ...report,
          ok: false,
          status: 0,
          verdict: 'pending',
          text: null,
          text_truncated: false,
          sample_complete: false,
          error: 'timeout',
          evaluation: {
            verdict: 'pending',
            reason: 'execution_error',
            matched: [],
            missing: [],
          },
        }}
      />
    )
    expect(html).toContain('调用失败')
    expect(html).toContain('内容待定')
    expect(html).toContain('不能判断回答质量')
    expect(html).toContain('timeout')
    expect(html).not.toContain('确认降智')
  })
})
