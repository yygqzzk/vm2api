import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import zlib from 'node:zlib'
import {
  admitCodexCandidate,
  classifyCodexStickyKey,
  codexStickyCanaryBucket,
  estimateCodexNonImageTextBytes,
  handleCodexProtocol,
} from '../../src/lib/protocol/handle-codex.mjs'
import { readBody } from '../../src/lib/http/respond.mjs'
import { StickyRouter } from '../../src/lib/pool/sticky-router.mjs'
import {
  OPENAI_MAX_WAITERS,
  openAIWaiterCount,
  resetOpenAIAccountRuntime,
  tryAcquireOpenAISlot,
  waitForOpenAICapacity,
} from '../../src/lib/pool/openai-account-runtime.mjs'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { RequestAttemptsRepo } from '../../src/lib/db/repos/request-attempts-repo.mjs'
import { UsageLogsRepo } from '../../src/lib/db/repos/usage-logs-repo.mjs'

let keepAlive = null
before(() => {
  // waitForOpenAICapacity unrefs its timer so systemd workers can idle-exit;
  // keep one ref'd handle while this test file runs on Node 22.
  keepAlive = setInterval(() => {}, 10_000)
})
after(() => {
  if (keepAlive) clearInterval(keepAlive)
})

beforeEach(() => resetOpenAIAccountRuntime())

function writeGptVm(root, id, policy = { maxConcurrency: 2 }) {
  const dir = path.join(root, 'vms')
  fs.mkdirSync(path.join(dir, id), { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({
      id,
      name: id,
      platform: 'openai',
      family: 'codex',
      schedulable: true,
      status: 'running',
      has_token: true,
      policy,
    }),
  )
  fs.writeFileSync(
    path.join(dir, id, 'codex-credentials.json'),
    JSON.stringify({
      accounts: [{ id: `${id}-acc`, access_token: 'at', refresh_token: 'rt', chatgpt_account_id: id }],
    }),
  )
}

function emptyRes() {
  return { headersSent: false, statusCode: 0, body: null, write() {}, end() {} }
}

function makeLongBody(bytes = 410_000, model = 'gpt-6.2-astra') {
  return {
    model,
    stream: false,
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'x'.repeat(bytes) }] }],
  }
}

test('bound ultra-long request short-waits and hits home when seat releases in window', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-sw-hit-'))
  const sticky = new StickyRouter({ dataDir: path.join(root, 'data'), config: { sticky: { enabled: true } } })
  t.after(() => {
    sticky.db.close()
    resetOpenAIAccountRuntime()
    fs.rmSync(root, { recursive: true, force: true })
  })
  writeGptVm(root, 'vm-gpt-a', { maxConcurrency: 2 })
  writeGptVm(root, 'vm-gpt-b', { maxConcurrency: 2 })

  const sessionId = 'sess-sw-hit-1'
  sticky.bind(`p:openai:${sessionId}`, { vmId: 'vm-gpt-a', accountId: 'vm-gpt-a', sessionId: 'out-a' })
  const h1 = tryAcquireOpenAISlot('vm-gpt-a', { concurrency: 2 })
  const h2 = tryAcquireOpenAISlot('vm-gpt-a', { concurrency: 2 })
  assert.ok(h1 && h2)

  setTimeout(() => h1.release(), 100)
  const logBag = {}
  const body = makeLongBody(410_000)
  const res = emptyRes()
  const seen = []
  await handleCodexProtocol({
    req: { headers: { 'x-session-id': sessionId }, apiKeyKind: 'user', _kinBodyBytes: 420_000 },
    res,
    protocol: 'openai.responses',
    ctx: { body },
    inbound: body,
    logBag,
    stats: { errors: 0, requests: 0, by_route: {} },
    json: (_r, status, payload) => {
      res.statusCode = status
      res.body = payload
      return payload
    },
    writeSSEHeaders() {},
    routing: {
      sticky: { enabled: true },
      codex: { sticky_wait: { enabled: true, timeout_ms: 1000, min_text_bytes: 393216, sample_pct: 100 } },
    },
    projectRoot: root,
    stickyRouter: sticky,
    ops: {
      writeCodexKernelConfig() {},
      ensureCodexKernel: async () => ({ ok: true }),
      streamCodexKernel: async ({ exec }) => {
        seen.push(exec.vmId)
        return { ok: true, status: 200, terminalState: 'verified', body: { id: 'resp_hit' } }
      },
    },
  })
  h2.release()
  assert.equal(res.statusCode, 200)
  assert.deepEqual(seen, ['vm-gpt-a'])
  assert.equal(logBag.hop_meta?.codex_schedule?.outcome, 'sticky_hit_after_wait')
  assert.equal(logBag.hop_meta?.codex_schedule?.home_vm_id, 'vm-gpt-a')
  assert.equal(logBag.hop_meta?.codex_schedule?.selected_vm_id, 'vm-gpt-a')
  assert.ok(logBag.hop_meta?.codex_schedule?.sticky_wait_ms > 0)
})

