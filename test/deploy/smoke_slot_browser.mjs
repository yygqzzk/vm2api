// Offline Linux-Docker acceptance. Creates only random, labelled test resources.
// No real accounts, public websites or real proxy credentials are used.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { createBrowserRuntime } from '../../src/lib/fork/slot-browser/runtime.mjs'
import { browserNames, DEFAULT_BROWSER_IMAGE } from '../../src/lib/fork/slot-browser/spec.mjs'
import { bridgeName, chainName, iptablesPlan, networkName, portsForProxy } from '../../src/lib/vm/egress.mjs'
import { containerName } from '../../src/lib/vm/vm-runtime.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const image = process.env.VM2API_BROWSER_IMAGE || DEFAULT_BROWSER_IMAGE
function docker(args, input) {
  return execFileSync('docker', args, { input, encoding: 'utf8', timeout: 60_000, maxBuffer: 4 << 20 }).trim()
}
function inspect(name) {
  return JSON.parse(docker(['inspect', name]))[0]
}

export async function browserFixture() {
  const key = crypto.randomBytes(5).toString('hex')
  const proxyId = `px-${key}`
  const net = networkName(proxyId)
  const socks = `browser-test-socks-${key}`
  const helper = `browser-test-egress-${key}`
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-acceptance-'))
  // Only synthetic fixture files live here. Native Linux enforces the runner
  // UID's 0700 directory against a cap-drop root process in the test container.
  fs.chmodSync(temp, 0o755)
  const binary = process.env.KIN_BROWSER_SMOKE_EGRESS
  if (!binary || !fs.existsSync(binary))
    throw new Error('Set KIN_BROWSER_SMOKE_EGRESS to a Linux kin-egress binary matching Docker architecture')
  fs.copyFileSync(binary, path.join(temp, 'kin-egress'))
  fs.chmodSync(path.join(temp, 'kin-egress'), 0o755)
  for (const [source, target] of [
    ['slot-browser-proxy.py', 'proxy.py'],
    ['slot-browser-egress.py', 'egress.py'],
  ]) {
    fs.copyFileSync(path.join(root, 'test/fixtures', source), path.join(temp, target))
  }
  const vms = ['a', 'b'].map((suffix, index) => ({
    id: `vm-browser-${key}-${suffix}`,
    owner_user_id: 'acceptance-user',
    runtime: { type: 'docker' },
    timezone: index ? 'America/New_York' : 'Asia/Tokyo',
    locale: index ? 'en_US.UTF-8' : 'ja_JP.UTF-8',
    proxy: { id: proxyId },
  }))
  const runtime = createBrowserRuntime({ image })
  const sessions = new Map()
  let heartbeat
  let gateway, proxyIp
  async function cleanup() {
    clearInterval(heartbeat)
    for (const vm of vms) {
      try {
        await runtime.stop(vm, { deleteProfile: true })
      } catch (error) {
        console.error('browser cleanup:', error.message)
      }
      try {
        docker(['rm', '-f', containerName(vm.id)])
      } catch {}
    }
    try {
      docker(['stop', '-t', '5', helper])
    } catch {}
    if (fs.existsSync(path.join(temp, 'plan.json'))) {
      try {
        docker([
          'run',
          '--rm',
          '--network',
          'host',
          '--cap-drop',
          'ALL',
          '--cap-add',
          'NET_ADMIN',
          '-v',
          `${temp}:/fixture:ro`,
          '--entrypoint',
          'python3',
          image,
          '/fixture/egress.py',
          'cleanup',
        ])
      } catch {}
    }
    for (const name of [helper, socks]) {
      try {
        docker(['rm', '-f', name])
      } catch {}
    }
    try {
      docker(['network', 'rm', net])
    } catch {}
    fs.rmSync(temp, { recursive: true, force: true })
  }
  try {
    docker([
      'network',
      'create',
      '--ipv6=false',
      '--opt',
      `com.docker.network.bridge.name=${bridgeName(proxyId)}`,
      '--opt',
      'com.docker.network.bridge.enable_ip_masquerade=false',
      '--opt',
      'com.docker.network.bridge.enable_icc=false',
      net,
    ])
    const network = JSON.parse(docker(['network', 'inspect', net]))[0]
    gateway = network.IPAM.Config[0].Gateway
    const ports = portsForProxy(proxyId)
    fs.writeFileSync(
      path.join(temp, 'plan.json'),
      JSON.stringify(
        iptablesPlan({
          chain: chainName(proxyId),
          bridge: bridgeName(proxyId),
          subnet: network.IPAM.Config[0].Subnet,
          tcpPort: ports.tcp,
          dnsPort: ports.dns,
        }),
      ),
    )
    docker([
      'run',
      '-d',
      '--name',
      socks,
      '--network',
      net,
      '--cap-drop',
      'ALL',
      '-e',
      'BROWSER_TEST_PROXY_IP=0.0.0.0',
      '-v',
      `${temp}:/fixture:ro`,
      '--entrypoint',
      'python3',
      image,
      '/fixture/proxy.py',
    ])
    // Older Docker versions reject a static IP on an auto-allocated subnet.
    proxyIp = inspect(socks).NetworkSettings.Networks[net].IPAddress
    assert.ok(proxyIp, 'fixture SOCKS server has an assigned address')
    fs.writeFileSync(
      path.join(temp, 'egress.json'),
      JSON.stringify({
        proxy_id: proxyId,
        proxy_url: `socks5://${proxyIp}:1080`,
        listen_tcp: `${gateway}:${ports.tcp}`,
        listen_dns: `${gateway}:${ports.dns}`,
        dns_upstream: '8.8.8.8:53',
      }),
    )
    docker([
      'run',
      '-d',
      '--name',
      helper,
      '--network',
      'host',
      '--cap-drop',
      'ALL',
      '--cap-add',
      'NET_ADMIN',
      '-v',
      `${temp}:/fixture:ro`,
      '--entrypoint',
      'python3',
      image,
      '/fixture/egress.py',
    ])
    for (const vm of vms)
      docker([
        'run',
        '-d',
        '--name',
        containerName(vm.id),
        '--network',
        net,
        '--entrypoint',
        '/usr/bin/sleep',
        image,
        'infinity',
      ])
    for (const vm of vms) sessions.set(vm.id, await runtime.start(vm))
    heartbeat = setInterval(() => {
      for (const session of sessions.values())
        void runtime.rpc(session, { op: 'heartbeat', viewing: true }).catch(() => {})
    }, 10_000)
    heartbeat.unref()
  } catch (error) {
    await cleanup()
    throw error
  }
  return {
    vms,
    runtime,
    sessions,
    gateway,
    proxyIp,
    cleanup,
    stopProxy: () => docker(['stop', '-t', '2', socks]),
    pauseHeartbeat: () => clearInterval(heartbeat),
    navigate: (vm, url) =>
      docker([
        'exec',
        '-u',
        '1000:1000',
        browserNames(vm.id).container,
        '/usr/bin/chromium',
        '--user-data-dir=/profile/chromium',
        '--new-tab',
        url,
      ]),
    exec: (vm, code, user = '1000:1000') =>
      docker(['exec', '-i', '-u', user, browserNames(vm.id).container, 'python3', '-c', code]),
    reports: () =>
      docker(['logs', socks])
        .split('\n')
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line)),
    inspect: (vm) => inspect(browserNames(vm.id).container),
    diagnostics: () => ({
      proxy: docker(['logs', socks]),
      helper: docker(['logs', helper]),
      browsers: vms.map((vm) => ({ id: vm.id, state: inspect(browserNames(vm.id).container).State })),
    }),
  }
}

