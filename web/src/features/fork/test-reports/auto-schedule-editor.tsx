import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { fmtExpiresAt } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { QueryGate } from '@/components/query-gate'
import {
  PAUSE_OUTCOMES,
  REPORT_API,
  REPORT_KEY,
  type AutoPolicy,
  type AutoSchedule,
  type PauseOutcome,
  type SlotOption,
  type TestScheduleSummary,
} from './types'

type Payload = {
  automatic: AutoSchedule
  rule_enabled: boolean
  test_schedule: TestScheduleSummary
}
const defaults: AutoPolicy = {
  enabled: false,
  pause_on: ['pending'],
  pause_after: 3,
  resume_enabled: true,
  resume_after: 2,
  revision: null,
}

export function policyFormError(
  policy: AutoPolicy,
  targets: number,
  ready: boolean
) {
  if (!targets) return '请选择至少一个槽位'
  if (!policy.pause_on.length) return '请选择至少一个停调条件'
  if (
    ![policy.pause_after, policy.resume_after].every(
      (n) => Number.isSafeInteger(n) && n >= 1
    )
  )
    return '连续次数须为正整数'
  if (policy.enabled && !ready)
    return '请先启用定时测试，并配置所选条件需要的内容判定规则'
  return null
}

export function AutoScheduleEditor({
  vmId,
  vms,
  initialIds,
  onClose,
  onSavingChange,
}: {
  vmId: string
  vms: SlotOption[]
  initialIds?: string[]
  onClose: () => void
  onSavingChange?: (saving: boolean) => void
}) {
  const qc = useQueryClient()
  const base = useRef<AutoPolicy | null>(null)
  const loaded = useRef(false)
  const query = useQuery({
    queryKey: [...REPORT_KEY, 'auto-schedule', vmId],
    queryFn: ({ signal }) =>
      api<Payload>(
        `${REPORT_API}/auto-schedule?vm_id=${encodeURIComponent(vmId)}`,
        { signal }
      ),
    refetchInterval: 30_000,
    staleTime: 0,
    refetchOnMount: 'always',
    retry: false,
  })
  const [policy, setPolicy] = useState<AutoPolicy>(defaults)
  const [targets, setTargets] = useState(initialIds || [vmId])
  const [pausedAction, setPausedAction] = useState<'manual' | 'release' | null>(
    null
  )
  const [confirming, setConfirming] = useState(false)
  const stale =
    loaded.current &&
    !!query.data &&
    base.current?.revision !== query.data.automatic.policy.revision
  const adopt = (value: AutoPolicy) => {
    base.current = value
    setPolicy({ ...value, pause_on: [...value.pause_on] })
    setConfirming(false)
    setPausedAction(null)
  }
  useEffect(() => {
    if (!query.data || query.isFetching || loaded.current) return
    loaded.current = true
    adopt(query.data.automatic.policy)
  }, [query.data, query.isFetching])
  const data = query.data
  const ready =
    !targets.includes(vmId) ||
    !!(
      data?.test_schedule.enabled &&
      (policy.pause_on.includes('error') || data.rule_enabled)
    )
  const error = policyFormError(policy, targets.length, ready)
  const pausedTargets = targets.filter((id) =>
    id === vmId
      ? data?.automatic.paused || data?.automatic.pending_action === 'hold'
      : vms.find((vm) => vm.id === id)?.auto_paused
  )
  const needsPausedChoice = !policy.enabled && pausedTargets.length > 0
  const save = useMutation({
    onMutate: () => onSavingChange?.(true),
    onSettled: () => onSavingChange?.(false),
    mutationFn: () =>
      api<{
        updated: number
        action_errors: { id: string; message: string }[]
      }>(`${REPORT_API}/auto-schedule`, {
        method: 'PUT',
        body: JSON.stringify({
          vm_ids: targets,
          policy,
          paused_action: pausedAction,
        }),
      }),
    onSuccess: (saved) => {
      void qc.invalidateQueries({ queryKey: REPORT_KEY })
      void qc.invalidateQueries({ queryKey: ['panel', 'vms'] })
      void qc.invalidateQueries({ queryKey: ['panel', 'vm'] })
      void qc.invalidateQueries({ queryKey: ['panel', 'dashboard'] })
      if (saved.action_errors.length) {
        toast.warning(
          `策略已保存，但 ${saved.action_errors.length} 个槽位的调度动作未完成：${saved.action_errors[0].message}`
        )
      } else
        toast.success(
          `已保存 ${saved.updated} 个槽位的自动调度策略，从新测试开始计数`
        )
      onClose()
    },
    onError: (reason: Error) => {
      setConfirming(false)
      toast.error(reason.message)
    },
  })
  const busy = save.isPending
  const patch = (change: Partial<AutoPolicy>) => {
    setPolicy((previous) => ({ ...previous, ...change }))
    setConfirming(false)
  }
  return (
    <QueryGate
      loading={query.isLoading || (!loaded.current && query.isFetching)}
      error={query.error}
      skeleton={<p className='text-sm text-muted-foreground'>读取自动策略…</p>}
    >
      <div className='space-y-5'>
        {stale ? (
          <div
            className='rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-700 dark:text-amber-400'
            role='alert'
          >
            此策略已在别处修改，请载入最新配置后继续。
            <Button
              size='sm'
              variant='ghost'
              onClick={() => data && adopt(data.automatic.policy)}
            >
              载入最新
            </Button>
          </div>
        ) : null}
        <div className='flex items-center justify-between gap-3 rounded-xl border bg-muted/30 p-4'>
          <div className='space-y-1'>
            <Label htmlFor='test-auto-enabled'>启用自动调度策略</Label>
            <p className='text-xs text-muted-foreground'>
              仅影响本槽位的新定时测试，默认不接管现有调度。
            </p>
          </div>
          <Switch
            id='test-auto-enabled'
            checked={policy.enabled}
            disabled={busy}
            onCheckedChange={(enabled) => patch({ enabled })}
          />
        </div>
        <fieldset className='space-y-3 rounded-xl border p-4' disabled={busy}>
          <legend className='px-1 text-sm font-medium'>停止调度</legend>
          <div className='flex flex-wrap items-center gap-2 text-sm'>
            <span>当连续</span>
            <Input
              aria-label='停止调度的连续次数'
              className='w-24 tabular-nums'
              type='number'
              min={1}
              step={1}
              value={Number.isNaN(policy.pause_after) ? '' : policy.pause_after}
              onChange={(event) =>
                patch({ pause_after: event.target.valueAsNumber })
              }
            />
            <span>次结果命中以下任一条件</span>
          </div>
          <div className='flex flex-wrap gap-4'>
            {(Object.entries(PAUSE_OUTCOMES) as [PauseOutcome, string][]).map(
              ([value, label]) => (
                <label key={value} className='flex items-center gap-2 text-sm'>
                  <Checkbox
                    checked={policy.pause_on.includes(value)}
                    onCheckedChange={(checked) =>
                      patch({
                        pause_on:
                          checked === true
                            ? [...policy.pause_on, value]
                            : policy.pause_on.filter((item) => item !== value),
                      })
                    }
                  />
                  {label}
                </label>
              )
            )}
          </div>
          <p className='text-xs text-muted-foreground'>
            其他定时结果会中断计数。勾选多个条件时，按命中任意条件的连续次数计数。
          </p>
        </fieldset>
        <div className='space-y-3 rounded-xl border p-4'>
          <div className='flex items-center justify-between'>
            <Label htmlFor='test-auto-resume'>自动恢复</Label>
            <Switch
              id='test-auto-resume'
              checked={policy.resume_enabled}
              disabled={busy}
              onCheckedChange={(resume_enabled) => patch({ resume_enabled })}
            />
          </div>
          <div className='flex flex-wrap items-center gap-2 text-sm'>
            <span>自动停调后，连续</span>
            <Input
              aria-label='恢复调度的连续成功次数'
              className='w-24 tabular-nums'
              type='number'
              min={1}
              step={1}
              disabled={!policy.resume_enabled || busy}
              value={
                Number.isNaN(policy.resume_after) ? '' : policy.resume_after
              }
              onChange={(event) =>
                patch({ resume_after: event.target.valueAsNumber })
              }
            />
            <span>次成功后解除测试停调</span>
          </div>
          <p className='text-xs text-muted-foreground'>
            成功与绿色色块一致：有判定规则时须匹配通过；未启用规则时按调用成功判断。不会解除人工关闭、凭证故障或其他限制。
          </p>
        </div>
        <div className='space-y-2 rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground'>
          <p>仅定时测试参与 · 连续计数 · 手动测试不推进也不打断计数</p>
          <p>
            {data?.test_schedule.enabled
              ? `下次测试：${data.test_schedule.next_run_at ? fmtExpiresAt(data.test_schedule.next_run_at) : '等待计划'}`
              : '当前尚未启用定时测试，请先到槽位的“测试”页保存并启用计划。'}
          </p>
          <p>
            保存后重新计数，不追溯历史；已触发的停调不会因为修改配置而自动放行。真实复测会消耗账号额度。
          </p>
        </div>
        {vms.length > 1 ? (
          <fieldset disabled={busy} className='space-y-2'>
            <legend className='mb-2 text-sm font-medium'>
              应用槽位 · 已选 {targets.length} 个
            </legend>
            <div className='grid max-h-40 gap-2 overflow-y-auto rounded-lg border p-3 sm:grid-cols-2'>
              {vms.map((vm) => (
                <label
                  key={vm.id}
                  className='flex min-w-0 items-center gap-2 text-sm'
                >
                  <Checkbox
                    checked={targets.includes(vm.id)}
                    onCheckedChange={(checked) => {
                      setTargets((previous) =>
                        checked === true
                          ? [...previous, vm.id]
                          : previous.filter((id) => id !== vm.id)
                      )
                      setConfirming(false)
                    }}
                  />
                  <span className='truncate' title={vm.id}>
                    {vm.name || vm.id}
                    {vm.id === vmId ? '（当前）' : ''}
                  </span>
                </label>
              ))}
            </div>
            <p className='text-xs text-muted-foreground'>
              只复制自动策略，不复制题目、模型、测试时间、运行计数或人工关闭状态。每个目标须满足启用前置条件，否则全部不保存。
            </p>
          </fieldset>
        ) : null}
        {needsPausedChoice ? (
          <fieldset
            disabled={busy}
            className='space-y-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3'
          >
            <legend className='px-1 text-sm font-medium'>
              停用策略时，有 {pausedTargets.length} 个槽位已停调或等待调度动作
            </legend>
            <label className='flex items-center gap-2 text-sm'>
              <input
                type='radio'
                name='auto-disable-action'
                checked={pausedAction === 'manual'}
                onChange={() => setPausedAction('manual')}
              />
              保持关闭，转为人工关闭
            </label>
            <label className='flex items-center gap-2 text-sm'>
              <input
                type='radio'
                name='auto-disable-action'
                checked={pausedAction === 'release'}
                onChange={() => setPausedAction('release')}
              />
              只解除测试停调，保留其他限制
            </label>
          </fieldset>
        ) : null}
        {confirming ? (
          <div
            className='space-y-2 rounded-lg border border-amber-500/30 p-3 text-sm'
            role='alert'
          >
            <p>即将覆盖 {targets.length} 个槽位的自动策略并重新计数：</p>
            <p className='text-xs break-words text-muted-foreground'>
              {targets
                .map((id) => vms.find((vm) => vm.id === id)?.name || id)
                .join('、')}
            </p>
            <p>
              {policy.enabled
                ? `连续 ${policy.pause_after} 次${policy.pause_on.map((value) => PAUSE_OUTCOMES[value]).join('或')}停调；${policy.resume_enabled ? `连续成功 ${policy.resume_after} 次恢复` : '仅人工恢复'}。`
                : '停用后不再自动处理新的测试。'}
            </p>
          </div>
        ) : null}
        {error ? (
          <p
            className='text-sm text-amber-700 dark:text-amber-400'
            role='status'
          >
            {error}
          </p>
        ) : null}
        <div className='flex justify-end gap-2 border-t pt-4'>
          <Button variant='outline' onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button
            loading={busy}
            disabled={
              !data || !!error || stale || (needsPausedChoice && !pausedAction)
            }
            onClick={() => {
              if (targets.length > 1 && !confirming) setConfirming(true)
              else save.mutate()
            }}
          >
            {confirming ? '确认覆盖并保存' : '保存策略'}
          </Button>
        </div>
      </div>
    </QueryGate>
  )
}
