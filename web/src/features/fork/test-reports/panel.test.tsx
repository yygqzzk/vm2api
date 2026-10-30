import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { HistoryBlocks } from './panel'
import { testOutcome, type HistoryEntry } from './types'

const entry: HistoryEntry = {
  id: 1,
  started_at: '2026-10-29T00:00:00Z',
  ok: true,
  verdict: 'pending',
  rule_enabled: false,
}

describe('test history colors', () => {
  it('uses invocation success without a rule, regardless of content verdict', () => {
    expect(testOutcome(entry)).toEqual({ tone: 'pass', label: '调用成功' })
    expect(testOutcome({ ...entry, verdict: 'fail' }).tone).toBe('pass')
    expect(testOutcome({ ...entry, ok: false })).toEqual({
      tone: 'fail',
      label: '调用失败',
    })
  })
  it('uses the captured rule verdict only after a successful invocation', () => {
    for (const verdict of ['pass', 'pending', 'fail'] as const) {
      expect(testOutcome({ ...entry, rule_enabled: true, verdict }).tone).toBe(
        verdict
      )
      expect(
        testOutcome({ ...entry, rule_enabled: true, ok: false, verdict }).tone
      ).toBe('fail')
    }
  })
  it('renders one accessible button per record, preserves order and does not invent empty blocks', () => {
    const html = renderToStaticMarkup(
      <HistoryBlocks
        items={[
          entry,
          { ...entry, id: 2, rule_enabled: true },
          { ...entry, id: 3, ok: false },
        ]}
        onSelect={() => {}}
      />
    )
    expect(html.match(/<button/g)).toHaveLength(3)
    expect(html).toContain('bg-emerald-600')
    expect(html).toContain('bg-amber-400')
    expect(html).toContain('bg-rose-600')
    expect(html.indexOf('调用成功')).toBeLessThan(html.indexOf('待定'))
    expect(html.indexOf('待定')).toBeLessThan(html.indexOf('调用失败'))
    expect(html).toContain('aria-label=')
    expect(html).toContain('从旧到新')
    const empty = renderToStaticMarkup(
      <HistoryBlocks items={[]} onSelect={() => {}} />
    )
    expect(empty).toContain('尚无测试记录')
    expect(empty).not.toContain('<button')
  })
})
