import crypto from 'node:crypto'
import { WebSocketServer } from 'ws'
import { getVm } from '../../vm/vm-registry.mjs'
import { hasCapability, panelIdentity } from '../../admin/panel-acl.mjs'
import { vmOwnerId } from '../../admin/resource-owner.mjs'
import { parsePanelCorsOrigins } from '../../http/cors.mjs'
import { isCodexVm } from '../../vm/vm-kind.mjs'
import { createBrowserRuntime } from './runtime.mjs'
import {
  BROWSER_LIMIT,
  BrowserError,
  browserBinding,
  browserNames,
  IDLE_MS,
  navigationUrl,
  TICKET_TTL_MS,
} from './spec.mjs'

const EXIT_CHECK_MS = 60_000

export const BROWSER_PATH =
  /^\/api\/panel\/vms\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})\/browser(?:\/(start|stop|reset-profile|ticket|callback|socket))?$/

export function browserOrigin(req, allowed = parsePanelCorsOrigins()) {
  const raw = req.headers?.origin
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new BrowserError('browser_origin', '浏览器连接缺少有效 Origin', 403)
  }
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    raw !== url.origin ||
    (!allowed.has(url.origin) && url.host !== req.headers.host)
  ) {
    throw new BrowserError('browser_origin', '浏览器连接 Origin 未授权', 403)
  }
  return url.origin
}

