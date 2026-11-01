// Optional real UI/RFB acceptance using an already installed Playwright and Chrome.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { browserFixture, waitForReport } from './smoke_slot_browser.mjs'
import { createSlotBrowser, BROWSER_PATH } from '../../src/lib/fork/slot-browser/service.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(import.meta.url)
const webRequire = createRequire(path.join(root, 'web/package.json'))
const { createServer } = await import(webRequire.resolve('vite'))
const { default: react } = await import(webRequire.resolve('@vitejs/plugin-react'))
const { default: tailwindcss } = await import(webRequire.resolve('@tailwindcss/vite'))
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')
const output = path.join(root, '.local/slot-browser-test')
fs.mkdirSync(output, { recursive: true, mode: 0o700 })
const fixture = await browserFixture()
const vm = fixture.vms[0]
const service = createSlotBrowser({
  readVm: (id) => fixture.vms.find((entry) => entry.id === id),
  principalFor: () => ({ key: 'offline-acceptance', valid: () => true }),
  runtime: fixture.runtime,
})
let browser,
  vite,
  server,
  exchanges = 0
const state = 'offline-codex-state-0123456789'
const inner = new URL('https://auth.openai.com/oauth/authorize')
inner.searchParams.set('state', state)
const auth = new URL('https://chatgpt.com/codex/desktop-auth')
auth.searchParams.set('authorize_url', inner.href)
const generated = {
  flavor: 'codex',
  session_id: 'offline-codex',
  auth_url: auth.href,
  expires_at: Date.now() + 600_000,
}
service.recordAuthorization(vm.id, generated)

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
  return true
}
async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString() || '{}')
}

