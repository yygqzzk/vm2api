import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import test from 'node:test'
import { codexKernelHealth } from '../../src/lib/transport/codex-kernel-client.mjs'
import {
  ensureCodexKernel,
  codexKernelTracked,
  finishCodexRecycle,
  stopCodexKernel,
  stopCodexKernelAndWait,
  writeCodexKernelConfig,
} from '../../src/lib/transport/codex-kernel-supervisor.mjs'
import { reloadSlotReady } from '../../src/lib/vm/slot-runtime.mjs'
import { runFleetUpdate } from '../../src/lib/vm/fleet-update.mjs'

async function fixture(t) {
  // Keep the Unix-socket path below macOS's length limit.
  const root = fs.mkdtempSync('/tmp/ck-reload-')
  const bin = path.join(root, 'kernel')
  fs.writeFileSync(
    bin,
    `#!${process.execPath}
const fs = require('node:fs')
const http = require('node:http')
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ ok: true, pid: process.pid, proxy: config.proxy_url }))
})
server.listen(config.socket_path)
process.on('SIGTERM', () => {
  setTimeout(() => server.close(() => process.exit(0)), 100)
})
`,
    { mode: 0o755 },
  )
  const previousBin = process.env.KIN_CODEX_KERNEL_BIN
  process.env.KIN_CODEX_KERNEL_BIN = bin
  const slots = []
  t.after(async () => {
    for (const { exec } of slots) {
      const child = stopCodexKernel(exec.vmId)
      if (child) await finishCodexRecycle(child)
    }
    if (previousBin === undefined) delete process.env.KIN_CODEX_KERNEL_BIN
    else process.env.KIN_CODEX_KERNEL_BIN = previousBin
    fs.rmSync(root, { recursive: true, force: true })
  })
  return {
    root,
    async slot(id) {
      const vm = { id, platform: 'openai', proxy: { url: 'socks5h://127.0.0.1:1080' }, runtime: { type: 'docker' } }
      const exec = { vmId: id, vm, homeDir: path.join(root, 'vms', id, 'cli-home') }
      slots.push({ exec })
      fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
      fs.writeFileSync(path.join(root, 'vms', `${id}.json`), JSON.stringify(vm))
      writeCodexKernelConfig(root, vm)
      assert.equal((await ensureCodexKernel(exec)).ok, true)
      return { vm, exec, health: await codexKernelHealth(exec) }
    },
  }
}

const reloadContainer = async (vm) => ({ ok: true, action: 'reloaded', runtime: vm.runtime })

test('GPT reload replaces the host kernel and adopts the new proxy without touching another slot', async (t) => {
  const f = await fixture(t)
  const first = await f.slot('vm-a')
  const peer = await f.slot('vm-b')
  first.vm.proxy.url = 'socks5h://127.0.0.1:2080'

  const result = await reloadSlotReady(first.vm, f.root, { ops: { reloadSlot: reloadContainer } })

  assert.equal(result.ok, true)
  const current = await codexKernelHealth(first.exec)
  assert.notEqual(current.pid, first.health.pid, 'a container reload must not reuse the old host kernel')
  assert.equal(current.proxy, first.vm.proxy.url, 'the process must read the new proxy at startup')
  assert.equal((await codexKernelHealth(peer.exec)).pid, peer.health.pid)
})

test('GPT reload repairs timezone seeds while preserving the slot identity and owner settings', async (t) => {
  const f = await fixture(t)
  const first = await f.slot('vm-seed')
  const vmPath = path.join(f.root, 'vms', `${first.vm.id}.json`)
  const vm = {
    ...first.vm,
    timezone: 'America/Chicago',
    locale: 'en_US.UTF-8',
    fingerprint: { device_id: 'stable-device', session_id: 'stable-session' },
  }
  fs.writeFileSync(vmPath, JSON.stringify(vm))
  const dir = path.join(first.exec.homeDir, '.claude')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ env: { CUSTOM: 'keep' } }))
  fs.writeFileSync(path.join(dir, 'kin-seed.json'), JSON.stringify({ timezone: null }))
  const installation = fs.readFileSync(path.join(f.root, 'vms', vm.id, 'run', 'codex-installation-id'), 'utf8')

  const result = await reloadSlotReady(vm, f.root, { ops: { reloadSlot: reloadContainer } })

  assert.equal(result.ok, true)
  const seed = JSON.parse(fs.readFileSync(path.join(dir, 'kin-seed.json'), 'utf8'))
  const settings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'))
  assert.equal(seed.timezone, vm.timezone)
  assert.equal(seed.locale, vm.locale)
  assert.equal(settings.env.TZ, vm.timezone)
  assert.equal(settings.env.LANG, vm.locale)
  assert.equal(settings.env.CUSTOM, 'keep')
  assert.deepEqual(JSON.parse(fs.readFileSync(vmPath, 'utf8')).fingerprint, vm.fingerprint)
  assert.equal(fs.readFileSync(path.join(f.root, 'vms', vm.id, 'run', 'codex-installation-id'), 'utf8'), installation)
})

