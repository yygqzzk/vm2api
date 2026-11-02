import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { RefreshCw, Settings2 } from 'lucide-react'
import { api } from '@/lib/api'
import { fmtExpiresAt } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
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
import { AutoScheduleEditor } from './auto-schedule-editor'
import { ReportDetail } from './record-detail'
import { RuleEditor } from './rule-editor'
import { ScheduleActions } from './schedule-actions'
import {
  AutoScheduleProgress,
  ScheduleBadge,
  slotScheduleStatus,
} from './schedule-status'
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
      aria-label='测试历史，左新右旧'
    >
      {items.map((item) => {
        const outcome = testOutcome(item)
        const source =
          item.source === 'manual'
            ? '手动 · 不参与自动调度'
            : item.source === 'scheduled'
              ? `定时 · ${item.participating ? '参与策略计数' : '未参与策略计数'}`
              : ''
        const label = `${fmtExpiresAt(item.started_at)} · ${outcome.label}${source ? ` · ${source}` : ''}`
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
  const [filter, setFilter] = useState('all')
  const [checked, setChecked] = useState<string[]>([])
  const [batchOpen, setBatchOpen] = useState(false)
  const [batchSaving, setBatchSaving] = useState(false)
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
  const canConfigure = me.data?.role === 'admin' || me.data?.role === 'user'
  const canSchedule =
    !!me.data && ['admin', 'user', 'super'].includes(me.data.role)
  const visible = items.filter(
    (row) =>
      `${row.vm_name} ${row.vm_id}`.toLowerCase().includes(needle) &&
      (filter === 'all' ||
        slotScheduleStatus(row).key === filter ||
        (filter === 'unconfigured' && !row.automatic.policy.enabled))
  )
  const options: SlotOption[] = items.map((row) => ({
    id: row.vm_id,
    name: row.vm_name,
    platform: row.platform,
    auto_paused:
      row.automatic.paused || row.automatic.pending_action === 'hold',
  }))
  const targetIds = checked.filter((id) =>
    items.some((row) => row.vm_id === id)
  )
  return (
    <section aria-label='测试记录' className='min-w-0 space-y-4'>
      <div
        className={cn(
          'flex flex-wrap items-center justify-between gap-3',
          !vmId && 'sticky top-0 z-10 bg-background/95 py-2 backdrop-blur-sm'
        )}
      >
        {!vmId ? (
          <div className='flex w-full flex-wrap items-center gap-2 sm:w-auto'>
            <Input
              className='w-full sm:w-56'
              placeholder='搜索槽位名称或 ID'
              aria-label='搜索槽位'
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <Select value={filter} onValueChange={setFilter}>
              <SelectTrigger className='w-36' aria-label='按调度状态筛选'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='all'>全部状态</SelectItem>
                <SelectItem value='on'>调度中</SelectItem>
                <SelectItem value='automatic'>自动停调</SelectItem>
                <SelectItem value='manual'>人工关闭</SelectItem>
                <SelectItem value='blocked'>不可调度</SelectItem>
                <SelectItem value='restricted'>其他受限</SelectItem>
                <SelectItem value='unconfigured'>策略未启用</SelectItem>
              </SelectContent>
            </Select>
          </div>
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
        {!vmId ? (
          <div className='flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground'>
            <p>
              全部 {items.length} · 自动停调{' '}
              {items.filter((row) => row.automatic.paused).length} · 人工关闭{' '}
              {
                items.filter((row) => slotScheduleStatus(row).key === 'manual')
                  .length
              }{' '}
              · 策略未启用{' '}
              {items.filter((row) => !row.automatic.policy.enabled).length}
            </p>
            {canConfigure ? (
              <div className='flex flex-wrap items-center gap-3'>
                <label className='flex items-center gap-2'>
                  <Checkbox
                    aria-label='选择当前筛选的所有槽位'
                    checked={
                      visible.length > 0 &&
                      visible.every((row) => targetIds.includes(row.vm_id))
                    }
                    onCheckedChange={(value) =>
                      setChecked((previous) =>
                        value === true
                          ? [
                              ...new Set([
                                ...previous,
                                ...visible.map((row) => row.vm_id),
                              ]),
                            ]
                          : previous.filter(
                              (id) => !visible.some((row) => row.vm_id === id)
                            )
                      )
                    }
                  />
                  选择当前结果
                </label>
                <Button
                  size='sm'
                  variant='outline'
                  disabled={!targetIds.length}
                  onClick={() => setBatchOpen(true)}
                >
                  批量配置{targetIds.length ? `（${targetIds.length}）` : ''}
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
        <div className='divide-y rounded-xl border bg-card'>
          {visible.map((row) => (
            <div
              key={row.vm_id}
              className={cn(
                'min-w-0 px-4 py-4 sm:px-5',
                row.automatic.paused && 'bg-amber-500/[0.025]'
              )}
            >
              <div className='flex flex-col justify-between gap-3 sm:flex-row sm:items-start'>
                <div className='min-w-0'>
                  <div className='flex flex-wrap items-center gap-2'>
                    {!vmId && canConfigure ? (
                      <Checkbox
                        aria-label={`选择 ${row.vm_name}`}
                        checked={targetIds.includes(row.vm_id)}
                        onCheckedChange={(value) =>
                          setChecked((previous) =>
                            value === true
                              ? [...previous, row.vm_id]
                              : previous.filter((id) => id !== row.vm_id)
                          )
                        }
                      />
                    ) : null}
                    <p
                      className='max-w-64 truncate text-sm font-semibold'
                      title={row.vm_id}
                    >
                      {row.vm_name}
                    </p>
                    <ScheduleBadge row={row} />
                  </div>
                  <p className='mt-1 truncate text-xs text-muted-foreground'>
                    {row.latest?.model ||
                      (row.platform === 'openai' ? 'Codex' : 'Claude')}{' '}
                    ·{' '}
                    {row.latest
                      ? fmtExpiresAt(row.latest.started_at)
                      : '尚未测试'}
                  </p>
                </div>
                <div className='flex flex-wrap items-center gap-2'>
                  {canSchedule ? <ScheduleActions row={row} /> : null}
                  {canConfigure ? (
                    <Button
                      size='sm'
                      variant='ghost'
                      aria-label={`配置 ${row.vm_name} 的规则`}
                      onClick={() => setRuleVm(row.vm_id)}
                    >
                      <Settings2 className='size-4' />
                      规则设置
                    </Button>
                  ) : null}
                </div>
              </div>
              <HistoryBlocks items={row.history} onSelect={setSelected} />
              <AutoScheduleProgress row={row} />
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
          每槽最近 30 次 · 左新右旧 · 点击色块查看详情 · 每 30 秒刷新 ·
          自动策略仅统计定时测试
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
          vms={options.length ? options : vms}
          onClose={() => setRuleVm(null)}
        />
      ) : null}
      {batchOpen && targetIds[0] ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !batchSaving) setBatchOpen(false)
          }}
        >
          <DialogContent className='max-h-[90vh] overflow-y-auto sm:max-w-2xl'>
            <DialogHeader>
              <DialogTitle>批量配置自动调度</DialogTitle>
              <DialogDescription>
                以{' '}
                {options.find((vm) => vm.id === targetIds[0])?.name ||
                  targetIds[0]}{' '}
                的策略为起点；仅复制配置，不复制运行状态。
              </DialogDescription>
            </DialogHeader>
            <AutoScheduleEditor
              vmId={targetIds[0]}
              vms={options}
              initialIds={targetIds}
              onClose={() => setBatchOpen(false)}
              onSavingChange={setBatchSaving}
            />
          </DialogContent>
        </Dialog>
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
          <DialogTitle>测试结果中心</DialogTitle>
          <DialogDescription>
            查看近期测试、快捷控制调度并配置自动策略。一块代表一次测试，最新结果在左侧。
          </DialogDescription>
        </DialogHeader>
        {open ? <HistoryPanel vms={vms} /> : null}
      </DialogContent>
    </Dialog>
  )
}