test('short-wait timeout borrows fresh idle slot without extending deadline on stolen wakeups', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-sw-timeout-'))
  const sticky = new StickyRouter({ dataDir: path.join(root, 'data'), config: { sticky: { enabled: true } } })
  t.after(() => {
    sticky.db.close()
    resetOpenAIAccountRuntime()
    fs.rmSync(root, { recursive: true, force: true })
  })
  writeGptVm(root, 'vm-gpt-a', { maxConcurrency: 2 })
  writeGptVm(root, 'vm-gpt-b', { maxConcurrency: 2 })
  const sessionId = 'sess-sw-timeout-1'
  sticky.bind(`p:openai:${sessionId}`, { vmId: 'vm-gpt-a', accountId: 'vm-gpt-a', sessionId: 'out-a' })
  const h1 = tryAcquireOpenAISlot('vm-gpt-a', { concurrency: 2 })
  const h2 = tryAcquireOpenAISlot('vm-gpt-a', { concurrency: 2 })
  let thief = null
  setTimeout(() => {
    h1.release()
    thief = tryAcquireOpenAISlot('vm-gpt-a', { concurrency: 2 })
  }, 20)

  const t0 = Date.now()
  const admitted = await admitCodexCandidate(
    root,
    { headers: { 'x-session-id': sessionId }, apiKeyKind: 'user', _kinBodyBytes: 420_000 },
    {
      stickyRouter: sticky,
      body: makeLongBody(410_000),
      routing: {
        codex: { sticky_wait: { enabled: true, timeout_ms: 80, min_text_bytes: 393216, sample_pct: 100 } },
      },
    },
    { deadline: t0 + 2000 },
  )
  const elapsed = Date.now() - t0
  admitted.lease.release()
  thief?.release()
  h2.release()
  assert.equal(admitted.vmId, 'vm-gpt-b')
  assert.equal(admitted.decision.outcome, 'borrowed_after_wait')
  assert.ok(elapsed < 300, `sticky_wait deadline unexpectedly extended: ${elapsed}ms`)
  assert.equal(sticky.resolve(`p:openai:${sessionId}`)?.vmId, 'vm-gpt-a')
})

test('optional short-wait queue_full borrows idle slot immediately without 429', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-sw-qfull-'))
  const sticky = new StickyRouter({ dataDir: path.join(root, 'data'), config: { sticky: { enabled: true } } })
  t.after(() => {
    sticky.db.close()
    resetOpenAIAccountRuntime()
    fs.rmSync(root, { recursive: true, force: true })
  })
  writeGptVm(root, 'vm-gpt-a', { maxConcurrency: 2 })
  writeGptVm(root, 'vm-gpt-b', { maxConcurrency: 2 })
  const sessionId = 'sess-sw-qfull-1'
  sticky.bind(`p:openai:${sessionId}`, { vmId: 'vm-gpt-a', accountId: 'vm-gpt-a', sessionId: 'out-a' })
  const h1 = tryAcquireOpenAISlot('vm-gpt-a', { concurrency: 2 })
  const h2 = tryAcquireOpenAISlot('vm-gpt-a', { concurrency: 2 })

  const blockers = Array.from({ length: OPENAI_MAX_WAITERS }, () =>
    waitForOpenAICapacity({ deadline: Date.now() + 5000, accounts: ['vm-gpt-a'] }),
  )
  assert.equal(openAIWaiterCount(), OPENAI_MAX_WAITERS)

  const res = emptyRes()
  const logBag = {}
  const body = makeLongBody(410_000)
  await handleCodexProtocol({
    req: { headers: { 'x-session-id': sessionId }, apiKeyKind: 'user', _kinBodyBytes: 420_000 },
    res,
    protocol: 'openai.responses',
    ctx: { body },
    inbound: body,
    logBag,
    stats: { errors: 0, requests: 0, by_route: {} },
    json: (_r, status, payload) => {
      res.statusCode = status
      res.body = payload
      return payload
    },
    writeSSEHeaders() {},
    routing: { codex: { sticky_wait: { enabled: true, timeout_ms: 4000, min_text_bytes: 393216 } } },
    projectRoot: root,
    stickyRouter: sticky,
    ops: {
      writeCodexKernelConfig() {},
      ensureCodexKernel: async () => ({ ok: true }),
      streamCodexKernel: async ({ exec }) => {
        assert.equal(exec.vmId, 'vm-gpt-b')
        return { ok: true, status: 200, terminalState: 'verified', body: { id: 'resp_borrow' } }
      },
    },
  })
  h1.release()
  h2.release()
  resetOpenAIAccountRuntime()
  await Promise.all(blockers)
  assert.equal(res.statusCode, 200)
  assert.equal(logBag.hop_meta?.codex_schedule?.outcome, 'borrowed_queue_full')
  assert.equal(logBag.hop_meta?.codex_schedule?.selected_vm_id, 'vm-gpt-b')
})

