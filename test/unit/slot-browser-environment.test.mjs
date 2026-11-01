import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ProxyPool } from '../../src/lib/vm/proxy-pool.mjs'
import { getVm, bindVmProxy } from '../../src/lib/vm/vm-registry.mjs'
import { createBrowserEnvironment } from '../../src/lib/fork/slot-browser/environment.mjs'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-environment-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  let geo = { ok: true, geo: { ip: '203.0.113.20', timezone: 'Asia/Tokyo' } }
  const pool = new ProxyPool({
    dataDir: path.join(root, 'data'),
    geoLookup: async () => geo,
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
  return {
    root,
    pool,
    id,
    other,
    refresh: createBrowserEnvironment({ projectRoot: root, proxyPool: pool }),
    setGeo: (value) => {
      geo = value
    },
  }
}

test('browser preflight forces fresh geography and updates only auto-timezone slots bound to that proxy', async (t) => {
  const f = fixture(t)
  const result = await f.refresh(getVm(f.root, 'vm-a'))
  assert.equal(result.vm.timezone, 'Asia/Tokyo')
  assert.equal(getVm(f.root, 'vm-b').timezone, 'Asia/Tokyo')
  assert.equal(getVm(f.root, 'vm-manual').timezone, 'Asia/Hong_Kong')
  assert.equal(getVm(f.root, 'vm-other').timezone, 'Asia/Hong_Kong')
  assert.equal(f.pool.proxyTimezone(f.id), 'Asia/Tokyo')
  assert.match(result.exitKey, /^[a-f0-9]{64}$/)
})

test('manual and globally disabled timezone following do not suppress exit observation or overwrite pins', async (t) => {
  const f = fixture(t)
  const manual = await f.refresh(getVm(f.root, 'vm-manual'))
  assert.equal(manual.vm.timezone, 'Asia/Hong_Kong')
  f.pool.updateConfig({ follow_proxy_timezone: false })
  f.setGeo({ ok: true, geo: { ip: '203.0.113.30', timezone: 'America/New_York' } })
  const result = await f.refresh(getVm(f.root, 'vm-a'))
  assert.equal(result.vm.timezone, 'Asia/Tokyo')
  assert.notEqual(result.exitKey, manual.exitKey)
})

test('failed or timezone-free observations never validate stale geography', async (t) => {
  const f = fixture(t)
  f.setGeo({ ok: false, error: 'geo_http_429' })
  await assert.rejects(f.refresh(getVm(f.root, 'vm-a')), { code: 'browser_geo_failed' })
  assert.equal(getVm(f.root, 'vm-a').timezone, 'Asia/Hong_Kong')
  f.setGeo({ ok: true, geo: { ip: '203.0.113.40', timezone: null } })
  await assert.rejects(f.refresh(getVm(f.root, 'vm-a')), { code: 'browser_timezone_unknown' })
})

test('changing binding during geolocation cannot apply the old proxy timezone', async (t) => {
  const f = fixture(t)
  let release
  f.pool.geoLookup = () =>
    new Promise((resolve) => {
      release = resolve
    })
  const pending = f.refresh(getVm(f.root, 'vm-a'))
  f.pool.bind(f.other, 'vm-a')
  bindVmProxy(f.root, 'vm-a', f.pool.getProxyForVm('vm-a'))
  release({ ok: true, geo: { ip: '203.0.113.20', timezone: 'Asia/Tokyo' } })
  await assert.rejects(pending, { code: 'browser_binding_changed' })
  assert.equal(getVm(f.root, 'vm-a').timezone, 'Asia/Hong_Kong')
  assert.equal(getVm(f.root, 'vm-a').proxy.id, f.other)
})
