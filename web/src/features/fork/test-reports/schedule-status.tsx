import { Pause, Play, ShieldCheck } from 'lucide-react'
import { fmtExpiresAt } from '@/lib/format'
import { cn } from '@/lib/utils'
import { AUTO_ACTIONS, PAUSE_OUTCOMES, type SlotHistory } from './types'

export function slotScheduleStatus(row: SlotHistory) {
  const s = row.scheduling
  if (s.schedule_off || s.schedule_state === 'off')
    return { key: 'manual', label: '人工关闭', tone: 'muted' }
  if (s.schedule_state === 'unschedulable')
    return {
      key: 'blocked',
      label: s.unschedulable_text || '不可调度',
      tone: 'bad',
    }
  if (row.automatic.paused)
    return { key: 'automatic', label: '自动停调', tone: 'warn' }
  if (s.schedule_state === 'restricted')
    return {
      key: 'restricted',
      label: s.restriction_text || '当前受限',
      tone: 'warn',
    }
  if (s.status && !['running', 'paused'].includes(s.status))
    return { key: 'offline', label: '槽位未运行', tone: 'muted' }
  return { key: 'on', label: '调度中', tone: 'good' }
}

export function ScheduleBadge({ row }: { row: SlotHistory }) {
  const status = slotScheduleStatus(row)
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium',
        status.tone === 'good' &&
          'border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
        status.tone === 'warn' &&
          'border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-400',
        status.tone === 'bad' &&
          'border-rose-500/20 bg-rose-500/10 text-rose-700 dark:text-rose-400',
        status.tone === 'muted' && 'bg-muted text-muted-foreground'
      )}
    >
      {status.key === 'on' ? (
        <ShieldCheck className='size-3' />
      ) : (
        <Pause className='size-3' />
      )}
      {status.label}
    </span>
  )
}

export function AutoScheduleProgress({ row }: { row: SlotHistory }) {
  const { automatic: auto, test_schedule: schedule } = row
  const status = slotScheduleStatus(row)
  const policy = auto.policy
  const conditions = policy.pause_on
    .map((value) => PAUSE_OUTCOMES[value])
    .join(' / ')
  const count = auto.paused ? auto.resume_streak : auto.pause_streak
  const target = auto.paused ? policy.resume_after : policy.pause_after
  const progress = Math.min(100, (count / target) * 100)
  return (
    <div className='mt-2 space-y-2 border-t border-dashed pt-3 text-xs text-muted-foreground'>
      <div className='flex flex-wrap items-center justify-between gap-x-4 gap-y-2'>
        <p className='flex flex-wrap items-center gap-x-2 gap-y-1'>
          {auto.paused ? (
            <Pause className='size-3.5 text-amber-600' />
          ) : (
            <Play className='size-3.5' />
          )}
          <span>{policy.enabled ? '自动策略已启用' : '自动策略未启用'}</span>
          {policy.enabled ? (
            <span>
              连续 {policy.pause_after} 次{conditions}停调 ·{' '}
              {policy.resume_enabled
                ? `成功 ${policy.resume_after} 次恢复`
                : '仅人工恢复'}
            </span>
          ) : null}
        </p>
        <span className='shrink-0 tabular-nums'>
          {schedule.enabled && !schedule.parse_error
            ? `下次测试：${schedule.next_run_at ? fmtExpiresAt(schedule.next_run_at) : '等待计划'}`
            : '定时测试未启用'}
        </span>
      </div>
      {status.key === 'manual' ? (
        <p>人工关闭优先，自动策略不会恢复；重新开启后从零观察。</p>
      ) : auto.blocked_reason ? (
        <p className='text-amber-700 dark:text-amber-400' role='status'>
          {auto.blocked_reason}
        </p>
      ) : auto.paused ? (
        <div className='flex flex-wrap items-center gap-3'>
          <span className='text-amber-700 dark:text-amber-400'>
            停调原因：连续 {auto.hold?.threshold ?? policy.pause_after} 次
            {PAUSE_OUTCOMES[
              auto.hold?.outcome as keyof typeof PAUSE_OUTCOMES
            ] || '异常结果'}
          </span>
          <span className='font-medium text-foreground'>
            {policy.resume_enabled && policy.enabled
              ? `连续成功 ${count}/${target} · 再成功 ${Math.max(0, target - count)} 次解除测试停调`
              : '保持停调，等待人工解除'}
          </span>
        </div>
      ) : policy.enabled ? (
        <div className='flex flex-wrap items-center gap-3'>
          <span
            className={cn(
              'font-medium',
              count > 0
                ? 'text-amber-700 dark:text-amber-400'
                : 'text-foreground'
            )}
          >
            连续{conditions} {count}/{target}
            {count > 0
              ? ` · 再出现 ${Math.max(0, target - count)} 次将停调`
              : ' · 观察中'}
          </span>
        </div>
      ) : null}
      {policy.enabled &&
      status.key !== 'manual' &&
      !auto.blocked_reason &&
      (!auto.paused || policy.resume_enabled) ? (
        <div
          className='h-1 w-full max-w-64 overflow-hidden rounded-full bg-muted'
          role='progressbar'
          aria-label={auto.paused ? '自动恢复进度' : '自动停调进度'}
          aria-valuenow={count}
          aria-valuemin={0}
          aria-valuemax={target}
        >
          <div
            className={cn(
              'h-full rounded-full transition-[width]',
              auto.paused ? 'bg-emerald-500' : 'bg-amber-500'
            )}
            style={{ width: `${progress}%` }}
          />
        </div>
      ) : null}
      {auto.action_error ? (
        <p className='text-destructive' role='alert'>
          {auto.action_error}。下次测试或服务重启会重试，也可人工接管。
        </p>
      ) : null}
      {auto.last_action ? (
        <p>
          最近动作：
          {AUTO_ACTIONS[auto.last_action.kind] || auto.last_action.kind} ·{' '}
          {fmtExpiresAt(auto.last_action.at)}
          {auto.last_action.status === 'failed'
            ? ' · 执行失败'
            : auto.last_action.status === 'pending'
              ? ' · 等待执行'
              : ''}
        </p>
      ) : null}
    </div>
  )
}
