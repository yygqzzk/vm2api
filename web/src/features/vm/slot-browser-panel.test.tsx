import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { meQueryOptions } from '@/features/auth/queries'
import { browserDisconnectMessage, browserSocketUrl } from './slot-browser'
import { SlotBrowserButton } from './slot-browser-panel'

function markup(role: 'admin' | 'user' | 'super', runtime = 'docker') {
  const client = new QueryClient()
  client.setQueryData(meQueryOptions().queryKey, { role, user: 'test' })
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <SlotBrowserButton vm={{ id: 'vm-test', runtime: { type: runtime } }} />
    </QueryClientProvider>
  )
}

describe('slot browser entry', () => {
  it('explains an environment invalidation without suggesting an old-socket reconnect', () => {
    expect(browserDisconnectMessage(true)).toContain('旧浏览器已停止')
    expect(browserDisconnectMessage(true)).toContain('登录态已保留')
    expect(browserDisconnectMessage(true)).toContain('重新生成链接')
    expect(browserDisconnectMessage(false)).toContain('重连')
  })
  it('is available only to credential operators on supported runtimes', () => {
    expect(markup('admin')).toContain('打开槽位浏览器')
    expect(markup('user')).toContain('打开槽位浏览器')
    expect(markup('super')).not.toContain('打开槽位浏览器')
    expect(markup('admin', 'kvm')).not.toContain('打开槽位浏览器')
    expect(markup('admin', 'native')).not.toContain('打开槽位浏览器')
  })
  it('uses WSS with the configured API origin and only a short-lived ticket', () => {
    const url = new URL(
      browserSocketUrl(
        'https://api.example.com',
        'https://panel.example.com/vm',
        'vm-a',
        'one-use'
      )
    )
    expect(url.protocol).toBe('wss:')
    expect(url.host).toBe('api.example.com')
    expect(url.pathname).toBe('/api/panel/vms/vm-a/browser/socket')
    expect([...url.searchParams]).toEqual([['ticket', 'one-use']])
    expect(
      browserSocketUrl('', 'http://localhost:5173/console/', 'vm-a', 'test')
    ).toContain('ws://localhost:5173/')
  })
})
