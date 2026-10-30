import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { QueryGate } from '@/components/query-gate'
import { REPORT_API, REPORT_KEY, type Rule, type SlotOption } from './types'

export function RuleEditor({
  vmId,
  vms = [],
  onClose,
}: {
  vmId: string
  vms?: SlotOption[]
  onClose: () => void
}) {
  const qc = useQueryClient()
  const loaded = useRef(false)
  const query = useQuery({
    queryKey: [...REPORT_KEY, 'rule', vmId],
    queryFn: ({ signal }) =>
      api<{ rule: Rule }>(
        `${REPORT_API}/rules?vm_id=${encodeURIComponent(vmId)}`,
        { signal }
      ),
    retry: false,
  })
  const [enabled, setEnabled] = useState(false)
  const [contains, setContains] = useState('')
  const [mode, setMode] = useState<Rule['mode']>('all')
  const [unmatched, setUnmatched] = useState<Rule['when_unmatched']>('pending')
  const [copy, setCopy] = useState(false)
  useEffect(() => {
    if (!query.data || loaded.current) return
    loaded.current = true
    const rule = query.data.rule
    setEnabled(rule.enabled)
    setContains(rule.contains.join('\n'))
    setMode(rule.mode)
    setUnmatched(rule.when_unmatched)
  }, [query.data])
  const vm = vms.find((item) => item.id === vmId)
  const sameKind = vms.filter(
    (item) => (item.platform === 'openai') === (vm?.platform === 'openai')
  )
  const save = useMutation({
    mutationFn: () =>
      api<{ updated: number }>(`${REPORT_API}/rules`, {
        method: 'PUT',
        body: JSON.stringify({
          vm_ids: copy ? sameKind.map((item) => item.id) : [vmId],
          rule: {
            enabled,
            mode,
            when_unmatched: unmatched,
            contains: contains
              .split('\n')
              .map((text) => text.trim())
              .filter(Boolean),
          },
        }),
      }),
    onSuccess: (data) => {
      toast.success(`已保存 ${data.updated} 个槽的规则`)
      void qc.invalidateQueries({ queryKey: REPORT_KEY })
      onClose()
    },
    onError: (error: Error) => toast.error(error.message),
  })
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !save.isPending) onClose()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>测试判定规则 · {vm?.name || vmId}</DialogTitle>
          <DialogDescription>
            未启用时，调用成功为绿色、失败为红色。启用后按匹配结果判定，仅影响新的测试。
          </DialogDescription>
        </DialogHeader>
        <QueryGate
          loading={query.isLoading}
          error={query.error}
          skeleton={<p>读取规则…</p>}
        >
          <div className='flex items-center justify-between'>
            <Label htmlFor='test-rule-enabled'>启用字符串规则</Label>
            <Switch
              id='test-rule-enabled'
              checked={enabled}
              onCheckedChange={setEnabled}
            />
          </div>
          {enabled ? (
            <>
              <Label htmlFor='test-rule-contains'>
                预期字符串（每行一条，区分大小写，字面匹配）
              </Label>
              <Textarea
                id='test-rule-contains'
                value={contains}
                onChange={(event) => setContains(event.target.value)}
                rows={6}
                placeholder={'预期答案\n另一个关键片段'}
              />
              <div className='grid grid-cols-2 gap-3'>
                <div className='space-y-2'>
                  <Label>匹配方式</Label>
                  <Select
                    value={mode}
                    onValueChange={(value) => setMode(value as Rule['mode'])}
                  >
                    <SelectTrigger aria-label='匹配方式'>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value='all'>全部包含</SelectItem>
                      <SelectItem value='any'>任意包含</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className='space-y-2'>
                  <Label>未满足时</Label>
                  <Select
                    value={unmatched}
                    onValueChange={(value) =>
                      setUnmatched(value as Rule['when_unmatched'])
                    }
                  >
                    <SelectTrigger aria-label='未满足时'>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value='pending'>待定（推荐）</SelectItem>
                      <SelectItem value='fail'>不通过</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <p className='text-xs text-muted-foreground'>
                回答为空或不完整时为黄色；调用失败为红色，不代表回答质量不合格。
              </p>
            </>
          ) : null}
          {sameKind.length > 1 ? (
            <label className='flex items-start gap-2 text-sm'>
              <Checkbox
                checked={copy}
                onCheckedChange={(value) => setCopy(value === true)}
              />
              <span>
                同时覆盖当前可见的同平台 {sameKind.length}{' '}
                个槽的规则。仅复制规则，不复制测试题，请确认这些槽使用同一道题。
              </span>
            </label>
          ) : null}
        </QueryGate>
        <DialogFooter>
          <Button variant='outline' onClick={onClose} disabled={save.isPending}>
            取消
          </Button>
          <Button
            onClick={() => save.mutate()}
            disabled={
              !query.data ||
              query.isError ||
              save.isPending ||
              (enabled && !contains.trim())
            }
          >
            保存规则
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