export function createSlotBrowser({
  projectRoot,
  principalFor,
  refreshEnvironment = null,
  runtime = createBrowserRuntime(),
  readVm = (id) => getVm(projectRoot, id),
  now = Date.now,
  tickMs = 10_000,
  logger = console,
} = {}) {
  const sessions = new Map()
  const tickets = new Map()
  const grants = new Map()
  const blocked = new Map()
  const mutations = new WeakMap()
  const exitChecks = new Map()
  const checkingExits = new Map()
  let queue = Promise.resolve()
  let queued = 0
  let ticking = false
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20, perMessageDeflate: false })

  function exclusive(fn) {
    if (queued >= 4) throw new BrowserError('browser_busy', '浏览器操作正在排队，请稍后重试', 429)
    queued += 1
    const run = queue.then(fn)
    queue = run
      .catch(() => {})
      .finally(() => {
        queued -= 1
      })
    return run
  }

  function accessible(req, id) {
    browserNames(id)
    const identity = panelIdentity(req)
    if (!hasCapability(identity.role, 'vm.credential_write'))
      throw new BrowserError('forbidden', '没有凭证操作权限', 403)
    const vm = readVm(id)
    if (!vm || (identity.role === 'user' && vmOwnerId(vm) !== req.panelUserId)) {
      throw new BrowserError('vm_not_found', 'vm not found', 404)
    }
    if (!principalFor(req).valid(vm)) throw new BrowserError('forbidden', '浏览器操作权限已失效', 403)
    return vm
  }

  function valid(session) {
    const vm = readVm(session.vm.id)
    return (
      sessions.get(session.vm.id) === session &&
      !session.stopping &&
      !!vm &&
      session.principal.valid(vm) &&
      browserBinding(vm) === session.binding
    )
  }

  function isBlocked(vm) {
    return (
      blocked.has('all') ||
      blocked.has(`vm:${vm.id}`) ||
      blocked.has(`proxy:${vm.proxy?.id}`) ||
      blocked.has(`owner:${vmOwnerId(vm)}`)
    )
  }

  function owned(req, id) {
    accessible(req, id)
    const session = sessions.get(id)
    if (!session || !valid(session)) throw new BrowserError('browser_closed', '浏览器会话已结束，请重新打开')
    if (session.principal.key !== principalFor(req).key)
      throw new BrowserError('browser_in_use', '该槽浏览器正由另一位操作员使用')
    return session
  }

  function view(session) {
    return {
      running: !!session,
      ...(session
        ? {
            session_id: session.id,
            connected: !!session.ws,
            ...session.environment,
            profile_persistent: true,
            idle_seconds: IDLE_MS / 1000,
            environment_warning: session.environmentWarning || '',
          }
        : {}),
    }
  }

  async function stopVm(vm, { deleteProfile = false, reason = 'Browser stopped' } = {}) {
    const session = sessions.get(vm.id)
    if (session) {
      session.stopping = true
      if (reason === 'environment_changed' && grants.get(vm.id)?.sessionId === session.oauthSessionId)
        grants.delete(vm.id)
      session.ws?.close(reason === 'environment_changed' ? 4001 : 1000, reason)
      session.transport?.close()
    }
    for (const [key, ticket] of tickets) if (ticket.vmId === vm.id) tickets.delete(key)
    await runtime.stop(session?.vm || vm, { deleteProfile })
    sessions.delete(vm.id)
    if (![...sessions.values()].some((entry) => entry.vm.proxy?.id === vm.proxy?.id)) exitChecks.delete(vm.proxy?.id)
  }

  function recordAuthorization(vmId, generated) {
    if (generated.flavor !== 'codex') return
    let state
    try {
      const outer = new URL(generated.auth_url)
      state = new URL(outer.searchParams.get('authorize_url')).searchParams.get('state')
    } catch {
      throw new BrowserError('browser_oauth_invalid', '授权链接缺少有效的回调 state', 400)
    }
    if (!state) throw new BrowserError('browser_oauth_invalid', '授权链接缺少有效的回调 state', 400)
    for (const [id, grant] of grants) if (grant.expiresAt <= now()) grants.delete(id)
    if (grants.size >= 256) grants.delete(grants.keys().next().value)
    grants.set(vmId, {
      sessionId: generated.session_id,
      url: generated.auth_url,
      state,
      expiresAt: generated.expires_at,
    })
  }

  async function start(req, id, body) {
    browserOrigin(req)
    const principal = principalFor(req)
    return exclusive(async () => {
      let vm = structuredClone(accessible(req, id))
      if (isBlocked(vm)) throw new BrowserError('browser_slot_busy', '槽位或出口正在变更，请稍后重试')
      let session = sessions.get(id)
      if (session && valid(session) && session.principal.key !== principal.key)
        throw new BrowserError('browser_in_use', '该槽浏览器正由另一位操作员使用')
      const observed = refreshEnvironment ? await refreshEnvironment(vm) : { vm, exitKey: null }
      vm = structuredClone(accessible(req, id))
      if (browserBinding(vm) !== browserBinding(observed.vm) || isBlocked(vm))
        throw new BrowserError('browser_binding_changed', '检测期间槽位或代理已改变，请重新打开')
      const binding = browserBinding(vm)
      if (session && (!valid(session) || session.exitKey !== observed.exitKey)) {
        await stopVm(session.vm, { reason: 'environment_changed' })
        session = null
      }
      if (session && !(await runtime.rpc(session, { op: 'status' }).catch(() => null))?.ready) {
        await stopVm(session.vm)
        session = null
      }
      let grant = null
      let url = navigationUrl(body.auth_url || (isCodexVm(vm) ? 'https://chatgpt.com/' : 'https://claude.ai/'))
      if (body.oauth_session_id) {
        grant = grants.get(id)
        if (!grant || grant.sessionId !== body.oauth_session_id || grant.expiresAt <= now() || grant.url !== url) {
          throw new BrowserError('browser_oauth_expired', '授权链接已失效，请重新生成')
        }
      }
      if (!session) {
        if (sessions.size >= BROWSER_LIMIT) throw new BrowserError('browser_limit', '同时最多开启 2 个槽位浏览器', 429)
        const started = await runtime.start(vm)
        session = {
          ...started,
          id: crypto.randomUUID(),
          principal,
          binding,
          exitKey: observed.exitKey,
          environmentWarning: '',
          lastViewed: now(),
          ws: null,
          transport: null,
        }
        sessions.set(id, session)
      }
      // Ownership/exit changes during Docker startup must not open the old URL.
      const currentVm = readVm(id)
      if (!currentVm || !principal.valid(currentVm) || browserBinding(currentVm) !== binding || isBlocked(currentVm)) {
        await stopVm(vm)
        throw new BrowserError('browser_binding_changed', '槽位、出口或权限已改变，请重新打开')
      }
      await runtime.rpc(session, {
        op: 'open',
        url,
        ...(grant ? { grant: { state: grant.state, session_id: grant.sessionId } } : {}),
      })
      session.lastViewed = now()
      session.oauthSessionId = grant?.sessionId || null
      session.environmentWarning = ''
      exitChecks.set(vm.proxy?.id, now())
      return view(session)
    })
  }

  async function handle(req, res, url, { json, readBody }) {
    const match = BROWSER_PATH.exec(url.pathname)
    if (!match) return false
    const [, id, action] = match
    res.setHeader?.('Cache-Control', 'no-store')
    res.setHeader?.('Referrer-Policy', 'no-referrer')
    try {
      accessible(req, id)
      let result
      if (req.method === 'GET' && !action) result = view(sessions.get(id))
      else if (req.method === 'POST' && action === 'start') {
        const body = await readBody(req, 32768)
        if (!body || typeof body !== 'object' || Array.isArray(body))
          throw new BrowserError('invalid_body', '需要 JSON 对象', 400)
        result = await start(req, id, body)
      } else if (req.method === 'POST' && action === 'stop') {
        browserOrigin(req)
        const vm = accessible(req, id)
        if (sessions.has(id) && panelIdentity(req).role !== 'admin') owned(req, id)
        await exclusive(() => stopVm(vm))
        result = { running: false }
      } else if (req.method === 'POST' && action === 'reset-profile') {
        browserOrigin(req)
        if (panelIdentity(req).role !== 'admin')
          throw new BrowserError('forbidden', '只有管理员可以清空浏览器登录态', 403)
        const body = await readBody(req, 4096)
        if (body?.confirm_vm_id !== id)
          throw new BrowserError('browser_reset_confirmation', '请确认要清空的槽位 ID', 400)
        await exclusive(() => stopVm(accessible(req, id), { deleteProfile: true }))
        result = { running: false, profile_deleted: true }
      } else if (req.method === 'POST' && action === 'ticket') {
        const origin = browserOrigin(req)
        const session = owned(req, id)
        if (session.ws) throw new BrowserError('browser_connected', '该槽已有控制窗口，请先关闭旧窗口')
        for (const [key, value] of tickets) if (value.exp <= now() || value.vmId === id) tickets.delete(key)
        const ticket = crypto.randomBytes(24).toString('base64url')
        tickets.set(ticket, { vmId: id, sessionId: session.id, exp: now() + TICKET_TTL_MS, origin })
        result = { ticket, expires_in: TICKET_TTL_MS / 1000 }
      } else if (req.method === 'GET' && action === 'callback') {
        const session = owned(req, id)
        const grant = grants.get(id)
        if (!grant || grant.expiresAt <= now() || grant.sessionId !== url.searchParams.get('session_id')) {
          throw new BrowserError('browser_oauth_expired', '授权会话已过期，请重新生成')
        }
        result = await runtime.rpc(session, { op: 'callback', session_id: grant.sessionId })
        owned(req, id) // Recheck revocation/ownership after the node round trip.
      } else throw new BrowserError('not_found', 'not found', 404)
      return json(res, 200, { ok: true, data: result })
    } catch (error) {
      const known = error instanceof BrowserError
      // Docker and transport errors may contain URL arguments; never reflect
      // their raw text into the panel or the request log.
      return json(res, known ? error.status : 502, {
        ok: false,
        error: {
          code: known ? error.code : 'browser_failed',
          message: known ? error.message : '浏览器操作失败，请检查节点连接与镜像运行条件',
        },
      })
    }
  }

  function reject(socket, status) {
    socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  }

  function handleUpgrade(req, socket, head) {
    let url
    try {
      url = new URL(req.url, 'http://local')
    } catch {
      return false
    }
    const match = BROWSER_PATH.exec(url.pathname)
    if (!match || match[2] !== 'socket') return false
    const ticketKey = url.searchParams.get('ticket')
    const ticket = tickets.get(ticketKey)
    tickets.delete(ticketKey)
    const session = sessions.get(match[1])
    try {
      const origin = browserOrigin(req)
      if (
        !ticket ||
        ticket.exp <= now() ||
        ticket.origin !== origin ||
        ticket.vmId !== match[1] ||
        !session ||
        session.id !== ticket.sessionId ||
        !valid(session)
      ) {
        reject(socket, 401)
        return true
      }
      if (session.ws || session.connecting) {
        reject(socket, 409)
        return true
      }
      session.connecting = true
      socket.once('close', () => {
        session.connecting = false
      })
      wss.handleUpgrade(req, socket, head, (ws) => {
        session.connecting = false
        session.ws = ws
        session.lastViewed = now()
        let channel = null
        const pending = []
        let pendingBytes = 0
        ws.on('message', (raw, binary) => {
          if (!binary || !valid(session)) {
            ws.close(4001, 'environment_changed')
            return
          }
          if (channel) {
            if (channel.input.writableLength > 1 << 20) {
              ws.close(1009)
              return
            }
            channel.input.write(raw)
          } else {
            pendingBytes += raw.length
            if (pendingBytes > 1 << 20) {
              ws.close(1009)
              return
            }
            pending.push(raw)
          }
        })
        ws.on('error', () => ws.close())
        ws.on('close', () => {
          channel?.close()
          if (session.ws === ws) {
            session.ws = null
            session.transport = null
            session.lastViewed = now()
          }
        })
        runtime
          .transport(session)
          .then((transport) => {
            channel = transport
            if (ws.readyState !== ws.OPEN || !valid(session)) {
              transport.close()
              ws.close(4001, 'environment_changed')
              return
            }
            session.transport = transport
            transport.output.on('error', () => ws.close(1011, 'Browser transport failed'))
            transport.output.on('end', () => ws.close(1000, 'Browser closed'))
            transport.output.on('data', (chunk) => {
              if (ws.readyState !== ws.OPEN) return
              if (!valid(session)) {
                ws.close(4001, 'environment_changed')
                return
              }
              if (ws.bufferedAmount > 8 << 20) {
                ws.close(1009, 'Slow browser connection')
                return
              }
              ws.send(chunk, { binary: true })
            })
            for (const message of pending) transport.input.write(message)
            pending.length = 0
          })
          .catch(() => ws.close(1011, 'Browser transport failed'))
      })
    } catch {
      if (session) session.connecting = false
      reject(socket, 403)
    }
    return true
  }

  async function checkEnvironments() {
    if (!refreshEnvironment) return
    for (const session of sessions.values()) {
      const proxyId = session.vm.proxy?.id
      if (
        !valid(session) ||
        isBlocked(readVm(session.vm.id)) ||
        checkingExits.has(proxyId) ||
        now() - (exitChecks.get(proxyId) || 0) < EXIT_CHECK_MS
      )
        continue
      exitChecks.set(proxyId, now())
      const check = exclusive(async () => {
        if (!valid(session) || isBlocked(readVm(session.vm.id))) return
        const group = [...sessions.values()].filter((entry) => entry.vm.proxy?.id === proxyId)
        try {
          const observed = await refreshEnvironment(structuredClone(readVm(session.vm.id)))
          for (const entry of group) {
            if (sessions.get(entry.vm.id) !== entry) continue
            entry.environmentWarning = ''
            if (!valid(entry) || entry.exitKey !== observed.exitKey)
              await stopVm(entry.vm, { reason: 'environment_changed' })
          }
        } catch (error) {
          for (const entry of group) {
            if (sessions.get(entry.vm.id) !== entry) continue
            if (!valid(entry) || error.code === 'browser_proxy_unavailable') {
              await stopVm(entry.vm, { reason: 'environment_changed' })
            } else {
              // A geo-provider outage is not proof that the proxy changed.
              entry.environmentWarning = '出口复核失败，当前时区未重新确认；请在代理池测地理，或稍后重开浏览器。'
            }
          }
        }
      })
        .catch(() => logger.warn?.(`[slot-browser] ${session.vm.id}: environment check failed`))
        .finally(() => checkingExits.delete(proxyId))
      checkingExits.set(proxyId, check)
    }
    await Promise.all(checkingExits.values())
  }

  async function tick() {
    if (ticking) return
    ticking = true
    try {
      for (const session of sessions.values()) {
        try {
          if (!valid(session) || (!session.ws && now() - session.lastViewed >= IDLE_MS)) {
            const reason = valid(session) ? 'Browser idle' : 'environment_changed'
            await exclusive(() =>
              sessions.get(session.vm.id) === session ? stopVm(session.vm, { reason }) : undefined,
            )
            continue
          }
          await runtime.rpc(session, { op: 'heartbeat', viewing: !!session.ws })
        } catch {
          session.ws?.close(1011, 'Browser unavailable')
          // If Docker is unreachable, the independent container lease still stops it.
          try {
            await exclusive(() => (sessions.get(session.vm.id) === session ? stopVm(session.vm) : undefined))
          } catch {
            logger.warn?.(`[slot-browser] ${session.vm.id}: heartbeat/stop failed; waiting for lease expiry`)
          }
        }
      }
      // Network geolocation must not delay the independent desktop heartbeat.
      void checkEnvironments().catch(() => {})
    } finally {
      ticking = false
    }
  }

  async function beforeMutation(req, path) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return
    const slot =
      /^\/api\/panel\/vms\/([^/]+)(?:\/(stop|reset|reset-fingerprint|reload|recover|owner|allocate-proxy|collect-identity|seed-settings|wrap-cli\/repair))?$/.exec(
        path,
      )
    const all =
      (req.method === 'PUT' && path === '/api/panel/proxies/config') ||
      path === '/api/panel/vms/fleet-update' ||
      (['PUT', 'PATCH', 'DELETE'].includes(req.method) && /^\/api\/panel\/cluster\/nodes\/[^/]+$/.test(path))
    if (!slot && !all) return
    const id = slot?.[1]
    const tenant = panelIdentity(req).role === 'user'
    const scope = all ? (tenant ? `owner:${req.panelUserId}` : 'all') : `vm:${id}`
    holdScopes(req, [scope])
    try {
      await exclusive(async () => {
        const targets = all
          ? [...sessions.values()]
              .map((session) => session.vm)
              .filter((vm) => !tenant || vmOwnerId(vm) === req.panelUserId)
          : [sessions.get(id)?.vm].filter(Boolean)
        for (const vm of targets) await stopVm(vm, { reason: 'environment_changed' })
      })
    } catch (error) {
      afterMutation(req)
      throw error
    }
  }

  function holdScopes(req, scopes) {
    const held = mutations.get(req) || new Set()
    for (const scope of scopes) {
      if (held.has(scope)) continue
      held.add(scope)
      blocked.set(scope, (blocked.get(scope) || 0) + 1)
    }
    mutations.set(req, held)
  }

  async function beforeProxyMutation(req, { proxyId, vmIds = [] } = {}) {
    holdScopes(req, [...(proxyId ? [`proxy:${proxyId}`] : []), ...vmIds.map((id) => `vm:${id}`)])
    await exclusive(async () => {
      const targets = [...sessions.values()].filter(
        (session) => (proxyId && session.vm.proxy?.id === proxyId) || vmIds.includes(session.vm.id),
      )
      for (const session of targets) await stopVm(session.vm, { reason: 'environment_changed' })
    })
  }

  async function proxyObserved(req, proxyId, geo) {
    if (!geo?.ip) return
    const key = crypto.createHash('sha256').update(geo.ip).digest('hex')
    const vmIds = [...sessions.values()]
      .filter((session) => session.vm.proxy?.id === proxyId && session.exitKey && session.exitKey !== key)
      .map((session) => session.vm.id)
    if (vmIds.length) await beforeProxyMutation(req, { vmIds })
  }

  function afterMutation(req) {
    for (const scope of mutations.get(req) || []) {
      if (blocked.get(scope) === 1) blocked.delete(scope)
      else blocked.set(scope, blocked.get(scope) - 1)
    }
    mutations.delete(req)
  }

  const timer = tickMs ? setInterval(() => void tick(), tickMs) : null
  timer?.unref?.()
  return {
    handle,
    handleUpgrade,
    recordAuthorization,
    beforeMutation,
    beforeProxyMutation,
    proxyObserved,
    afterMutation,
    purgeProfile: (vm) => exclusive(() => stopVm(vm, { deleteProfile: true })),
    tick,
    checkEnvironments,
    close: async () => {
      clearInterval(timer)
      for (const session of [...sessions.values()]) await stopVm(session.vm)
      wss.close()
    },
  }
}
