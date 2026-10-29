import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { RefreshCw, Settings2 } from 'lucide-react'
import { api } from '@/lib/api'
import { fmtExpiresAt } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { QueryGate } from '@/components/query-gate'
import { meQueryOptions } from '@/features/auth/queries'
import { ReportDetail } from './record-detail'
import { RuleEditor } from './rule-editor'
import {
  REPORT_API,
  REPORT_KEY,
  testOutcome,
  type HistoryEntry,
  type SlotHistory,
  type SlotOption,
} from './types'

const colors = {
  pass: 'bg-emerald-600 text-white dark:bg-emerald-500 dark:text-emerald-950',
  pending: 'bg-amber-400 text-amber-950 dark:bg-amber-400',
  fail: 'bg-rose-600 text-white dark:bg-rose-500 dark:text-rose-950',
}
const symbols = { pass: '✓', pending: '−', fail: '!' }

export function HistoryBlocks({
  items,
  onSelect,
}: {
  items: HistoryEntry[]
  onSelect: (id: number) => void
}) {
  if (!items.length)
    return <p className='py-2 text-sm text-muted-foreground'>尚无测试记录</p>
  return (
    <div
      className='flex gap-1 overflow-x-auto py-2'
      aria-label='测试历史，从旧到新'
    >
      {items.map((item) => {
        const outcome = testOutcome(item)
        const label = `${fmtExpiresAt(item.started_at)} · ${outcome.label}`
        return (
          <Tooltip key={item.id}>
            <TooltipTrigger asChild>
              <button
                type='button'
                aria-label={label}
                onClick={() => onSelect(item.id)}
                className={cn(
                  'flex h-8 w-6 shrink-0 items-center justify-center rounded-md text-xs font-semibold transition hover:-translate-y-0.5 hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                  colors[outcome.tone]
                )}
              >
                <span aria-hidden='true'>{symbols[outcome.tone]}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent>{label}</TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )
}

function HistoryPanel({
  vmId,
  vms = [],
}: {
  vmId?: string
  vms?: SlotOption[]
}) {
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<number | null>(null)
  const [ruleVm, setRuleVm] = useState<string | null>(null)
  const me = useQuery(meQueryOptions())
  const query = useQuery({
    queryKey: [...REPORT_KEY, 'summary', vmId || 'all'],
    queryFn: ({ signal }) =>
      api<{ items: SlotHistory[] }>(
        `${REPORT_API}/summary${vmId ? `?vm_id=${encodeURIComponent(vmId)}` : ''}`,
        { signal }
      ),
    refetchInterval: 30_000,
    retry: false,
  })
  const items = query.data?.items || []
  const needle = search.trim().toLowerCase()
  const visible = items.filter((row) =>
    `${row.vm_name} ${row.vm_id}`.toLowerCase().includes(needle)
  )
  return (
    <section aria-label='测试记录' className='min-w-0 space-y-4'>
      <div className='flex flex-wrap items-center justify-between gap-3'>
        {!vmId ? (
          <Input
            className='w-full sm:w-64'
            placeholder='搜索槽位名称或 ID'
            aria-label='搜索槽位'
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        ) : (
          <h4 className='text-sm font-medium'>最近测试</h4>
        )}
        <div className='flex items-center gap-4 text-xs text-muted-foreground'>
          <span>
            <span className='text-emerald-600'>✓</span> 成功 / 通过
          </span>
          <span>
            <span className='text-amber-600'>−</span> 待定
          </span>
          <span>
            <span className='text-rose-600'>!</span> 失败 / 不通过
          </span>
          <Button
            size='icon'
            variant='ghost'
            aria-label='刷新测试记录'
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            <RefreshCw className={query.isFetching ? 'animate-spin' : ''} />
          </Button>
        </div>
      </div>
      <QueryGate
        loading={query.isLoading}
        error={query.error}
        skeleton={
          <p className='py-8 text-sm text-muted-foreground'>加载测试记录…</p>
        }
      >
        <div className='divide-y rounded-xl border'>
          {visible.map((row) => (
            <div key={row.vm_id} className='min-w-0 px-4 py-4 sm:px-5'>
              <div className='flex items-start justify-between gap-3'>
                <div className='min-w-0'>
                  <p className='truncate text-sm font-medium'>{row.vm_name}</p>
                  <p className='mt-1 truncate text-xs text-muted-foreground'>
                    {row.latest?.model ||
                      (row.platform === 'openai' ? 'Codex' : 'Claude')}
                  </p>
                </div>
                <div className='flex shrink-0 items-center gap-2'>
                  <span className='text-xs text-muted-foreground'>
                    {row.latest
                      ? fmtExpiresAt(row.latest.started_at)
                      : '尚未测试'}
                  </span>
                  {me.data && me.data.role !== 'super' ? (
                    <Button
                      size='icon'
                      variant='ghost'
                      aria-label={`配置 ${row.vm_name} 的规则`}
                      title='判定规则'
                      onClick={() => setRuleVm(row.vm_id)}
                    >
                      <Settings2 className='size-4' />
                    </Button>
                  ) : null}
                </div>
              </div>
              <HistoryBlocks items={row.history} onSelect={setSelected} />
            </div>
          ))}
          {!visible.length ? (
            <div className='px-5 py-12 text-center text-sm text-muted-foreground'>
              {items.length
                ? '没有匹配的槽位'
                : '暂无可见槽位。槽位执行手动或定时测试后，记录会显示在这里。'}
            </div>
          ) : null}
        </div>
        <p className='text-xs text-muted-foreground'>
          每槽最近 30 次 · 左旧右新 · 点击色块查看详情 · 每 30 秒刷新
        </p>
      </QueryGate>
      <Sheet
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null)
        }}
      >
        <SheetContent className='w-full overflow-y-auto sm:max-w-xl'>
          <SheetHeader>
            <SheetTitle>测试详情</SheetTitle>
            <SheetDescription>
              展示本次调用及当时规则的判定结果。
            </SheetDescription>
          </SheetHeader>
          <div className='min-w-0 px-4 pb-6'>
            {selected !== null ? (
              <ReportDetail key={selected} id={selected} />
            ) : null}
          </div>
        </SheetContent>
      </Sheet>
      {ruleVm ? (
        <RuleEditor
          key={ruleVm}
          vmId={ruleVm}
          vms={
            vms.length
              ? vms
              : items.map((row) => ({
                  id: row.vm_id,
                  name: row.vm_name,
                  platform: row.platform,
                }))
          }
          onClose={() => setRuleVm(null)}
        />
      ) : null}
    </section>
  )
}

export function VmTestRunHistory({ vmId }: { vmId: string }) {
  return <HistoryPanel vmId={vmId} />
}

export function VmTestResultsDialog({
  open,
  onOpenChange,
  vms,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  vms: SlotOption[]
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-h-[90vh] min-w-0 overflow-x-hidden overflow-y-auto sm:max-w-5xl'>
        <DialogHeader>
          <DialogTitle>测试结果</DialogTitle>
          <DialogDescription>
            所有槽位的近期测试，一块代表一次。未启用规则时，绿色仅表示调用成功。
          </DialogDescription>
        </DialogHeader>
        {open ? <HistoryPanel vms={vms} /> : null}
      </DialogContent>
    </Dialog>
  )
}
