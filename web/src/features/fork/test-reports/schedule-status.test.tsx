import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { policyFormError } from './auto-schedule-editor'
import {
  AutoScheduleProgress,
  ScheduleBadge,
  slotScheduleStatus,
} from './schedule-status'
import type { SlotHistory } from './types'

const row: SlotHistory = {
  vm_id: 'vm-01',
  vm_name: 'One',
  platform: 'anthropic',
  latest: null,
  history: [],
  scheduling: {
    schedule_state: 'on',
    restriction_reason: null,
    restriction_text: null,
    restriction_until: null,
    unschedulable_text: null,
    schedule_off: false,
    schedulable: true,
    status: 'running',
  },
  automatic: {
    policy: {
      enabled: true,
      pause_on: ['pending'],
      pause_after: 3,
      resume_enabled: true,
      resume_after: 2,
      revision: 'one',
    },
    pause_streak: 2,
    resume_streak: 0,
    paused: false,
    pending_action: null,
    hold: null,
    blocked_reason: null,
    last_action: null,
    action_error: null,
  },
  test_schedule: { enabled: true, next_run_at: '2026-11-02T10:00:00Z' },
}

describe('test scheduling presentation', () => {
  it('shows exact remaining pause and recovery counts, separate from the 30 history blocks', () => {
    const watching = renderToStaticMarkup(<AutoScheduleProgress row={row} />)
    expect(watching).toContain('连续待定 2/3')
    expect(watching).toContain('再出现 1 次将停调')
    expect(watching).toContain('下次测试')
    expect(watching).toContain('aria-valuenow="2"')
    const paused = {
      ...row,
      automatic: {
        ...row.automatic,
        paused: true,
        hold: { at: '2026-11-02T09:00:00Z', threshold: 3, outcome: 'pending' },
        resume_streak: 1,
      },
    }
    const recovery = renderToStaticMarkup(<AutoScheduleProgress row={paused} />)
    expect(recovery).toContain('连续成功 1/2')
    expect(recovery).toContain('再成功 1 次解除测试停调')
    expect(renderToStaticMarkup(<ScheduleBadge row={paused} />)).toContain(
      '自动停调'
    )
  })
  it('does not present manual disable, dead credentials, quota, or a stopped runtime as ready', () => {
    const manual = {
      ...row,
      scheduling: { ...row.scheduling, schedule_off: true },
    }
    expect(slotScheduleStatus(manual).key).toBe('manual')
    expect(
      renderToStaticMarkup(<AutoScheduleProgress row={manual} />)
    ).toContain('人工关闭优先')
    expect(
      slotScheduleStatus({
        ...row,
        scheduling: {
          ...row.scheduling,
          schedule_state: 'unschedulable',
          unschedulable_text: '凭证失效',
        },
      }).label
    ).toBe('凭证失效')
    expect(
      slotScheduleStatus({
        ...row,
        scheduling: {
          ...row.scheduling,
          schedule_state: 'restricted',
          restriction_text: '5h 限制',
        },
      }).label
    ).toBe('5h 限制')
    expect(
      slotScheduleStatus({
        ...row,
        scheduling: { ...row.scheduling, status: 'stopped' },
      }).key
    ).toBe('offline')
  })
  it('shows blocked testing and action failures instead of a false recovery promise', () => {
    const html = renderToStaticMarkup(
      <AutoScheduleProgress
        row={{
          ...row,
          automatic: {
            ...row.automatic,
            blocked_reason: '请先启用定时测试',
            action_error: '调度动作未完成',
            last_action: {
              kind: 'pause',
              at: '2026-11-02T09:00:00Z',
              status: 'failed',
            },
          },
        }}
      />
    )
    expect(html).toContain('请先启用定时测试')
    expect(html).toContain('调度动作未完成')
    expect(html).toContain('执行失败')
    expect(html).not.toContain('role="progressbar"')
  })
  it('validates empty targets, thresholds, stop outcomes, and testing prerequisites', () => {
    const p = row.automatic.policy
    expect(policyFormError(p, 1, true)).toBeNull()
    expect(policyFormError(p, 0, true)).toContain('槽位')
    expect(policyFormError({ ...p, pause_after: 0 }, 1, true)).toContain(
      '正整数'
    )
    expect(policyFormError({ ...p, resume_after: NaN }, 1, true)).toContain(
      '正整数'
    )
    expect(policyFormError({ ...p, pause_on: [] }, 1, true)).toContain('条件')
    expect(policyFormError(p, 1, false)).toContain('定时测试')
    expect(policyFormError({ ...p, enabled: false }, 1, false)).toBeNull()
  })
})
