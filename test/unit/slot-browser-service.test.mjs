import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import WebSocket from 'ws'
import { createSlotBrowser, browserOrigin } from '../../src/lib/fork/slot-browser/service.mjs'

async function fixture(t, { refreshEnvironment } = {}) {
  const vms = new Map(
    ['a', 'b', 'c'].map((id) => [
      `vm-${id}`,
      {
        id: `vm-${id}`,
        owner_user_id: 'u-1',
        timezone: 'UTC',
        locale: 'en_US.UTF-8',
        proxy: { id: 'px-a' },
      },
    ]),
  )
  let time = 1_000_000
  let revoked = false
  let startGate = null
  let onStart = () => {}
  let stopGate = null
  let onStop = () => {}
  const stopped = [],
    opened = [],
    inputs = []
  const runtime = {
    async start(vm) {
      onStart()
      if (startGate) await startGate
      return { vm, environment: { timezone: vm.timezone, language: 'en-US', screen: '1280x800' } }
    },
    async stop(vm, opts) {
      onStop()
      if (stopGate) await stopGate
      stopped.push([vm.id, opts])
    },
    async rpc(_session, message) {
      opened.push(message)
      return { ok: true, ready: true, callback_url: null }
    },
    async transport() {
      const input = new PassThrough(),
        output = new PassThrough()
      input.on('data', (data) => {
        inputs.push(data)
        output.write(data)
      })
      return {
        input,
        output,
        close() {
          input.destroy()
          output.destroy()
        },
      }
    },
  }
  const service = createSlotBrowser({
    readVm: (id) => vms.get(id),
    runtime,
    refreshEnvironment: refreshEnvironment ? (vm) => refreshEnvironment(vm, vms) : null,
    tickMs: 0,
    now: () => time,
    principalFor: (req) => ({ key: req.panelUser, valid: () => !revoked }),
    logger: { warn() {} },
  })
  const server = http.createServer(async (req, res) => {
    req.panelUser = req.headers['x-actor'] || 'operator'
    req.panelRole = req.headers['x-role'] || 'user'
    req.panelUserId = req.headers['x-owner'] || 'u-1'
    await service.handle(req, res, new URL(req.url, 'http://test'), {
      json(response, status, body) {
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(JSON.stringify(body))
        return true
      },
      async readBody(request) {
        const chunks = []
        for await (const chunk of request) chunks.push(chunk)
        return JSON.parse(Buffer.concat(chunks).toString() || '{}')
      },
    })
  })
  server.on('upgrade', (req, socket, head) => {
    if (!service.handleUpgrade(req, socket, head)) socket.destroy()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  t.after(async () => {
    await service.close()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })
  async function call(id, action, body = {}, headers = {}, method = 'POST') {
    const response = await fetch(`${origin}/api/panel/vms/${id}/browser${action}`, {
      method,
      headers: { origin, 'content-type': 'application/json', ...headers },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
    })
    return { status: response.status, ...(await response.json()) }
  }
  function connect(id, ticket, options = {}) {
    return new WebSocket(`${origin.replace('http:', 'ws:')}/api/panel/vms/${id}/browser/socket?ticket=${ticket}`, {
      origin,
      ...options,
    })
  }
  return {
    service,
    call,
    connect,
    origin,
    vms,
    stopped,
    opened,
    inputs,
    revoke: () => {
      revoked = true
    },
    advance: (ms) => {
      time += ms
    },
    blockStart: (promise, entered) => {
      startGate = promise
      onStart = entered
    },
    blockStop: (promise, entered) => {
      stopGate = promise
      onStop = entered
    },
  }
}

test('ownership, credential role, origin, two-browser limit and operator exclusivity', async (t) => {
  const f = await fixture(t)
  assert.equal((await f.call('vm-a', '/start', {}, { 'x-owner': 'u-2' })).status, 404)
  assert.equal((await f.call('vm-a', '/start', {}, { 'x-role': 'super' })).status, 403)
  assert.equal((await f.call('vm-a', '/start', {}, { origin: 'https://evil.example' })).status, 403)
  assert.equal((await f.call('vm-a', '/start')).status, 200)
  assert.equal((await f.call('vm-a', '/start', {}, { 'x-actor': 'second' })).status, 409)
  assert.equal((await f.call('vm-b', '/start')).status, 200)
  assert.equal((await f.call('vm-c', '/start')).status, 429)
  assert.equal((await f.call('vm-a', '/stop', {}, { 'x-actor': 'second' })).status, 409)
  assert.equal((await f.call('vm-a', '/stop')).status, 200)
  assert.equal((await f.call('vm-c', '/start')).status, 200)
  assert.equal(f.stopped[0][1].deleteProfile, false)
})

async function rejected(ws, status) {
  const result = once(ws, 'unexpected-response')
  const [, response] = await result
  assert.equal(response.statusCode, status)
  ws.terminate()
  ws.on('error', () => {})
}

test('a slow Docker stop revokes old tickets and cannot issue new ones during shutdown', async (t) => {
  const f = await fixture(t)
  await f.call('vm-a', '/start')
  const ticket = (await f.call('vm-a', '/ticket')).data.ticket
  let release, entered
  const started = new Promise((resolve) => {
    entered = resolve
  })
  f.blockStop(
    new Promise((resolve) => {
      release = resolve
    }),
    entered,
  )
  const stopping = f.call('vm-a', '/stop')
  await started
  try {
    await rejected(f.connect('vm-a', ticket), 401)
    assert.equal((await f.call('vm-a', '/ticket')).status, 409)
  } finally {
    release()
  }
  assert.equal((await stopping).status, 200)
})

test('WebSocket tickets are single-use, slot/session/origin bound; binary input is preserved', async (t) => {
  const f = await fixture(t)
  await f.call('vm-a', '/start')
  const { data } = await f.call('vm-a', '/ticket')
  const ws = f.connect('vm-a', data.ticket)
  ws.on('error', () => {})
  await once(ws, 'open')
  const message = once(ws, 'message')
  const bytes = Buffer.from([0, 255, 10, 13, 128])
  ws.send(bytes)
  assert.deepEqual((await message)[0], bytes)
  assert.deepEqual(f.inputs[0], bytes)
  await rejected(f.connect('vm-a', data.ticket), 401)
  assert.equal((await f.call('vm-a', '/ticket')).status, 409)
  const closed = once(ws, 'close')
  ws.close()
  await closed
  const second = (await f.call('vm-a', '/ticket')).data.ticket
  await rejected(f.connect('vm-b', second), 401)
  await rejected(f.connect('vm-a', second), 401)
  const third = (await f.call('vm-a', '/ticket')).data.ticket
  await rejected(f.connect('vm-a', third, { origin: 'https://evil.example' }), 403)
  await rejected(f.connect('vm-a', third), 401)
  const expired = (await f.call('vm-a', '/ticket')).data.ticket
  f.advance(30_001)
  await rejected(f.connect('vm-a', expired), 401)
})

test('slot binding and logout revoke tickets and stop browsers without deleting profiles', async (t) => {
  const f = await fixture(t)
  await f.call('vm-a', '/start')
  const ticket = (await f.call('vm-a', '/ticket')).data.ticket
  f.vms.get('vm-a').proxy = { id: 'px-new' }
  await rejected(f.connect('vm-a', ticket), 401)
  await f.service.tick()
  assert.equal(f.stopped.length, 1)
  await f.call('vm-b', '/start')
  f.revoke()
  await f.service.tick()
  assert.equal(f.stopped.length, 2)
  assert.ok(f.stopped.every(([, opts]) => opts.deleteProfile === false))
})

test('idle profiles stop and in-flight startup cannot retain changed ownership', async (t) => {
  const f = await fixture(t)
  await f.call('vm-a', '/start')
  f.advance(300_001)
  await f.service.tick()
  assert.equal(f.stopped[0][0], 'vm-a')
  let release, entered
  const started = new Promise((resolve) => {
    entered = resolve
  })
  f.blockStart(
    new Promise((resolve) => {
      release = resolve
    }),
    entered,
  )
  const pending = f.call('vm-b', '/start')
  await started
  f.vms.get('vm-b').owner_user_id = 'u-2'
  release()
  const result = await pending
  assert.equal(result.status, 409)
  assert.equal(f.stopped.at(-1)[0], 'vm-b')
})

test('Codex callback is armed only for the matching generated slot/session/URL', async (t) => {
  const f = await fixture(t)
  const inner = new URL('https://auth.openai.com/oauth/authorize')
  inner.searchParams.set('state', 'test-state-0123456789')
  const outer = new URL('https://chatgpt.com/codex/desktop-auth')
  outer.searchParams.set('authorize_url', inner.href)
  const generated = { flavor: 'codex', auth_url: outer.href, session_id: 'oauth-a', expires_at: 1_600_000 }
  f.service.recordAuthorization('vm-a', generated)
  assert.equal((await f.call('vm-b', '/start', { auth_url: outer.href, oauth_session_id: 'oauth-a' })).status, 409)
  assert.equal(
    (await f.call('vm-a', '/start', { auth_url: 'https://example.com/', oauth_session_id: 'oauth-a' })).status,
    409,
  )
  assert.equal((await f.call('vm-a', '/start', { auth_url: outer.href, oauth_session_id: 'oauth-a' })).status, 200)
  assert.deepEqual(f.opened.at(-1).grant, { state: 'test-state-0123456789', session_id: 'oauth-a' })
  assert.equal((await f.call('vm-a', '/callback?session_id=other', {}, {}, 'GET')).status, 409)
})

test('mutating slot/exit blocks startup; only a validated delete purges the profile', async (t) => {
  const f = await fixture(t)
  await f.call('vm-a', '/start')
  const request = { method: 'PATCH' }
  await f.service.beforeMutation(request, '/api/panel/vms/vm-a')
  assert.equal((await f.call('vm-a', '/start')).status, 409)
  f.service.afterMutation(request)
  assert.equal((await f.call('vm-a', '/start')).status, 200)
  const deleted = { method: 'DELETE' }
  await f.service.beforeMutation(deleted, '/api/panel/vms/vm-a')
  assert.equal(f.stopped.at(-1)[1].deleteProfile, false)
  await f.service.purgeProfile(f.vms.get('vm-a'))
  assert.equal(f.stopped.at(-1)[1].deleteProfile, true)
  f.service.afterMutation(deleted)
})

test('proxy edits stop only affected slots; probes and label-only route guards leave all views alone', async (t) => {
  const f = await fixture(t)
  f.vms.get('vm-b').owner_user_id = 'u-2'
  f.vms.get('vm-b').proxy.id = 'px-other'
  await f.call('vm-a', '/start')
  await f.call('vm-b', '/start', {}, { 'x-owner': 'u-2', 'x-actor': 'other' })
  const probe = { method: 'POST', panelRole: 'user', panelUserId: 'u-1' }
  await f.service.beforeMutation(probe, '/api/panel/proxies/probe')
  assert.equal(f.stopped.length, 0)
  const change = { method: 'PATCH', panelRole: 'user', panelUserId: 'u-1' }
  await f.service.beforeMutation(change, '/api/panel/proxies/px-a')
  assert.equal(f.stopped.length, 0, 'route gate cannot know whether this is a label-only change')
  await f.service.beforeProxyMutation(change, { proxyId: 'px-a' })
  assert.deepEqual(
    f.stopped.map(([id]) => id),
    ['vm-a'],
  )
  assert.equal((await f.call('vm-a', '/start')).status, 409)
  assert.equal((await f.call('vm-b', '/start', {}, { 'x-owner': 'u-2', 'x-actor': 'other' })).status, 200)
  f.service.afterMutation(change)
  f.service.afterMutation(change) // finally/recovery may both attempt cleanup
  assert.equal((await f.call('vm-a', '/start')).status, 200)
})

test('startup calibrates the environment before Docker, and active checks deduplicate by proxy', async (t) => {
  let zone = 'Asia/Tokyo',
    exit = 'exit-a',
    calls = 0
  const f = await fixture(t, {
    refreshEnvironment: async (vm, vms) => {
      calls++
      for (const row of vms.values()) if (row.proxy.id === vm.proxy.id) row.timezone = zone
      return { vm: vms.get(vm.id), exitKey: exit }
    },
  })
  const first = await f.call('vm-a', '/start')
  assert.equal(first.data.timezone, 'Asia/Tokyo')
  await f.call('vm-b', '/start')
  assert.equal(calls, 2)
  f.advance(59_000)
  await f.service.checkEnvironments()
  assert.equal(calls, 2)
  zone = 'America/New_York'
  exit = 'exit-b'
  f.advance(1001)
  await f.service.checkEnvironments()
  assert.equal(calls, 3, 'two browsers on the same proxy share one exit lookup')
  assert.deepEqual(f.stopped.map(([id]) => id).sort(), ['vm-a', 'vm-b'])
  assert.ok(f.stopped.every(([, opts]) => !opts.deleteProfile))
  assert.equal((await f.call('vm-a', '/start')).data.timezone, 'America/New_York')
})

test('changed exit closes a live view with a restart reason and leaves another proxy alone', async (t) => {
  let exit = 'old'
  const f = await fixture(t, {
    refreshEnvironment: async (vm) => ({ vm, exitKey: vm.proxy.id === 'px-a' ? exit : 'other' }),
  })
  f.vms.get('vm-b').proxy.id = 'px-other'
  await f.call('vm-a', '/start')
  await f.call('vm-b', '/start')
  const ticket = (await f.call('vm-a', '/ticket')).data.ticket
  const ws = f.connect('vm-a', ticket)
  ws.on('error', () => {})
  await once(ws, 'open')
  const closed = once(ws, 'close')
  exit = 'new'
  f.advance(60_001)
  await f.service.checkEnvironments()
  const [code, reason] = await closed
  assert.equal(code, 4001)
  assert.equal(reason.toString(), 'environment_changed')
  assert.deepEqual(
    f.stopped.map(([id]) => id),
    ['vm-a'],
  )
  assert.equal((await f.call('vm-b', '', {}, {}, 'GET')).data.running, true)
})

test('failed live geolocation warns without inventing a change; a new start still fails', async (t) => {
  let failed = false
  const f = await fixture(t, {
    refreshEnvironment: async (vm) => {
      if (failed) throw new Error('geo offline')
      return { vm, exitKey: 'same' }
    },
  })
  await f.call('vm-a', '/start')
  failed = true
  f.advance(60_001)
  await f.service.checkEnvironments()
  assert.equal(f.stopped.length, 0)
  const current = (await f.call('vm-a', '', {}, {}, 'GET')).data
  assert.match(current.environment_warning, /复核失败/)
  assert.equal((await f.call('vm-b', '/start')).status, 502)
  failed = false
  f.advance(60_001)
  await f.service.checkEnvironments()
  assert.equal((await f.call('vm-a', '', {}, {}, 'GET')).data.environment_warning, '')
})

test('only an administrator with explicit slot confirmation can reset browser login data', async (t) => {
  const f = await fixture(t)
  assert.equal((await f.call('vm-a', '/reset-profile', { confirm_vm_id: 'vm-a' })).status, 403)
  assert.equal((await f.call('vm-a', '/reset-profile', { confirm_vm_id: 'vm-b' }, { 'x-role': 'admin' })).status, 400)
  assert.equal(f.stopped.length, 0)
  assert.equal((await f.call('vm-a', '/reset-profile', { confirm_vm_id: 'vm-a' }, { 'x-role': 'admin' })).status, 200)
  assert.equal(f.stopped.at(-1)[1].deleteProfile, true)
})

test('configured cross-origin panel is accepted, null and lookalike origins are rejected', () => {
  const req = { headers: { host: 'api.example.com', origin: 'https://panel.example.com' } }
  assert.equal(browserOrigin(req, new Set(['https://panel.example.com'])), req.headers.origin)
  for (const origin of [
    'null',
    'https://api.example.com.evil',
    'file://api.example.com',
    'https://api.example.com/path',
  ]) {
    assert.throws(() => browserOrigin({ headers: { host: 'api.example.com', origin } }, new Set()))
  }
})