try {
  vite = await createServer({
    configFile: false,
    root,
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.join(root, 'web/src'),
        react: path.join(root, 'web/node_modules/react'),
        'react-dom': path.join(root, 'web/node_modules/react-dom'),
        '@tanstack/react-query': path.join(root, 'web/node_modules/@tanstack/react-query'),
        sonner: path.join(root, 'web/node_modules/sonner'),
      },
    },
    server: { middlewareMode: true },
    appType: 'custom',
  })
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local')
    req.panelUser = 'acceptance'
    req.panelRole = 'user'
    req.panelUserId = 'acceptance-user'
    try {
      if (url.pathname === '/favicon.ico') {
        res.writeHead(204)
        return res.end()
      }
      if (url.pathname === '/api/panel/me')
        return json(res, 200, { ok: true, data: { user: 'acceptance', role: 'user' } })
      if (BROWSER_PATH.test(url.pathname)) return await service.handle(req, res, url, { json, readBody })
      if (url.pathname.endsWith('/oauth/exchange-code')) {
        const body = await readBody(req)
        assert.equal(body.session_id, generated.session_id)
        assert.equal(new URL(body.code).searchParams.get('state'), state)
        exchanges += 1
        return json(res, 200, { ok: true, data: { oauth_email: 'synthetic@example.test' } })
      }
      if (url.pathname === '/browser-preview') {
        const codex = url.searchParams.has('codex')
        const data = {
          vm,
          authUrl: codex ? auth.href : 'https://example.invalid/',
          codexSessionId: codex ? generated.session_id : undefined,
        }
        const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="application/json" id="fixture-data">${JSON.stringify(data).replaceAll('<', '\\u003c')}</script><script type="module" src="/test/fixtures/slot-browser-preview.tsx"></script></body></html>`
        res.writeHead(200, { 'content-type': 'text/html' })
        return res.end(await vite.transformIndexHtml(url.pathname, html))
      }
      vite.middlewares(req, res)
    } catch (error) {
      json(res, 500, { ok: false, error: { message: error.message } })
    }
  })
  server.on('upgrade', (req, socket, head) => service.handleUpgrade(req, socket, head))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await page.goto(`${origin}/browser-preview`)
  await page.getByRole('button', { name: '在槽位浏览器中授权' }).click()
  await page.getByText('已连接', { exact: true }).waitFor({ timeout: 45_000 })
  fixture.navigate(vm, 'http://browser.test/?slot=ui-acceptance')
  const initial = await waitForReport(fixture, (report) => report.slot === 'ui-acceptance')
  const canvas = page.locator('canvas')
  await canvas.focus()
  await page.keyboard.type('browser-input-123')
  await page.keyboard.press('Tab')
  await page.keyboard.press('Enter')
  const clicked = await waitForReport(fixture, (report) => report.slot === 'ui-acceptance' && report.clicked)
  assert.equal(clicked.report.input, 'browser-input-123')
  const box = await canvas.boundingBox()
  assert.ok(box?.width > 0)
  await page.mouse.click(
    box.x + (initial.report.button.x * box.width) / 1280,
    box.y + (initial.report.button.y * box.height) / 800,
  )
  await waitForReport(fixture, (report) => report.slot === 'ui-acceptance' && report.clicks >= 2)

  await page.getByText('剪贴板 / 中文输入 / 取回授权码', { exact: true }).click()
  await page.getByLabel('发送到远端剪贴板（发送后在浏览器内按 Ctrl+V）').fill('中文测试')
  await page.getByRole('button', { name: '发送剪贴板', exact: true }).click()
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Control+v')
  await page.keyboard.press('Tab')
  await page.keyboard.press('Enter')
  await waitForReport(fixture, (report) => report.input === '中文测试')
  await page.screenshot({ path: path.join(output, 'browser-desktop.png') })
  await page.getByText('剪贴板 / 中文输入 / 取回授权码', { exact: true }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  const bounds = await page.getByRole('dialog').boundingBox()
  console.log(
    'mobile dialog bounds:',
    JSON.stringify(bounds),
    await page.getByRole('dialog').evaluate((element) => {
      const style = getComputedStyle(element)
      return JSON.stringify({
        height: style.height,
        minHeight: style.minHeight,
        maxHeight: style.maxHeight,
        width: style.width,
        maxWidth: style.maxWidth,
        viewport: [innerWidth, innerHeight],
        classes: element.className,
      })
    }),
  )
  assert.ok(
    bounds.y >= 0 && bounds.y + bounds.height <= 845,
    'mobile dialog must keep its header and close control visible',
  )
  await page.screenshot({ path: path.join(output, 'browser-mobile.png') })
  const simulatedChange = { method: 'PUT' }
  await service.beforeProxyMutation(simulatedChange, { proxyId: vm.proxy.id })
  service.afterMutation(simulatedChange)
  await page.getByText(/旧浏览器已停止/).waitFor({ timeout: 10_000 })
  await page.getByRole('button', { name: '关闭窗口后重开', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden', timeout: 20_000 })
  console.log(
    'PASS: actual panel component, ticketed WebSocket/RFB path, native keyboard/mouse, Chinese clipboard and mobile layout',
  )

  await page.setViewportSize({ width: 1440, height: 1100 })
  await page.goto(`${origin}/browser-preview?codex=1`)
  await page.getByRole('button', { name: '在槽位浏览器中授权' }).click()
  await page.getByText('已连接', { exact: true }).waitFor({ timeout: 45_000 })
  fixture.exec(
    vm,
    `import urllib.request; print(urllib.request.urlopen('http://localhost:1455/auth/callback?code=offline-code&state=${state}').status)`,
  )
  await page.getByText('Acceptance OAuth imported', { exact: true }).waitFor({ timeout: 15_000 })
  assert.equal(exchanges, 1)
  assert.deepEqual(errors, [])
  console.log(
    'PASS: loopback callback reaches only its slot and existing exchange endpoint, without a real provider request',
  )
} catch (error) {
  if (browser) {
    const page = browser.contexts()[0]?.pages()[0]
    if (page) {
      await page.screenshot({ path: path.join(output, 'browser-failure.png') })
      console.error((await page.locator('body').innerText()).slice(0, 4000))
    }
  }
  throw error
} finally {
  await browser?.close()
  await service.close()
  await vite?.close()
  if (server) {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
  await fixture.cleanup()
}
