import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { ProxyPool } from '../../src/lib/vm/proxy-pool.mjs'
import { getVm } from '../../src/lib/vm/vm-registry.mjs'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-timezone-api-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  let observed = { ok: true, geo: { ip: '203.0.113.20', timezone: 'Asia/Tokyo' } }
  const pool = new ProxyPool({
    dataDir: path.join(root, 'data'),
    geoLookup: async () => observed,
    geoV6Lookup: async () => ({ ok: false, error: 'synthetic_no_ipv6' }),
  })
  pool.stopScheduler()
  t.after(() => pool.stopScheduler())
  const id = pool.importLines('192.0.2.1:1080').items[0].id
  const other = pool.importLines('192.0.2.2:1080').items[0].id
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
  for (const [vmId, proxyId, source] of [
    ['vm-a', id, 'proxy_geo'],
    ['vm-b', id, 'proxy_geo'],
    ['vm-manual', id, 'manual'],
    ['vm-other', other, 'proxy_geo'],
  ]) {
    pool.bind(proxyId, vmId)
    fs.writeFileSync(
      path.join(root, 'vms', vmId + '.json'),
      JSON.stringify({
        id: vmId,
        status: 'stopped',
        proxy: pool.getProxyForVm(vmId),
        timezone: 'Asia/Hong_Kong',
        timezone_source: source,
        locale: 'en_US.UTF-8',
      }),
    )
  }
  const row = pool.state.proxies.find((entry) => entry.id === id)
  row.geo_ip = '203.0.113.10'
  row.geo_timezone = 'Asia/Hong_Kong'
  row.geo_checked_at = new Date().toISOString()
  pool.save()
  const stopped = []
  async function call(method, suffix, body = {}) {
    let response
    const handler = createPanelHandler({
      cfg: { paths: { project: root } },
      routingConfig: {},
      proxyPool: pool,
      slotBrowser: {
        beforeMutation: async () => {},
        afterMutation: () => {},
        proxyObserved: async () => {},
        beforeProxyMutation: async (_req, scope) => stopped.push(scope),
      },
      requireAuth(req) {
        req.apiKeyKind = 'master'
        return true
      },
      readBody: async () => body,
      json(_res, status, payload) {
        response = { status, body: payload }
        return true
      },
    })
    await handler({ method, headers: {} }, {}, new URL('http://localhost/api/panel/proxies/' + suffix))
    return response
  }
  return {
    root,
    pool,
    id,
    other,
    stopped,
    call,
    setGeo: (value) => {
      observed = value
    },
  }
}

test('editing pool connection updates all auto timezones before reporting reload results', async (t) => {
  const f = fixture(t)
  const res = await f.call('PUT', f.id, { port: 1081 })
  assert.equal(res.status, 200)
  assert.equal(res.body.data.proxy.geo.timezone, 'Asia/Tokyo')
  assert.equal(res.body.data.geo_error, null)
  for (const id of ['vm-a', 'vm-b']) assert.equal(getVm(f.root, id).timezone, 'Asia/Tokyo')
  assert.equal(getVm(f.root, 'vm-manual').timezone, 'Asia/Hong_Kong')
  assert.equal(getVm(f.root, 'vm-other').timezone, 'Asia/Hong_Kong')
  assert.deepEqual(f.stopped[0], { proxyId: f.id })
})

test('single and batch geographic refresh apply the same timezone policy to bound slots', async (t) => {
  const f = fixture(t)
  const one = await f.call('POST', f.id + '/geo')
  assert.equal(one.status, 200)
  assert.equal(one.body.data.timezones.filter((row) => row.applied).length, 2)
  f.setGeo({ ok: true, geo: { ip: '203.0.113.30', timezone: 'America/New_York' } })
  const all = await f.call('POST', 'geo')
  assert.equal(all.status, 200)
  assert.equal(getVm(f.root, 'vm-a').timezone, 'America/New_York')
  assert.equal(getVm(f.root, 'vm-b').timezone, 'America/New_York')
  assert.equal(getVm(f.root, 'vm-manual').timezone, 'Asia/Hong_Kong')
  assert.ok(all.body.data.timezones.some((row) => row.vm_id === 'vm-a' && row.applied))
})

test('renaming a proxy leaves browser sessions and geography alone', async (t) => {
  const f = fixture(t)
  const result = await f.call('PUT', f.id, { label: 'new label' })
  assert.equal(result.status, 200)
  assert.deepEqual(f.stopped, [])
  assert.equal(f.pool.proxyTimezone(f.id), 'Asia/Hong_Kong')
})

test('failed geography after a proxy edit is reported, with old slot timezone unchanged', async (t) => {
  const f = fixture(t)
  f.setGeo({ ok: false, error: 'geo_http_429' })
  const res = await f.call('PUT', f.id, { port: 1081 })
  assert.equal(res.status, 200, 'connection edit succeeded independently of geo provider')
  assert.equal(res.body.data.geo_error, 'geo_http_429')
  assert.deepEqual(res.body.data.timezones, [])
  assert.equal(getVm(f.root, 'vm-a').timezone, 'Asia/Hong_Kong')
  assert.equal(f.pool.proxyTimezone(f.id), '')
})
