import { Fragment, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { api } from '@/lib/api'
import { fmtExpiresAt, fmtMs } from '@/lib/format'
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { QueryGate } from '@/components/query-gate'
import { meQueryOptions } from '@/features/auth/queries'
import { ReportDetail } from './record-detail'
import { RuleEditor } from './rule-editor'
import {
  REPORT_API,
  REPORT_KEY,
  REASONS,
  VERDICTS,
  type ReportPage,
  type ReportSummary,
  type SlotOption,
  type Verdict,
} from './types'

function VerdictBadge({ verdict }: { verdict: Verdict }) {
  return (
    <span
      className={
        verdict === 'fail'
          ? 'text-destructive'
          : verdict === 'pass'
            ? 'text-emerald-600 dark:text-emerald-400'
            : 'text-muted-foreground'
      }
    >
      {VERDICTS[verdict]}
    </span>
  )
}

export function ReportList({
  vmId,
  vms = [],
}: {
  vmId?: string
  vms?: SlotOption[]
}) {
  const [slot, setSlot] = useState('all')
  const [source, setSource] = useState('all')
  const [verdict, setVerdict] = useState('all')
  const [model, setModel] = useState('')
  const [offset, setOffset] = useState(0)
  const [selected, setSelected] = useState<number | null>(null)
  const params = new URLSearchParams({ limit: '50', offset: String(offset) })
  if (vmId || slot !== 'all') params.set('vm_id', vmId || slot)
  if (source !== 'all') params.set('source', source)
  if (verdict !== 'all') params.set('verdict', verdict)
  if (model.trim()) params.set('model', model.trim())
  const filter = params.toString()
  const query = useQuery({
    queryKey: [...REPORT_KEY, 'list', filter],
    queryFn: ({ signal }) =>
      api<ReportPage>(`${REPORT_API}?${filter}`, { signal }),
    refetchInterval: 30_000,
    retry: false,
  })
  const update = (setter: (value: string) => void) => (value: string) => {
    setter(value)
    setOffset(0)
    setSelected(null)
  }
  const items = query.data?.items || []
  return (
    <div className='space-y-3'>
      <div className='flex flex-wrap items-center gap-2'>
        {!vmId ? (
          <Select value={slot} onValueChange={update(setSlot)}>
            <SelectTrigger className='w-44' aria-label='筛选槽位'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='all'>全部槽位</SelectItem>
              {vms.map((vm) => (
                <SelectItem key={vm.id} value={vm.id}>
                  {vm.name || vm.id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        <Select value={source} onValueChange={update(setSource)}>
          <SelectTrigger className='w-28' aria-label='测试来源'>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value='all'>全部来源</SelectItem>
            <SelectItem value='scheduled'>定时</SelectItem>
            <SelectItem value='manual'>手动</SelectItem>
          </SelectContent>
        </Select>
        <Select value={verdict} onValueChange={update(setVerdict)}>
          <SelectTrigger className='w-28' aria-label='内容判定'>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value='all'>全部判定</SelectItem>
            {Object.entries(VERDICTS).map(([key, label]) => (
              <SelectItem key={key} value={key}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          className='w-40'
          placeholder='模型 ID（精确匹配）'
          aria-label='筛选模型'
          value={model}
          onChange={(event) => update(setModel)(event.target.value)}
        />
        <Button
          size='sm'
          variant='outline'
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
        >
          <RefreshCw /> 刷新
        </Button>
      </div>
      <QueryGate
        loading={query.isLoading}
        error={query.error}
        skeleton={<p>加载测试记录…</p>}
      >
        {items.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>时间 / 来源</TableHead>
                {!vmId ? <TableHead>槽位</TableHead> : null}
                <TableHead>模型</TableHead>
                <TableHead>执行 / 耗时</TableHead>
                <TableHead>内容判定</TableHead>
                <TableHead>输出摘要</TableHead>
                <TableHead>详情</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <Fragment key={item.id}>
                  <TableRow>
                    <TableCell>
                      <p>{fmtExpiresAt(item.started_at)}</p>
                      <span className='text-xs text-muted-foreground'>
                        {item.source === 'manual' ? '手动' : '定时'}
                      </span>
                    </TableCell>
                    {!vmId ? (
                      <TableCell>
                        <p>{item.vm_name}</p>
                        <span className='text-xs text-muted-foreground'>
                          {item.vm_id}
                        </span>
                      </TableCell>
                    ) : null}
                    <TableCell>{item.model || '—'}</TableCell>
                    <TableCell>
                      <p>{item.ok ? '成功' : '失败'}</p>
                      <span className='text-xs text-muted-foreground'>
                        {fmtMs(item.duration_ms)}
                      </span>
                    </TableCell>
                    <TableCell>
                      <VerdictBadge verdict={item.verdict} />
                      <p className='max-w-48 text-xs whitespace-normal text-muted-foreground'>
                        {REASONS[item.reason]}
                      </p>
                    </TableCell>
                    <TableCell className='max-w-sm min-w-40 break-words whitespace-normal'>
                      <span className='line-clamp-2'>
                        {item.error || item.text_preview || '无可见正文'}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Button
                        size='sm'
                        variant='ghost'
                        aria-label={`查看测试记录 ${item.id}`}
                        onClick={() =>
                          setSelected(selected === item.id ? null : item.id)
                        }
                      >
                        {selected === item.id ? '收起' : '查看'}
                      </Button>
                    </TableCell>
                  </TableRow>
                  {selected === item.id ? (
                    <TableRow>
                      <TableCell
                        colSpan={vmId ? 6 : 7}
                        className='whitespace-normal'
                      >
                        <ReportDetail id={item.id} />
                      </TableCell>
                    </TableRow>
                  ) : null}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className='py-4 text-sm text-muted-foreground'>
            暂无符合条件的测试记录；升级前没有留存的正文不会补采。
          </p>
        )}
        <div className='flex items-center justify-between gap-2 text-xs text-muted-foreground'>
          <span>留存范围内共 {query.data?.total ?? 0} 条 · 每槽最多 30 条</span>
          <div className='flex gap-2'>
            <Button
              size='sm'
              variant='outline'
              disabled={offset === 0}
              onClick={() => {
                setOffset(Math.max(0, offset - 50))
                setSelected(null)
              }}
            >
              上一页
            </Button>
            <Button
              size='sm'
              variant='outline'
              disabled={offset + 50 >= (query.data?.total || 0)}
              onClick={() => {
                setOffset(offset + 50)
                setSelected(null)
              }}
            >
              下一页
            </Button>
          </div>
        </div>
      </QueryGate>
    </div>
  )
}

export function VmTestRunHistory({ vmId }: { vmId: string }) {
  const [edit, setEdit] = useState(false)
  const me = useQuery(meQueryOptions())
  return (
    <section aria-label='测试记录' className='space-y-3'>
      <div className='flex items-center justify-between'>
        <h4 className='text-sm font-medium'>测试记录（定时＋手动）</h4>
        {me.data?.role !== 'super' ? (
          <Button size='sm' variant='outline' onClick={() => setEdit(true)}>
            判定规则
          </Button>
        ) : null}
      </div>
      <ReportList vmId={vmId} />
      {edit ? <RuleEditor vmId={vmId} onClose={() => setEdit(false)} /> : null}
    </section>
  )
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
  const me = useQuery(meQueryOptions())
  const [tab, setTab] = useState('records')
  const [ruleVm, setRuleVm] = useState<string | null>(null)
  const overview = useQuery({
    queryKey: [...REPORT_KEY, 'summary'],
    queryFn: ({ signal }) =>
      api<{
        items: {
          vm_id: string
          vm_name: string
          latest: ReportSummary | null
        }[]
      }>(`${REPORT_API}/summary`, { signal }),
    enabled: open && tab === 'slots',
    refetchInterval: open && tab === 'slots' ? 30_000 : false,
    retry: false,
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-h-[90vh] min-w-0 overflow-x-hidden overflow-y-auto sm:max-w-6xl'>
        <DialogHeader>
          <DialogTitle>测试结果中心</DialogTitle>
          <DialogDescription>
            所有可见槽的定时与手动测试按新到旧显示。内容判定只表示是否符合规则，不等于确认账号降智；本功能不修改调度。时间按浏览器时区显示。
          </DialogDescription>
        </DialogHeader>
        <Tabs className='min-w-0' value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value='records'>全部测试记录</TabsTrigger>
            <TabsTrigger value='slots'>按槽摘要与规则</TabsTrigger>
          </TabsList>
          <TabsContent value='records' className='min-w-0'>
            <ReportList vms={vms} />
          </TabsContent>
          <TabsContent value='slots' className='min-w-0'>
            <QueryGate
              loading={overview.isLoading}
              error={overview.error}
              skeleton={<p>加载槽位摘要…</p>}
            >
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>槽位</TableHead>
                    <TableHead>最新测试</TableHead>
                    <TableHead>执行 / 内容判定</TableHead>
                    <TableHead>输出摘要</TableHead>
                    <TableHead>规则</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(overview.data?.items || []).map((row) => (
                    <TableRow key={row.vm_id}>
                      <TableCell>
                        <p>{row.vm_name}</p>
                        <span className='text-xs text-muted-foreground'>
                          {row.vm_id}
                        </span>
                      </TableCell>
                      <TableCell>
                        {row.latest
                          ? fmtExpiresAt(row.latest.started_at)
                          : '尚无记录'}
                      </TableCell>
                      <TableCell>
                        {row.latest ? (
                          <>
                            {row.latest.ok ? '成功' : '失败'} /{' '}
                            <VerdictBadge verdict={row.latest.verdict} />
                          </>
                        ) : (
                          '—'
                        )}
                      </TableCell>
                      <TableCell className='max-w-sm min-w-40 break-words whitespace-normal'>
                        <span className='line-clamp-2'>
                          {row.latest?.error || row.latest?.text_preview || '—'}
                        </span>
                      </TableCell>
                      <TableCell>
                        {me.data?.role !== 'super' ? (
                          <Button
                            size='sm'
                            variant='outline'
                            aria-label={`配置 ${row.vm_name} 的规则`}
                            onClick={() => setRuleVm(row.vm_id)}
                          >
                            配置规则
                          </Button>
                        ) : (
                          '只读'
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {!overview.data?.items.length ? <p>没有可见槽位。</p> : null}
            </QueryGate>
          </TabsContent>
        </Tabs>
        {ruleVm ? (
          <RuleEditor
            key={ruleVm}
            vmId={ruleVm}
            vms={vms}
            onClose={() => setRuleVm(null)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
