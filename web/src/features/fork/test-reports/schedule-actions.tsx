import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Pause, Play } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { dashboardQueryOptions } from '@/features/overview/queries'
import { vmQueryOptions, vmsListQueryOptions } from '@/features/vm/queries'
import { REPORT_API, REPORT_KEY, type SlotHistory } from './types'

export function ScheduleActions({ row }: { row: SlotHistory }) {
  const qc = useQueryClient()
  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: REPORT_KEY }),
      qc.invalidateQueries({ queryKey: vmsListQueryOptions().queryKey }),
      qc.invalidateQueries({ queryKey: vmQueryOptions(row.vm_id).queryKey }),
      qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
    ])
  }
  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      api<{ schedulable: boolean }>(
        `/api/panel/vms/${encodeURIComponent(row.vm_id)}/schedulable`,
        {
          method: 'POST',
          body: JSON.stringify({ schedulable: enabled }),
        }
      ),
    onSuccess: async (data, enabled) => {
      toast.success(
        !enabled
          ? '已人工关闭调度；在途请求不会被中断'
          : data.schedulable
            ? '已开启调度，从零观察新测试'
            : '已开启人工调度，当前仍有其他限制'
      )
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const release = useMutation({
    mutationFn: () =>
      api(`${REPORT_API}/auto-schedule/release`, {
        method: 'POST',
        body: JSON.stringify({ vm_id: row.vm_id }),
      }),
    onSuccess: async () => {
      toast.success('已解除测试停调；人工关闭、凭证和其他限制保持不变')
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const busy = toggle.isPending || release.isPending
  const manualOff =
    row.scheduling.schedule_off || row.scheduling.schedule_state === 'off'
  return (
    <div className='flex flex-wrap items-center gap-2'>
      {row.automatic.paused && !manualOff ? (
        <>
          <Button
            size='sm'
            variant='outline'
            disabled={busy}
            loading={release.isPending}
            onClick={() => release.mutate()}
            aria-label={`解除 ${row.vm_name} 的测试停调`}
          >
            <Play />
            解除停调
          </Button>
          <Button
            size='sm'
            variant='ghost'
            disabled={busy}
            loading={toggle.isPending}
            onClick={() => toggle.mutate(false)}
            aria-label={`将 ${row.vm_name} 转为人工关闭`}
          >
            转人工关闭
          </Button>
        </>
      ) : (
        <Button
          size='sm'
          variant='outline'
          disabled={busy}
          loading={toggle.isPending}
          onClick={() =>
            toggle.mutate(
              manualOff || row.scheduling.schedule_state === 'unschedulable'
            )
          }
          aria-label={`${manualOff || row.scheduling.schedule_state === 'unschedulable' ? '开启' : '关闭'} ${row.vm_name} 的调度`}
        >
          {manualOff || row.scheduling.schedule_state === 'unschedulable' ? (
            <>
              <Play />
              开启调度
            </>
          ) : (
            <>
              <Pause />
              关闭调度
            </>
          )}
        </Button>
      )}
    </div>
  )
}