test('controller warm preserves a live kernel and slot records, repairs seeds and leaves stopped slots alone', async (t) => {
  const f = await fixture(t)
  const first = await f.slot('vm-warm')
  const vm = { ...first.vm, status: 'running', timezone: 'America/Los_Angeles', locale: 'en_US.UTF-8' }
  const record = path.join(f.root, 'vms', `${vm.id}.json`)
  fs.writeFileSync(record, JSON.stringify(vm))
  const stopped = path.join(f.root, 'vms', 'vm-stopped.json')
  fs.writeFileSync(stopped, JSON.stringify({ id: 'vm-stopped', platform: 'openai', status: 'stopped' }))
  const before = fs.readFileSync(record, 'utf8')
  const report = await runFleetUpdate(f.root, { action: 'warm' })

  assert.equal(report.action, 'warm')
  assert.equal(report.failed_count, 0)
  assert.equal(report.skipped_count, 1)
  assert.equal((await codexKernelHealth(first.exec)).pid, first.health.pid)
  assert.equal(codexKernelTracked(vm.id), true)
  assert.equal(fs.readFileSync(record, 'utf8'), before)
  assert.equal(fs.existsSync(path.join(f.root, 'vms', 'vm-stopped')), false)
  const seed = JSON.parse(fs.readFileSync(path.join(first.exec.homeDir, '.claude', 'kin-seed.json'), 'utf8'))
  assert.equal(seed.timezone, vm.timezone)
  assert.equal(report.items.find((item) => item.id === vm.id).warm.kernel.reused, true)
})

test('GPT reload with eager_start disabled stops the old kernel and leaves lazy startup enabled', async (t) => {
  const f = await fixture(t)
  const first = await f.slot('vm-lazy')

  const result = await reloadSlotReady(first.vm, f.root, {
    routing: { inference: { eager_start: false } },
    ops: { reloadSlot: reloadContainer },
  })

  assert.equal(result.ok, true)
  assert.equal((await codexKernelHealth(first.exec)).ok, false)
})

test('a failed container reload leaves its running Codex kernel alone', async (t) => {
  const f = await fixture(t)
  const first = await f.slot('vm-failed')

  const result = await reloadSlotReady(first.vm, f.root, {
    ops: { reloadSlot: async () => ({ ok: false, error: 'container unavailable' }) },
  })

  assert.equal(result.ok, false)
  assert.equal((await codexKernelHealth(first.exec)).pid, first.health.pid)
})

test('GPT reload reports failure when the replacement kernel cannot become ready', async (t) => {
  const f = await fixture(t)
  const first = await f.slot('vm-start-fail')

  const result = await reloadSlotReady(first.vm, f.root, {
    ops: {
      reloadSlot: reloadContainer,
      ensureCodexKernel: async () => ({ ok: false, reason: 'health_timeout' }),
    },
  })

  assert.equal(result.ok, false)
  assert.equal(result.code, 'health_timeout')
})

test('a concurrent ensure waits for the exiting kernel before starting its replacement', async (t) => {
  const f = await fixture(t)
  const first = await f.slot('vm-overlap')

  const stopping = stopCodexKernelAndWait(first.exec)
  const starting = ensureCodexKernel(first.exec)
  assert.equal((await stopping).ok, true)
  assert.equal((await starting).ok, true)
  assert.notEqual((await codexKernelHealth(first.exec)).pid, first.health.pid)
})

test('a stop timeout preserves the tracked process and its socket', async (t) => {
  const f = await fixture(t)
  const first = await f.slot('vm-timeout')

  const stopped = await stopCodexKernelAndWait(first.exec, { termMs: 0, killMs: 0 })

  assert.equal(stopped.ok, false)
  assert.equal(stopped.reason, 'recycle_timeout')
  assert.equal(codexKernelTracked(first.vm.id), true)
  assert.equal(fs.existsSync(path.join(f.root, 'vms', first.vm.id, 'run', 'codex-kernel.sock')), true)
})

test('an untracked listener is reported instead of unlinking its live socket', async (t) => {
  const f = await fixture(t)
  const vm = { id: 'vm-untracked', platform: 'openai', proxy: { url: 'socks5h://127.0.0.1:1080' } }
  const exec = { vmId: vm.id, vm, homeDir: path.join(f.root, 'vms', vm.id, 'cli-home') }
  const written = writeCodexKernelConfig(f.root, vm)
  const server = http.createServer((_req, res) => res.end(JSON.stringify({ ok: true })))
  await new Promise((resolve) => server.listen(written.socketPath, resolve))
  try {
    const stopped = await stopCodexKernelAndWait(exec)
    assert.equal(stopped.ok, false)
    assert.equal(stopped.reason, 'untracked_kernel')
    assert.equal((await codexKernelHealth(exec)).ok, true)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('GPT reload reports a failed stop without starting another kernel', async (t) => {
  const f = await fixture(t)
  const first = await f.slot('vm-stop-fail')
  let starts = 0

  const result = await reloadSlotReady(first.vm, f.root, {
    ops: {
      reloadSlot: reloadContainer,
      stopCodexKernelAndWait: async () => ({ ok: false, reason: 'recycle_timeout' }),
      ensureCodexKernel: async () => {
        starts += 1
        return { ok: true }
      },
    },
  })

  assert.equal(result.ok, false)
  assert.equal(result.code, 'codex_kernel_reload_failed')
  assert.equal(starts, 0)
  assert.equal((await codexKernelHealth(first.exec)).pid, first.health.pid)
})
