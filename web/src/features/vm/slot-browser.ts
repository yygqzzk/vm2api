export type BrowserStatus = {
  running: boolean
  session_id: string
  timezone: string
  language: string
  screen: string
  proxy_id: string
  egress: 'local' | 'socks5'
  environment_warning?: string
}

export function browserDisconnectMessage(environmentChanged: boolean) {
  return environmentChanged
    ? '代理出口、时区或槽位权限已改变，旧浏览器已停止。请关闭后重新打开；登录态已保留，授权流程请重新生成链接。'
    : '画面已断开，可重连或停止浏览器'
}

export function browserSocketUrl(
  base: string,
  location: string,
  vmId: string,
  ticket: string
) {
  const url = new URL(
    `${base}/api/panel/vms/${encodeURIComponent(vmId)}/browser/socket`,
    location
  )
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('ticket', ticket)
  return url.href
}
