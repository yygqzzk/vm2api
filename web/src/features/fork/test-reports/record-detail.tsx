import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { fmtExpiresAt, fmtMs } from '@/lib/format'
import { QueryGate } from '@/components/query-gate'
import {
  REPORT_API,
  REPORT_KEY,
  REASONS,
  VERDICTS,
  testOutcome,
  type Report,
} from './types'

export function ReportBody({ item }: { item: Report }) {
  const outcome = testOutcome({ ...item, rule_enabled: item.rule.enabled })
  return (
    <div className='space-y-3 rounded-md border p-3 text-sm'>
      <p className='font-medium'>
        {item.vm_name} · {item.model} · {fmtExpiresAt(item.started_at)}
      </p>
      <p className='font-medium'>
        {outcome.label} · {fmtMs(item.duration_ms)}
      </p>
      <p className='text-xs text-muted-foreground'>
        调用{item.ok ? '成功' : '失败'}
        {item.rule.enabled
          ? ` · 内容${VERDICTS[item.verdict]} · ${REASONS[item.evaluation.reason]}`
          : ' · 本次未启用匹配规则，仅判断调用是否成功'}
      </p>
      {item.error ? (
        <p className='break-words text-destructive'>{item.error}</p>
      ) : null}
      {item.text ? (
        <pre className='max-h-64 overflow-auto rounded bg-muted p-3 font-sans break-words whitespace-pre-wrap'>
          {item.text}
        </pre>
      ) : (
        <p className='text-muted-foreground'>未返回可见正文</p>
      )}
      {item.text_truncated ? (
        <p className='text-xs text-muted-foreground'>
          展示正文仅留存前 2000 字符；规则已在展示截断前评估。
        </p>
      ) : null}
      {item.evaluation.matched.length ? (
        <p className='break-words'>
          命中：{item.evaluation.matched.join('、')}
        </p>
      ) : null}
      {item.evaluation.missing.length ? (
        <p className='break-words'>
          未命中：{item.evaluation.missing.join('、')}
        </p>
      ) : null}
      <details>
        <summary className='cursor-pointer'>
          调用指标、测试参数与规则快照
        </summary>
        <p className='mt-2 text-xs text-muted-foreground'>
          HTTP {item.status ?? '—'} · stop: {item.stop_reason || '—'} · 输入{' '}
          {item.input_tokens ?? '—'} / 输出 {item.output_tokens ?? '—'} /
          缓存读取 {item.cache_read_tokens ?? '—'}
        </p>
        <p className='mt-2 text-xs text-muted-foreground'>
          来源：{item.source === 'scheduled' ? '定时' : '手动'} · token 上限{' '}
          {item.request.max_tokens ?? '—'} · effort{' '}
          {item.request.reasoning_effort || '—'}
        </p>
        <pre className='mt-2 max-h-40 overflow-auto break-words whitespace-pre-wrap'>
          {item.request.prompt || '（使用测试默认 Prompt）'}
        </pre>
        {item.request.prompt_truncated ? (
          <p className='text-xs text-muted-foreground'>
            Prompt 快照仅留存前 16000 字符，已截断。
          </p>
        ) : null}
        <p>
          规则：
          {item.rule.enabled
            ? item.rule.mode === 'all'
              ? '全部包含'
              : '任意包含'
            : '未启用'}
          ；未满足时{VERDICTS[item.rule.when_unmatched]}
        </p>
        {item.rule.contains.length ? (
          <ul className='list-inside list-disc break-words'>
            {item.rule.contains.map((text) => (
              <li key={text}>{text}</li>
            ))}
          </ul>
        ) : null}
        <p className='text-xs text-muted-foreground'>
          规则版本：{item.rule.revision || '无'}
          。这是该次执行的快照，不随当前规则变化。
        </p>
      </details>
    </div>
  )
}

export function ReportDetail({ id }: { id: number }) {
  const query = useQuery({
    queryKey: [...REPORT_KEY, 'detail', id],
    queryFn: ({ signal }) =>
      api<{ item: Report }>(`${REPORT_API}/${id}`, { signal }),
    retry: false,
  })
  return (
    <QueryGate
      loading={query.isLoading}
      error={query.error}
      skeleton={<p>加载记录…</p>}
    >
      {query.data ? <ReportBody item={query.data.item} /> : null}
    </QueryGate>
  )
}
