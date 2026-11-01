import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ProxyPool } from '../../src/lib/vm/proxy-pool.mjs'
import { syncVmTimezoneFromProxy } from '../../src/lib/vm/proxy-timezone.mjs'

function fixture(t, lookup) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-geo-refresh-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const pool = new ProxyPool({
    dataDir: path.join(root, 'data'),
    geoLookup: lookup,
    geoV6Lookup: async () => ({ ok: true, geo: { ip: '2001:db8::1', timezone: 'Asia/Hong_Kong' } }),
  })
  pool.stopScheduler()
  t.after(() => pool.stopScheduler())
  const id = pool.importLines('socks5://test:old@192.0.2.10:1080').items[0].id
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
  const seed = (extra = {}) =>
    fs.writeFileSync(
      path.join(root, 'vms/vm-01.json'),
      JSON.stringify({
        id: 'vm-01',
        timezone: 'Asia/Hong_Kong',
        timezone_source: 'proxy_geo',
        proxy: { id },
        ...extra,
      }),
    )
  seed()
  pool.bind(id, 'vm-01')
  return { root, pool, id, seed }
}
const hongKong = { ok: true, geo: { ip: '203.0.113.1', timezone: 'Asia/Hong_Kong' } }
const tokyo = { ok: true, geo: { ip: '203.0.113.2', timezone: 'Asia/Tokyo' } }

test('editing a proxy connection invalidates IPv4 and IPv6 geography before reuse', async (t) => {
  let result = hongKong
  const { pool, id } = fixture(t, async () => result)
  await pool.detectGeo(id)
  result = tokyo
  pool.update(id, { password: 'new' })
  const row = pool.state.proxies.find((item) => item.id === id)
  assert.equal(row.geo_ip, null)
  assert.equal(row.geo_timezone, null)
  assert.equal(row.geo_checked_at, null)
  assert.equal(row.geo_v6_ip, null)
  assert.equal(row.geo_v6_checked_at, null)
  assert.equal((await pool.detectGeo(id)).geo.timezone, 'Asia/Tokyo')
})

test('labels and unchanged connection fields retain geography without reporting a connection change', async (t) => {
  const { pool, id } = fixture(t, async () => hongKong)
  await pool.detectGeo(id)
  assert.equal(pool.update(id, { label: 'renamed' }).connection_changed, false)
  assert.equal(
    pool.update(id, { host: '192.0.2.10', port: 1080, username: 'test', password: 'old' }).connection_changed,
    false,
  )
  assert.equal(pool.proxyTimezone(id), 'Asia/Hong_Kong')
})

test('a late lookup cannot restore geography from a proxy connection that was replaced', async (t) => {
  let resolve
  const { pool, id } = fixture(
    t,
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  const pending = pool.detectGeo(id, { force: true })
  pool.update(id, { host: '192.0.2.20' })
  resolve(hongKong)
  const result = await pending
  assert.equal(result.ok, false)
  assert.equal(result.error, 'proxy_changed')
  assert.equal(pool.proxyTimezone(id), '')
})

test('a superseded lookup cannot overwrite a newer exit observation on the same endpoint', async (t) => {
  let resolve,
    calls = 0
  const { pool, id } = fixture(t, () =>
    ++calls === 1
      ? new Promise((done) => {
          resolve = done
        })
      : Promise.resolve(tokyo),
  )
  const old = pool.detectGeo(id, { force: true })
  assert.equal((await pool.detectGeo(id, { force: true })).geo.timezone, 'Asia/Tokyo')
  resolve(hongKong)
  assert.equal((await old).ok, false)
  assert.equal(pool.proxyTimezone(id), 'Asia/Tokyo')
})

test('late geolocation never overwrites a new manual pin or replacement binding', async (t) => {
  for (const replacement of [
    { timezone: 'Europe/London', timezone_source: 'manual' },
    { proxy: { id: 'px-rebound' } },
  ]) {
    let release
    const f = fixture(
      t,
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const pending = syncVmTimezoneFromProxy(f.root, f.pool, 'vm-01', { refresh: true })
    f.seed(replacement)
    release(tokyo)
    assert.equal((await pending).reason, 'vm_changed')
    const saved = JSON.parse(fs.readFileSync(path.join(f.root, 'vms/vm-01.json'), 'utf8'))
    assert.equal(saved.timezone, replacement.timezone || 'Asia/Hong_Kong')
  }
})

test('explicit bind-time refresh bypasses cached geography without overriding manual timezone policy', async (t) => {
  let result = hongKong,
    calls = 0
  const { root, pool, id, seed } = fixture(t, async () => {
    calls++
    return result
  })
  await pool.detectGeo(id)
  result = tokyo
  const synced = await syncVmTimezoneFromProxy(root, pool, 'vm-01', { refresh: true })
  assert.equal(synced.timezone, 'Asia/Tokyo')
  assert.equal(synced.applied, true)
  assert.equal(calls, 2)
  seed({ timezone: 'Europe/London', timezone_source: 'manual' })
  assert.equal((await syncVmTimezoneFromProxy(root, pool, 'vm-01', { refresh: true })).reason, 'timezone_pinned')
  assert.equal(calls, 2)
  seed()
  pool.updateConfig({ follow_proxy_timezone: false })
  assert.equal(
    (await syncVmTimezoneFromProxy(root, pool, 'vm-01', { refresh: true })).reason,
    'follow_proxy_timezone_disabled',
  )
})
