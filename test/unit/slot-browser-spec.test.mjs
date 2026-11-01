import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { DockerStdout } from '../../src/lib/fork/slot-browser/transport.mjs'
import {
  browserBinding,
  browserEnvironment,
  browserNames,
  buildBrowserSpec,
  navigationUrl,
} from '../../src/lib/fork/slot-browser/spec.mjs'
import { authorizePanelRoute } from '../../src/lib/admin/panel-acl.mjs'

const vm = {
  id: 'vm-a',
  timezone: 'Asia/Tokyo',
  locale: 'ja_JP.UTF-8',
  proxy: { id: 'px-test', url: 'socks5h://test-user:test-password@192.0.2.10:1080' },
}
const network = {
  Name: 'kin-eg-px-test',
  Driver: 'bridge',
  EnableIPv6: false,
  Options: { 'com.docker.network.bridge.enable_ip_masquerade': 'false' },
  IPAM: { Config: [{ Gateway: '172.30.0.1' }] },
}

test('shared image, isolated data/network and no public control ports or proxy secrets', () => {
  const a = buildBrowserSpec(vm, network)
  const b = buildBrowserSpec({ ...vm, id: 'vm-b' }, network)
  assert.equal(a.body.Image, b.body.Image)
  assert.notEqual(a.name, b.name)
  assert.notEqual(a.body.HostConfig.Mounts[0].Source, b.body.HostConfig.Mounts[0].Source)
  assert.equal(a.body.HostConfig.NetworkMode, network.Name)
  assert.equal(a.body.HostConfig.ReadonlyRootfs, true)
  assert.equal(a.body.HostConfig.RestartPolicy.Name, 'no')
  assert.equal(a.body.HostConfig.PortBindings, undefined)
  assert.equal(a.body.HostConfig.Privileged, undefined)
  assert.equal(a.body.HostConfig.CapAdd.includes('SYS_ADMIN'), false)
  assert.equal(a.body.HostConfig.SecurityOpt.includes('no-new-privileges'), true)
  assert.equal(a.body.HostConfig.SecurityOpt.includes('seccomp=unconfined'), false)
  assert.equal(a.body.HostConfig.Sysctls['net.ipv6.conf.all.disable_ipv6'], '1')
  assert.equal(JSON.stringify(a).includes('test-password'), false)
  assert.equal(a.body.Env.includes('TZ=Asia/Tokyo'), true)
  assert.equal(a.body.Env.includes('BROWSER_LANGUAGES=ja-JP,ja'), true)
  assert.equal(
    a.body.HostConfig.Mounts.some((mount) => mount.Target.includes('docker.sock')),
    false,
  )
})

test('fail closed on unsupported runtimes, missing exit and unsafe networks', () => {
  assert.throws(() => buildBrowserSpec({ ...vm, runtime: { type: 'kvm' } }, network), /Linux Docker/)
  assert.throws(() => buildBrowserSpec({ ...vm, proxy: null }, network), /出口网络/)
  assert.throws(() => buildBrowserSpec(vm, { ...network, EnableIPv6: true }), /出口网络/)
  assert.throws(() => buildBrowserSpec(vm, { ...network, Driver: 'host' }), /出口网络/)
  assert.throws(() => buildBrowserSpec(vm, { ...network, Options: {} }), /直连 NAT/)
  assert.throws(() => browserNames('../other'), /ID/)
  assert.throws(() => browserEnvironment({ ...vm, locale: 'en_US; touch /tmp/x' }), /locale/)
})

test('stable environment follows slot rather than operator browser, and bindings invalidate', () => {
  assert.deepEqual(browserEnvironment(vm), {
    timezone: 'Asia/Tokyo',
    locale: 'ja_JP.UTF-8',
    language: 'ja-JP',
    languages: 'ja-JP,ja',
    screen: '1280x800',
  })
  assert.equal(browserBinding(vm), browserBinding(structuredClone(vm)))
  for (const changed of [
    { timezone: 'UTC' },
    { locale: 'en_US.UTF-8' },
    { node_id: 'node-b' },
    { owner_user_id: 'u-b' },
    { proxy: { ...vm.proxy, id: 'px-other' } },
  ]) {
    assert.notEqual(browserBinding(vm), browserBinding({ ...vm, ...changed }))
  }
  for (const url of [
    'file:///etc/passwd',
    'http://localhost/',
    'javascript:alert(1)',
    'https://user:pass@example.com',
  ]) {
    assert.throws(() => navigationUrl(url))
  }
  assert.equal(navigationUrl('https://example.com/path'), 'https://example.com/path')
})

test('browser routes are credential operations, not super read-only views', () => {
  for (const [method, suffix] of [
    ['GET', ''],
    ['GET', '/callback'],
    ['POST', '/start'],
    ['POST', '/stop'],
    ['POST', '/ticket'],
  ]) {
    const path = `/api/panel/vms/vm-a/browser${suffix}`
    assert.equal(authorizePanelRoute(method, path, 'user').ok, true)
    assert.equal(authorizePanelRoute(method, path, 'super').ok, false)
    assert.equal(authorizePanelRoute(method, path, 'admin').ok, true)
  }
  assert.equal(authorizePanelRoute('DELETE', '/api/panel/vms/vm-a/browser', 'user').ok, false)
  assert.equal(authorizePanelRoute('POST', '/api/panel/vms/vm-a/browser/arbitrary-command', 'user').ok, false)
})

function frame(body, stream = 1) {
  const header = Buffer.alloc(8)
  header[0] = stream
  header.writeUInt32BE(body.length, 4)
  return Buffer.concat([header, body])
}

test('binary desktop bytes survive every possible Docker frame split', async () => {
  const body = Buffer.from([0, 255, 10, 13, 0, 128, 27, 91, 97])
  const wire = Buffer.concat([frame(body), frame(body)])
  for (let split = 0; split <= wire.length; split++) {
    const decoder = new DockerStdout()
    const chunks = []
    decoder.on('data', (data) => chunks.push(data))
    const ended = once(decoder, 'end')
    decoder.write(wire.subarray(0, split))
    decoder.end(wire.subarray(split))
    await ended
    assert.deepEqual(Buffer.concat(chunks), Buffer.concat([body, body]))
  }
})

test('malformed, oversized, truncated and stderr frames fail without exposing stderr', async () => {
  const huge = Buffer.alloc(8)
  huge[0] = 1
  huge.writeUInt32BE((1 << 20) + 1, 4)
  for (const wire of [huge, Buffer.from([1]), frame(Buffer.from('secret stderr'), 2)]) {
    const decoder = new DockerStdout()
    const failed = once(decoder, 'error')
    decoder.resume()
    decoder.end(wire)
    const [error] = await failed
    assert.doesNotMatch(error.message, /secret stderr/)
  }
})
