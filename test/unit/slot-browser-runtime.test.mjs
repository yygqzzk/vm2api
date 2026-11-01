import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { once } from 'node:events'
import { createBrowserRuntime } from '../../src/lib/fork/slot-browser/runtime.mjs'
import { browserNames } from '../../src/lib/fork/slot-browser/spec.mjs'

const vm = {
  id: 'vm-runtime-test',
  owner_user_id: 'new-owner',
  timezone: 'UTC',
  locale: 'en_US.UTF-8',
  proxy: { id: 'px-runtime' },
  fingerprint: { guest_machine_id: 'new-machine' },
}

test('a profile cannot silently move to a new owner or machine; no volume is deleted', async (t) => {
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
    else if (url.startsWith('/images/')) body = {}
    else if (url === `/containers/${browserNames(vm.id).container}/json`) {
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
  assert.ok(methods.every((method) => method === 'GET'))
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
