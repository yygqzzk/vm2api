import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { once } from 'node:events'
import { createBrowserRuntime } from '../../src/lib/fork/slot-browser/runtime.mjs'
import { BROWSER_FINGERPRINT_SCHEMA, browserNames } from '../../src/lib/fork/slot-browser/spec.mjs'

const vm = {
  id: 'vm-runtime-test',
  owner_user_id: 'new-owner',
  timezone: 'UTC',
  locale: 'en_US.UTF-8',
  proxy: { id: 'px-runtime' },
  fingerprint: { guest_machine_id: 'new-machine' },
}

test('profile ownership and image compatibility gates reject reuse without deleting data', async (t) => {
  let schema = BROWSER_FINGERPRINT_SCHEMA
  let labels = {
    'kin.browser': '1',
    'kin.browser.vm': vm.id,
    'kin.browser.owner': 'old-owner',
    'kin.browser.machine': 'new-machine',
  }
  const methods = []
  const server = http.createServer((req, res) => {
    methods.push(req.method)
    let body,
      status = 200
    const url = req.url
    if (url === '/containers/kin-runtime-test/json')
      body = { State: { Running: true }, HostConfig: { NetworkMode: 'kin-eg-px-runtime' } }
    else if (url.startsWith('/networks/'))
      body = {
        Name: 'kin-eg-px-runtime',
        Driver: 'bridge',
        EnableIPv6: false,
        Options: { 'com.docker.network.bridge.enable_ip_masquerade': 'false' },
        IPAM: { Config: [{ Gateway: '172.30.0.1' }] },
      }
    else if (url.startsWith('/images/'))
      body = { Os: 'linux', Architecture: 'amd64', Config: { Labels: { 'io.vm2api.browser.fingerprint': schema } } }
    else if (url === '/version') body = { Arch: 'amd64' }
    else if (url.startsWith(`/containers/${browserNames(vm.id).container}`)) {
      status = 404
      body = {}
    } else if (url.startsWith('/containers/json')) body = []
    else if (url.startsWith('/volumes/')) body = { Labels: labels }
    else {
      status = 500
      body = { message: 'unexpected test route' }
    }
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const connect = () =>
    new Promise((resolve, reject) => {
      const socket = net.connect(server.address().port, '127.0.0.1', () => resolve(socket))
      socket.once('error', reject)
    })
  const runtime = createBrowserRuntime({ hostFor: () => ({ kind: 'node', dockerApi: () => connect }) })
  await assert.rejects(runtime.start(vm), { code: 'browser_profile_changed' })
  labels = { ...labels, 'kin.browser.owner': 'new-owner', 'kin.browser.machine': 'old-machine' }
  await assert.rejects(runtime.start(vm), { code: 'browser_profile_changed' })
  schema = 'stock-chromium'
  await assert.rejects(runtime.start(vm), { code: 'browser_image_incompatible' })
  assert.ok(methods.every((method) => method === 'GET'))
})

async function resetFixture(t) {
  const names = browserNames(vm.id)
  const state = {
    volume: {
      Labels: {
        'kin.browser': '1',
        'kin.browser.vm': vm.id,
        'kin.browser.owner': vm.owner_user_id,
        'kin.browser.machine': vm.fingerprint.guest_machine_id,
      },
    },
    image: {
      Id: 'sha256:test-image',
      Os: 'linux',
      Architecture: 'amd64',
      Config: { Labels: { 'io.vm2api.browser.fingerprint': BROWSER_FINGERPRINT_SCHEMA } },
    },
    arch: 'amd64',
    exit: 0,
    stale: null,
    calls: [],
  }
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const call = { method: req.method, url: req.url, body: chunks.length ? JSON.parse(Buffer.concat(chunks)) : null }
    state.calls.push(call)
    let status = 200,
      body = {}
    if (req.url.startsWith('/images/')) body = state.image
    else if (req.url === '/version') body = { Arch: state.arch }
    else if (req.url === `/volumes/${names.volume}`) {
      body = state.volume
      if (req.method === 'DELETE') status = 204
    } else if (req.url === `/containers/${names.container}-reset/json`) {
      status = state.stale ? 200 : 404
      body = state.stale || {}
    } else if (req.url === `/containers/${names.container}/json`) status = 404
    else if (req.url.startsWith('/containers/create')) {
      status = 201
      body = { Id: 'test-reset-id' }
    } else if (req.url.endsWith('/start') || req.method === 'DELETE') status = 204
    else if (req.url.includes('/wait?')) body = { StatusCode: state.exit }
    else {
      status = 500
      body = { message: 'unexpected test route' }
    }
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(status === 204 ? '' : JSON.stringify(body))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const connect = () =>
    new Promise((resolve, reject) => {
      const socket = net.connect(server.address().port, '127.0.0.1', () => resolve(socket))
      socket.once('error', reject)
    })
  state.runtime = createBrowserRuntime({ hostFor: () => ({ kind: 'node', dockerApi: () => connect }) })
  return state
}

test('login reset uses a bounded offline helper and keeps the identity volume', async (t) => {
  const f = await resetFixture(t)
  await f.runtime.stop(vm, { resetProfile: true })
  const created = f.calls.find((call) => call.url.startsWith('/containers/create')).body
  assert.equal(created.Image, 'sha256:test-image')
  assert.equal(created.User, '1000:1000')
  assert.deepEqual(created.Entrypoint, ['python3', '/opt/slot-browser/desktop.py'])
  assert.deepEqual(created.Cmd, ['reset-profile'])
  assert.equal(created.HostConfig.NetworkMode, 'none')
  assert.equal(created.HostConfig.ReadonlyRootfs, true)
  assert.deepEqual(created.HostConfig.CapDrop, ['ALL'])
  assert.deepEqual(created.HostConfig.Mounts, [
    { Type: 'volume', Source: browserNames(vm.id).volume, Target: '/profile' },
  ])
  assert.ok(f.calls.some((call) => call.url === '/containers/test-reset-id/wait?condition=not-running'))
  assert.ok(f.calls.some((call) => call.method === 'DELETE' && call.url.startsWith('/containers/test-reset-id?')))
  assert.ok(!f.calls.some((call) => call.method === 'DELETE' && call.url.startsWith('/volumes/')))
})

test('reset failure is surfaced and its helper is removed', async (t) => {
  const f = await resetFixture(t)
  f.exit = 1
  await assert.rejects(f.runtime.stop(vm, { resetProfile: true }), { code: 'browser_profile_reset_failed' })
  assert.ok(f.calls.some((call) => call.method === 'DELETE' && call.url.startsWith('/containers/test-reset-id?')))
})

test('owner or machine replacement and explicit purge delete the full owned volume', async (t) => {
  for (const change of [{ owner_user_id: 'other' }, { fingerprint: { guest_machine_id: 'other' } }, null]) {
    const f = await resetFixture(t)
    await f.runtime.stop({ ...vm, ...change }, change ? { resetProfile: true } : { deleteProfile: true })
    assert.ok(f.calls.some((call) => call.method === 'DELETE' && call.url.startsWith('/volumes/')))
    assert.ok(!f.calls.some((call) => call.url.startsWith('/containers/create')))
  }
})

test('reset refuses foreign volumes and stale helpers', async (t) => {
  const f = await resetFixture(t)
  f.volume.Labels['kin.browser.vm'] = 'other'
  await assert.rejects(f.runtime.stop(vm, { resetProfile: true }), { code: 'browser_volume' })
  f.stale = { Config: { Labels: { 'kin.browser': '1', 'kin.browser.vm': 'other' } } }
  await assert.rejects(f.runtime.stop(vm), { code: 'browser_name_conflict' })
  assert.ok(!f.calls.some((call) => call.method === 'DELETE'))
})

test('stock Chromium images cannot perform a fingerprint-preserving reset', async (t) => {
  const f = await resetFixture(t)
  f.image.Config.Labels = {}
  await assert.rejects(f.runtime.stop(vm, { resetProfile: true }), { code: 'browser_image_incompatible' })
  assert.ok(!f.calls.some((call) => call.url.startsWith('/containers/create') || call.method === 'DELETE'))
})

test('a foreign-architecture browser image is rejected instead of running with an emulated sandbox', async (t) => {
  const f = await resetFixture(t)
  f.arch = 'arm64'
  await assert.rejects(f.runtime.stop(vm, { resetProfile: true }), { code: 'browser_image_platform' })
  assert.ok(!f.calls.some((call) => call.url.startsWith('/containers/create') || call.method === 'DELETE'))
})

test('local Codex deployment proxy must not silently become a direct browser exit', async () => {
  const previous = process.env.HTTPS_PROXY
  process.env.HTTPS_PROXY = 'socks5://192.0.2.1:1080'
  try {
    const runtime = createBrowserRuntime({
      hostFor: () => ({
        kind: 'local',
        dockerApi: () => {
          throw new Error('must not reach Docker')
        },
      }),
    })
    await assert.rejects(runtime.start({ ...vm, kind: 'codex', platform: 'openai', proxy: { id: 'px-local' } }), {
      code: 'browser_egress_mismatch',
    })
  } finally {
    if (previous == null) delete process.env.HTTPS_PROXY
    else process.env.HTTPS_PROXY = previous
  }
})