export async function waitForReport(fixture, predicate, timeout = 20_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const report = fixture.reports().find((entry) => entry.report && predicate(entry.report))
    if (report) return report
    await delay(200)
  }
  throw new Error('Acceptance browser did not report through the offline SOCKS exit')
}

async function main() {
  const fixture = await browserFixture()
  const [a, b] = fixture.vms
  try {
    for (const [vm, marker] of [
      [a, 'slot-a'],
      [b, 'slot-b'],
    ]) {
      fixture.navigate(vm, `http://browser.test/?slot=${marker}`)
    }
    const ra = await waitForReport(fixture, (report) => report.slot === 'slot-a')
    const rb = await waitForReport(fixture, (report) => report.slot === 'slot-b')
    assert.equal(ra.report.oldCookie, '')
    assert.equal(rb.report.oldCookie, '')
    assert.equal(ra.report.storage, 'slot-a')
    assert.equal(rb.report.storage, 'slot-b')
    assert.equal(ra.report.timezone, 'Asia/Tokyo')
    assert.equal(rb.report.timezone, 'America/New_York')
    assert.equal(ra.report.language, 'ja-JP')
    assert.equal(rb.report.language, 'en-US')
    assert.match(ra.accept_language, /^ja-JP/)
    assert.match(rb.accept_language, /^en-US/)
    assert.deepEqual(ra.report.screen, [1280, 800])
    assert.equal(ra.report.webrtcError, undefined)
    assert.equal(rb.report.webrtcError, undefined)
    assert.deepEqual(ra.report.candidates, [])
    assert.deepEqual(rb.report.candidates, [])
    assert.ok(fixture.reports().some((entry) => entry.dns === 'browser.test'))
    for (const vm of [a, b]) {
      const status = fixture.exec(
        vm,
        "from pathlib import Path; print('\\n'.join(s for s in Path('/proc/1/status').read_text().splitlines() if s.startswith(('Uid:', 'CapEff:', 'CapBnd:', 'NoNewPrivs:'))))",
      )
      assert.match(status, /Uid:\s+1000/)
      assert.match(status, /CapEff:\s+0000000000000000/)
      assert.match(status, /CapBnd:\s+0000000000000000/)
      assert.match(status, /NoNewPrivs:\s+1/)
      const info = fixture.inspect(vm)
      assert.deepEqual(info.HostConfig.PortBindings, {})
      assert.equal(info.HostConfig.Privileged, false)
      const sockets = await fixture.runtime.transport(fixture.sessions.get(vm.id))
      const version = await new Promise((resolve, reject) => {
        sockets.output.once('data', resolve)
        sockets.output.once('error', reject)
      })
      assert.match(version.toString(), /^RFB 003\./)
      sockets.close()
    }
    console.log(
      'PASS: headed browsers, RFB, zero capabilities, independent profiles, TZ/language/headers, proxy DNS and WebRTC',
    )

    fixture.sessions.delete(a.id)
    await fixture.runtime.stop(a)
    fixture.sessions.set(a.id, await fixture.runtime.start(a))
    fixture.navigate(a, 'http://browser.test/?slot=slot-a-after-restart')
    const again = await waitForReport(fixture, (report) => report.slot === 'slot-a-after-restart')
    assert.equal(again.report.oldCookie, 'slot=slot-a')
    assert.equal(again.report.oldStorage, 'slot-a')
    console.log('PASS: cookies and LocalStorage survive a stopped/recreated browser container')

    const failNetwork = (vm, host, port, ipv6 = false) =>
      Number(
        fixture.exec(
          vm,
          `import socket; s=socket.socket(${ipv6 ? 'socket.AF_INET6' : 'socket.AF_INET'}); s.settimeout(2); print(s.connect_ex((${JSON.stringify(host)}, ${port})))`,
        ),
      )
    assert.notEqual(failNetwork(a, fixture.gateway, 80), 0)
    assert.notEqual(failNetwork(a, fixture.proxyIp, 1080), 0)
    assert.notEqual(failNetwork(a, '169.254.169.254', 80), 0)
    assert.notEqual(failNetwork(a, '2001:db8::1', 80, true), 0)
    fixture.exec(
      a,
      "import socket\ns=socket.socket(socket.AF_INET,socket.SOCK_DGRAM)\nfor port in (3478,443):\n try:\n  s.sendto(b'offline-test',('198.51.100.99',port))\n except PermissionError:\n  pass",
    )
    const dropCount = Number(
      fixture.exec(
        a,
        "import subprocess; print(subprocess.check_output(['iptables','-nvx','-L','OUTPUT'],text=True).splitlines()[0].split('policy DROP ')[1].split()[0])",
        '0',
      ),
    )
    assert.ok(dropCount >= 2)
    fixture.stopProxy()
    const failed = fixture.exec(
      a,
      "import urllib.request;\ntry:\n print(urllib.request.urlopen('http://198.51.100.99/',timeout=3).status)\nexcept Exception:\n print('blocked')",
    )
    assert.equal(failed, 'blocked')
    const dnsFailed = fixture.exec(
      a,
      "import socket\ntry:\n socket.getaddrinfo('browser.test',80)\n print('resolved')\nexcept socket.gaierror:\n print('blocked')",
    )
    assert.equal(dnsFailed, 'blocked')
    console.log(
      'PASS: host/other-container/metadata/IPv6 access blocked; UDP STUN/QUIC dropped; proxy failure has no TCP/DNS fallback',
    )
    fixture.pauseHeartbeat()
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline && [a, b].some((vm) => fixture.inspect(vm).State.Running)) await delay(500)
    for (const vm of [a, b]) {
      assert.equal(fixture.inspect(vm).State.Running, false)
      assert.equal(fixture.inspect(vm).State.ExitCode, 0)
    }
    console.log('PASS: loss of control-plane heartbeat stops both desktops via the independent container lease')
  } finally {
    await fixture.cleanup()
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