test('readBody zstd decompress sets _kinBodyBytes and image/base64 payloads do not trigger sticky wait', async (t) => {
  const payload = {
    model: 'gpt-6.2-astra',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'describe this image' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(500_000)}` } },
        ],
      },
    ],
  }
  const jsonBuf = Buffer.from(JSON.stringify(payload), 'utf8')
  const compressed = zlib.zstdCompressSync(jsonBuf)
  const reqStream = Readable.from([compressed])
  reqStream.headers = { 'content-encoding': 'zstd' }
  const parsed = await readBody(reqStream, 10 * 1024 * 1024)
  assert.equal(reqStream._kinBodyBytes, jsonBuf.length)
  assert.ok(reqStream._kinBodyBytes > 393216)
  const estimated = estimateCodexNonImageTextBytes(parsed, 393216)
  assert.ok(estimated >= Buffer.byteLength('describe this image', 'utf8') && estimated < 1024)

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-sw-img-'))
  const sticky = new StickyRouter({ dataDir: path.join(root, 'data'), config: { sticky: { enabled: true } } })
  t.after(() => {
    sticky.db.close()
    resetOpenAIAccountRuntime()
    fs.rmSync(root, { recursive: true, force: true })
  })
  writeGptVm(root, 'vm-gpt-a', { maxConcurrency: 2 })
  writeGptVm(root, 'vm-gpt-b', { maxConcurrency: 2 })
  sticky.bind('p:openai:sess-img', { vmId: 'vm-gpt-a', accountId: 'vm-gpt-a', sessionId: 'out-a' })
  const h1 = tryAcquireOpenAISlot('vm-gpt-a', { concurrency: 2 })
  const h2 = tryAcquireOpenAISlot('vm-gpt-a', { concurrency: 2 })

  const t0 = Date.now()
  const imgAdmitted = await admitCodexCandidate(
    root,
    { headers: { 'x-session-id': 'sess-img' }, apiKeyKind: 'user', _kinBodyBytes: jsonBuf.length },
    {
      stickyRouter: sticky,
      body: parsed,
      routing: { codex: { sticky_wait: { enabled: true, timeout_ms: 4000, min_text_bytes: 393216 } } },
    },
    { deadline: t0 + 5000 },
  )
  assert.ok(Date.now() - t0 < 200)
  imgAdmitted.lease.release()
  assert.equal(imgAdmitted.vmId, 'vm-gpt-b')
  assert.equal(imgAdmitted.decision.outcome, 'borrowed_short_context')

  // Short request with small _kinBodyBytes fast-gates without scanning body text.
  const shortAdmitted = await admitCodexCandidate(
    root,
    { headers: { 'x-session-id': 'sess-img' }, apiKeyKind: 'user', _kinBodyBytes: 1200 },
    {
      stickyRouter: sticky,
      body: { model: 'gpt-6.2-astra', input: 'x'.repeat(500_000) },
      routing: { codex: { sticky_wait: { enabled: true, timeout_ms: 4000, min_text_bytes: 393216 } } },
    },
    { deadline: Date.now() + 5000 },
  )
  shortAdmitted.lease.release()
  assert.equal(shortAdmitted.decision.outcome, 'borrowed_short_context')
  assert.equal(shortAdmitted.decision.text_bytes, null)
  h1.release()
  h2.release()
})

test('disabled toggle, timeout_ms=0, and sample_pct control group skip waiting with 0ms delay', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-sw-cfg-'))
  const sticky = new StickyRouter({ dataDir: path.join(root, 'data'), config: { sticky: { enabled: true } } })
  t.after(() => {
    sticky.db.close()
    resetOpenAIAccountRuntime()
    fs.rmSync(root, { recursive: true, force: true })
  })
  writeGptVm(root, 'vm-gpt-a', { maxConcurrency: 2 })
  writeGptVm(root, 'vm-gpt-b', { maxConcurrency: 2 })
  const h1 = tryAcquireOpenAISlot('vm-gpt-a', { concurrency: 2 })
  const h2 = tryAcquireOpenAISlot('vm-gpt-a', { concurrency: 2 })

  let controlKey = null
  for (let i = 0; i < 100; i++) {
    const k = `p:openai:canary-sess-${i}`
    if (codexStickyCanaryBucket(k) >= 50) {
      controlKey = k
      break
    }
  }
  assert.ok(controlKey)
  const rawSess = controlKey.replace(/^p:openai:/, '')
  sticky.bind(controlKey, { vmId: 'vm-gpt-a', accountId: 'vm-gpt-a', sessionId: 'out-a' })

  const disabled = await admitCodexCandidate(
    root,
    { headers: { 'x-session-id': rawSess }, _kinBodyBytes: 420_000 },
    {
      stickyRouter: sticky,
      body: makeLongBody(410_000),
      routing: { pool: { sticky_wait_timeout_ms: 5000 }, codex: { sticky_wait: { enabled: false, timeout_ms: 4000 } } },
    },
    { deadline: Date.now() + 5000 },
  )
  disabled.lease.release()
  assert.equal(disabled.decision.outcome, 'borrowed_wait_disabled')
  assert.equal(disabled.decision.sticky_wait_ms, 0)

  const zeroTimeout = await admitCodexCandidate(
    root,
    { headers: { 'x-session-id': rawSess }, _kinBodyBytes: 420_000 },
    {
      stickyRouter: sticky,
      body: makeLongBody(410_000),
      routing: { pool: { sticky_wait_timeout_ms: 5000 }, codex: { sticky_wait: { enabled: true, timeout_ms: 0 } } },
    },
    { deadline: Date.now() + 5000 },
  )
  zeroTimeout.lease.release()
  assert.equal(zeroTimeout.decision.outcome, 'borrowed_wait_disabled')
  assert.equal(zeroTimeout.decision.sticky_wait_ms, 0)

  const canaryControl = await admitCodexCandidate(
    root,
    { headers: { 'x-session-id': rawSess }, _kinBodyBytes: 420_000 },
    {
      stickyRouter: sticky,
      body: makeLongBody(410_000),
      routing: { codex: { sticky_wait: { enabled: true, timeout_ms: 4000, sample_pct: 50 } } },
    },
    { deadline: Date.now() + 5000 },
  )
  canaryControl.lease.release()
  assert.equal(canaryControl.decision.outcome, 'borrowed_canary_control')
  assert.equal(canaryControl.decision.sticky_wait_ms, 0)
  h1.release()
  h2.release()
})

test('unconsumed wakeup on home VM is passed to next queued waiter when first waiter aborts', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-sw-handoff-'))
  const sticky = new StickyRouter({ dataDir: path.join(root, 'data'), config: { sticky: { enabled: true } } })
  t.after(() => {
    sticky.db.close()
    resetOpenAIAccountRuntime()
    fs.rmSync(root, { recursive: true, force: true })
  })
  writeGptVm(root, 'vm-gpt-a', { maxConcurrency: 1 })
  sticky.bind('p:openai:s1', { vmId: 'vm-gpt-a', accountId: 'vm-gpt-a', sessionId: 'out-1' })
  sticky.bind('p:openai:s2', { vmId: 'vm-gpt-a', accountId: 'vm-gpt-a', sessionId: 'out-2' })

  const held = tryAcquireOpenAISlot('vm-gpt-a', { concurrency: 1 })
  const ac1 = new AbortController()
  const w1 = admitCodexCandidate(
    root,
    { headers: { 'x-session-id': 's1' }, _kinBodyBytes: 420_000 },
    { stickyRouter: sticky, body: makeLongBody(410_000) },
    { deadline: Date.now() + 5000, signal: ac1.signal },
  )
  await new Promise((r) => setTimeout(r, 20))
  const w2 = admitCodexCandidate(
    root,
    { headers: { 'x-session-id': 's2' }, _kinBodyBytes: 420_000 },
    { stickyRouter: sticky, body: makeLongBody(410_000) },
    { deadline: Date.now() + 5000 },
  )
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(openAIWaiterCount(), 2)

  // Release the home seat while aborting Waiter 1 in the same turn so its unconsumed wake must pass to Waiter 2.
  held.release()
  ac1.abort()
  const [r1, r2] = await Promise.all([w1, w2])
  assert.equal(r1.picked.error, 'client_cancelled')
  assert.equal(r1.decision.outcome, 'cancelled')
  assert.equal(r2.vmId, 'vm-gpt-a')
  r2.lease.release()
})

test('normal mode records prompt-free RequestAttemptsRepo decision and UsageLogsRepo counts sticky:after_wait', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-codex-sw-repo-'))
  const db = openDatabase({ dataDir: path.join(root, 'data') })
  const attemptsRepo = new RequestAttemptsRepo(db)
  const usageLogs = new UsageLogsRepo(db)
  const sticky = new StickyRouter({ db, config: { sticky: { enabled: true } } })
  t.after(() => {
    closeDatabase()
    resetOpenAIAccountRuntime()
    fs.rmSync(root, { recursive: true, force: true })
  })
  writeGptVm(root, 'vm-gpt-a', { maxConcurrency: 2 })
  writeGptVm(root, 'vm-gpt-b', { maxConcurrency: 2 })
  const secretPrompt = 'SUPER_SECRET_USER_PROMPT_SHOULD_NEVER_BE_LOGGED_' + 'z'.repeat(400_000)
  const body = {
    model: 'gpt-6.2-astra',
    stream: false,
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: secretPrompt }] }],
  }
  const reqId = 'req-codex-obs-1'
  const sessionId = 'sess-obs-1'
  sticky.bind(`p:openai:${sessionId}`, { vmId: 'vm-gpt-a', accountId: 'vm-gpt-a', sessionId: 'out-a' })
  const h1 = tryAcquireOpenAISlot('vm-gpt-a', { concurrency: 2 })
  const h2 = tryAcquireOpenAISlot('vm-gpt-a', { concurrency: 2 })
  setTimeout(() => h1.release(), 80)

  const logBag = {}
  const res = { ...emptyRes(), _kinRequestId: reqId }
  await handleCodexProtocol({
    req: { headers: { 'x-session-id': sessionId }, apiKeyKind: 'user', _kinBodyBytes: 405_000 },
    res,
    requestId: reqId,
    attemptsRepo,
    protocol: 'openai.responses',
    ctx: { body },
    inbound: body,
    logBag,
    stats: { errors: 0, requests: 0, by_route: {} },
    json: (_r, status, payload) => {
      res.statusCode = status
      res.body = payload
      return payload
    },
    writeSSEHeaders() {},
    routing: { codex: { sticky_wait: { enabled: true, timeout_ms: 1000, min_text_bytes: 393216 } } },
    projectRoot: root,
    stickyRouter: sticky,
    ops: {
      writeCodexKernelConfig() {},
      ensureCodexKernel: async () => ({ ok: true }),
      streamCodexKernel: async () => ({
        ok: true,
        status: 200,
        ttftMs: 123,
        hopRequestId: 'hop-1',
        terminalState: 'verified',
        usage: { input_tokens: 1000, output_tokens: 20, input_tokens_details: { cached_tokens: 900 } },
        body: { id: 'resp_obs' },
      }),
    },
  })
  h2.release()

  const rows = attemptsRepo.list(reqId)
  assert.equal(rows.length, 1)
  const row = rows[0]
  assert.equal(row.vm_id, 'vm-gpt-a')
  assert.equal(row.selection_reason, 'sticky:after_wait')
  assert.equal(row.terminal_state, 'verified')
  assert.equal(row.ttft_ms, 123)
  assert.ok(row.wait_ms > 0)
  assert.ok(row.queue_wait_ms > 0)
  assert.equal(row.usage.codex_schedule.outcome, 'sticky_hit_after_wait')
  assert.equal(row.usage.codex_schedule.key_source, 'session')
  assert.equal(row.usage.codex_schedule.key_fp, classifyCodexStickyKey(`p:openai:${sessionId}`).fp)
  assert.equal(JSON.stringify(row).includes('SUPER_SECRET_USER_PROMPT'), false)
  assert.equal(JSON.stringify(logBag.hop_meta).includes('SUPER_SECRET_USER_PROMPT'), false)

  const hitStats = usageLogs._stickyWindow()
  assert.equal(hitStats.selections, 1)
  assert.equal(hitStats.hits, 1)
  assert.equal(hitStats.rate, 1)
})
