import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { LogsFilterState } from './search'

export function RequestIdSearch({
  filters,
  onApply,
}: {
  filters: LogsFilterState
  onApply: (filters: LogsFilterState) => void
}) {
  const [requestId, setRequestId] = useState(filters.requestId ?? '')
  const [correlationId, setCorrelationId] = useState(
    filters.correlationId ?? ''
  )
  useEffect(() => {
    setRequestId(filters.requestId ?? '')
    setCorrelationId(filters.correlationId ?? '')
  }, [filters.requestId, filters.correlationId])
  return (
    <form
      className='flex flex-wrap items-center gap-2'
      onSubmit={(event) => {
        event.preventDefault()
        onApply({
          ...filters,
          requestId: requestId.trim() || undefined,
          correlationId: correlationId.trim() || undefined,
        })
      }}
    >
      <Input
        aria-label='执行请求 ID'
        placeholder='执行请求 ID（精确匹配）'
        className='min-w-48 flex-1 font-mono text-xs'
        maxLength={128}
        value={requestId}
        onChange={(event) => setRequestId(event.target.value)}
      />
      <Input
        aria-label='关联请求 ID'
        placeholder='关联请求 ID（new-api，查询全部尝试）'
        className='min-w-48 flex-1 font-mono text-xs'
        maxLength={128}
        value={correlationId}
        onChange={(event) => setCorrelationId(event.target.value)}
      />
      <Button type='submit' variant='outline' size='sm'>
        查询 ID
      </Button>
      <span className='w-full text-xs text-muted-foreground'>
        按 ID 查询包含被屏蔽的错误；其他筛选仍生效。历史日志未采集关联 ID
        时，请使用执行请求 ID。
      </span>
    </form>
  )
}
