import { useEffect, useRef, useState } from 'react'
import type { Vm } from '@/types/panel-vm'
import type RFB from '@novnc/novnc'
import { Monitor, Square } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { copyText } from '@/lib/clipboard'
import { apiBase } from '@/lib/session'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { ConfirmDialog } from '@/components/confirm-dialog'
import type { CommitResult } from '@/features/vm/credential-panel'
import { useVmPerms } from '@/features/vm/vm-perms'
import {
  browserDisconnectMessage,
  browserSocketUrl,
  type BrowserStatus,
} from './slot-browser'

export function SlotBrowserButton({
  vm,
  authUrl,
  codexSessionId,
  onAuthorized,
  disabled = false,
}: {
  vm: Vm
  authUrl?: string
  codexSessionId?: string
  onAuthorized?: (result: CommitResult) => void | Promise<void>
  disabled?: boolean
}) {
  const perms = useVmPerms()
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<BrowserStatus | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)
  const generation = useRef(0)
  const supported = vm.runtime?.type !== 'kvm' && vm.runtime?.type !== 'native'

  useEffect(
    () => () => {
      generation.current += 1
    },
    []
  )

  async function start() {
    const current = ++generation.current
    setOpen(true)
    setBusy(true)
    setStatus(null)
    setNote('正在启动独立浏览器，请稍候…')
    try {
      const result = await api<BrowserStatus>(
        `/api/panel/vms/${encodeURIComponent(vm.id)}/browser/start`,
        {
          method: 'POST',
          body: JSON.stringify({
            auth_url: authUrl,
            oauth_session_id: codexSessionId,
          }),
        }
      )
      if (generation.current !== current) return
      setStatus(result)
      setNote('')
    } catch (error) {
      if (generation.current === current) setNote((error as Error).message)
    } finally {
      if (generation.current === current) setBusy(false)
    }
  }

  async function resetProfile() {
    generation.current += 1
    setBusy(true)
    try {
      await api(
        `/api/panel/vms/${encodeURIComponent(vm.id)}/browser/reset-profile`,
        {
          method: 'POST',
          body: JSON.stringify({ confirm_vm_id: vm.id }),
        }
      )
      setConfirmReset(false)
      changeOpen(false)
      toast.success('已清空该槽浏览器登录态，API 凭证未改变')
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function stopBrowser() {
    const current = ++generation.current
    setBusy(true)
    try {
      await api(`/api/panel/vms/${encodeURIComponent(vm.id)}/browser/stop`, {
        method: 'POST',
        body: '{}',
      })
      if (generation.current === current) {
        changeOpen(false)
        toast.success('浏览器已停止，资料已保留')
      }
    } catch (error) {
      if (generation.current === current) toast.error((error as Error).message)
    } finally {
      if (generation.current === current) setBusy(false)
    }
  }

  function changeOpen(value: boolean) {
    if (!value) {
      generation.current += 1
      setStatus(null)
      setBusy(false)
    }
    setOpen(value)
  }

  if (!perms.credential || !supported) return null
  return (
    <>
      <Button
        type='button'
        size='sm'
        variant='outline'
        disabled={disabled || busy}
        onClick={() => void start()}
      >
        <Monitor className='size-3.5' aria-hidden='true' />
        {authUrl ? '在槽位浏览器中授权' : '打开槽位浏览器'}
      </Button>
      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogContent className='flex h-[94dvh] max-w-[96vw] flex-col gap-3 transition-none sm:max-w-[1400px]'>
          <DialogHeader>
            <DialogTitle className='pe-6'>
              槽位浏览器 · {vm.name || vm.id}
            </DialogTitle>
            <DialogDescription>
              每槽独立保存浏览器身份和网站资料，重新打开恢复上次标签页。
              语言、时区跟随槽位。关闭画面后闲置 5
              分钟停止；手动停止也保留资料。
              {authUrl ? ' 网页登录不等于完成槽位授权。' : ''}
            </DialogDescription>
            <div className='flex flex-wrap gap-2'>
              <Button
                type='button'
                size='sm'
                variant='outline'
                onClick={() => changeOpen(false)}
              >
                关闭画面
              </Button>
              <Button
                type='button'
                size='sm'
                variant='outline'
                disabled={busy}
                onClick={() => void stopBrowser()}
              >
                <Square className='size-3.5' aria-hidden='true' />
                {busy ? '正在处理…' : '停止浏览器并保存'}
              </Button>
              {perms.admin ? (
                <Button
                  type='button'
                  size='sm'
                  variant='ghost'
                  disabled={busy}
                  onClick={() => setConfirmReset(true)}
                >
                  重置浏览器登录态
                </Button>
              ) : null}
            </div>
          </DialogHeader>
          {note ? (
            <p role='status' className='text-sm'>
              {note}
            </p>
          ) : null}
          {status && open ? (
            <BrowserView
              key={status.session_id}
              vmId={vm.id}
              status={status}
              codexSessionId={codexSessionId}
              onAuthorized={onAuthorized}
              onStopped={() => changeOpen(false)}
            />
          ) : !busy ? (
            <Button
              type='button'
              variant='outline'
              onClick={() => void start()}
            >
              重试启动
            </Button>
          ) : null}
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={confirmReset}
        onOpenChange={setConfirmReset}
        title='清空该槽浏览器登录态？'
        desc='将停止浏览器并删除该槽的 Cookie、网站存储、书签、历史、标签页及下载文件，保留浏览器指纹身份。槽位属主或机器身份已改变时会同时清除旧指纹。无法撤销；不会修改槽位 API 凭证。'
        destructive
        isLoading={busy}
        confirmText='确认清空'
        cancelBtnText='取消'
        handleConfirm={() => void resetProfile()}
      />
    </>
  )
}

function BrowserView({
  vmId,
  status,
  codexSessionId,
  onAuthorized,
  onStopped,
}: {
  vmId: string
  status: BrowserStatus
  codexSessionId?: string
  onAuthorized?: (result: CommitResult) => void | Promise<void>
  onStopped: () => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const connection = useRef<RFB | null>(null)
  const [phase, setPhase] = useState('正在连接画面…')
  const [connected, setConnected] = useState(false)
  const [restartRequired, setRestartRequired] = useState(false)
  const [environmentWarning, setEnvironmentWarning] = useState(
    status.environment_warning || ''
  )
  const [reconnect, setReconnect] = useState(0)
  const [clipboard, setClipboard] = useState('')
  const [remoteClipboard, setRemoteClipboard] = useState('')
  const [oauthNote, setOauthNote] = useState('')
  const [oauthFailed, setOauthFailed] = useState(false)
  const [retry, setRetry] = useState(0)
  const authorized = useRef(onAuthorized)
  authorized.current = onAuthorized
  const root = `/api/panel/vms/${encodeURIComponent(vmId)}`

  useEffect(() => {
    let disposed = false
    let disconnected = false
    let environmentChanged = false
    let rfb: RFB | null = null
    async function connect() {
      const [{ ticket }, { default: Client }] = await Promise.all([
        api<{ ticket: string }>(`${root}/browser/ticket`, {
          method: 'POST',
          body: '{}',
        }),
        import('@novnc/novnc'),
      ])
      if (disposed || !host.current) return
      const socket = new WebSocket(
        browserSocketUrl(apiBase() || '', window.location.href, vmId, ticket)
      )
      socket.addEventListener('close', (event) => {
        environmentChanged = event.code === 4001
      })
      rfb = new Client(host.current, socket)
      connection.current = rfb
      rfb.scaleViewport = true
      rfb.resizeSession = false
      rfb.qualityLevel = 6
      rfb.compressionLevel = 2
      rfb.addEventListener('connect', () => {
        if (!disposed) {
          setConnected(true)
          setRestartRequired(false)
          setPhase('已连接')
          rfb?.focus()
        }
      })
      rfb.addEventListener('disconnect', () => {
        disconnected = true
        if (!disposed) {
          setConnected(false)
          setRestartRequired(environmentChanged)
          setPhase(browserDisconnectMessage(environmentChanged))
        }
      })
      rfb.addEventListener('securityfailure', () => {
        if (!disposed) {
          setConnected(false)
          setPhase('画面连接被拒绝，请重新打开浏览器')
        }
      })
      rfb.addEventListener('clipboard', (event) => {
        const text = (event as CustomEvent<{ text: string }>).detail.text
        if (!disposed && text.length <= 65536) setRemoteClipboard(text)
      })
    }
    void connect().catch((error: Error) => {
      if (!disposed) setPhase(error.message)
    })
    return () => {
      disposed = true
      connection.current = null
      if (!disconnected) rfb?.disconnect()
    }
  }, [root, vmId, reconnect])

  useEffect(() => {
    if (!connected) return
    let disposed = false
    let pending = false
    const timer = setInterval(() => {
      if (pending) return
      pending = true
      void api<BrowserStatus>(`${root}/browser`)
        .then((data) => {
          if (!disposed) setEnvironmentWarning(data.environment_warning || '')
        })
        .catch(() => {
          if (!disposed)
            setEnvironmentWarning('无法读取出口复核状态，请检查控制面连接。')
        })
        .finally(() => {
          pending = false
        })
    }, 10_000)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [connected, root])

  useEffect(() => {
    if (!codexSessionId || restartRequired) return
    let disposed = false
    let pending = false
    let attempted = false
    async function poll() {
      if (pending || attempted || disposed) return
      pending = true
      try {
        const result = await api<{ callback_url: string | null }>(
          `${root}/browser/callback?session_id=${encodeURIComponent(codexSessionId!)}`
        )
        if (!result.callback_url || disposed) return
        attempted = true
        setOauthNote('已收到回调，正在写入该槽凭证…')
        const committed = await api<CommitResult>(
          `${root}/oauth/exchange-code`,
          {
            method: 'POST',
            body: JSON.stringify({
              session_id: codexSessionId,
              code: result.callback_url,
              flavor: 'codex',
            }),
          }
        )
        if (disposed) return
        setOauthNote('授权已写入该槽凭证')
        await authorized.current?.(committed)
        toast.success('已完成 Codex OAuth')
      } catch (error) {
        attempted = true
        if (!disposed) {
          setOauthNote((error as Error).message)
          setOauthFailed(true)
        }
      } finally {
        pending = false
      }
    }
    const timer = setInterval(() => void poll(), 1500)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [root, codexSessionId, retry, restartRequired])

  return (
    <>
      <div className='flex flex-wrap items-center gap-2 text-xs'>
        <span>
          {status.egress === 'local'
            ? '本地出口：网站会看到节点公网 IP'
            : `槽位代理：${status.proxy_id}`}
        </span>
        <span>
          时区 {status.timezone} · 语言 {status.language} · 屏幕 {status.screen}
        </span>
        {status.identity ? <span>环境标识 {status.identity}</span> : null}
        <span role='status'>{phase}</span>
        {restartRequired ? (
          <Button type='button' size='sm' variant='outline' onClick={onStopped}>
            关闭窗口后重开
          </Button>
        ) : !connected ? (
          <Button
            type='button'
            size='sm'
            variant='outline'
            onClick={() => setReconnect((value) => value + 1)}
          >
            重连画面
          </Button>
        ) : null}
      </div>
      {environmentWarning ? (
        <p role='alert' className='text-sm text-amber-600'>
          {environmentWarning}
        </p>
      ) : null}
      <div
        ref={host}
        aria-label='远端槽位浏览器画面'
        className='min-h-48 min-w-0 flex-1 overflow-hidden rounded border bg-black'
      />
      {codexSessionId ? (
        <div className='flex flex-wrap items-center gap-2 text-xs'>
          <p role='status'>
            {oauthNote || '完成网页授权后，回调将自动交给该槽现有换票流程。'}
          </p>
          {oauthFailed ? (
            <Button
              type='button'
              size='sm'
              variant='ghost'
              onClick={() => {
                setOauthNote('')
                setOauthFailed(false)
                setRetry((value) => value + 1)
              }}
            >
              重新检查回调
            </Button>
          ) : null}
        </div>
      ) : null}
      <details className='text-xs'>
        <summary className='cursor-pointer'>
          剪贴板 / 中文输入 / 取回授权码
        </summary>
        <div className='mt-2 space-y-2'>
          <Label htmlFor={`browser-clipboard-${vmId}`}>
            发送到远端剪贴板（发送后在浏览器内按 Ctrl+V）
          </Label>
          <Textarea
            id={`browser-clipboard-${vmId}`}
            rows={2}
            value={clipboard}
            maxLength={65536}
            autoComplete='off'
            spellCheck={false}
            onChange={(event) => setClipboard(event.target.value)}
          />
          <div className='flex flex-wrap gap-2'>
            <Button
              type='button'
              size='sm'
              variant='outline'
              disabled={!connected || !clipboard}
              onClick={() => {
                connection.current?.clipboardPasteFrom(clipboard)
                setClipboard('')
                connection.current?.focus()
              }}
            >
              发送剪贴板
            </Button>
            <Button
              type='button'
              size='sm'
              variant='outline'
              disabled={!remoteClipboard}
              onClick={() => {
                void copyText(remoteClipboard).then((ok) => {
                  if (ok) {
                    setRemoteClipboard('')
                    toast.success('已复制远端剪贴板')
                  } else toast.error('复制失败，请在远端浏览器中重试复制')
                })
              }}
            >
              复制远端剪贴板到本机
            </Button>
          </div>
          <p>
            剪贴板只在明确操作时传递，不记录密码、输入或画面。Chrome 内可用
            Ctrl+L 切换地址。
          </p>
        </div>
      </details>
    </>
  )
}
