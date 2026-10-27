import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { streamCodexKernel } from '../../src/lib/transport/codex-kernel-client.mjs'
import { streamGoWorker } from '../../src/lib/transport/go-worker-client.mjs'
import { isCodexStreamCommitEvent } from '../../src/lib/transport/codex-stream-policy.mjs'
import { handleCodexProtocol, runCodexKernelHop } from '../../src/lib/protocol/handle-codex.mjs'
import { createRespond } from '../../src/lib/http/respond.mjs'
import { resetOpenAIAccountRuntime } from '../../src/lib/pool/openai-account-runtime.mjs'

const created = { type: 'response.created', response: { id: 'resp_test', status: 'in_progress', model: 'gpt-test' } }
const delta = { type: 'response.output_text.delta', delta: 'pong' }
const completed = {
  type: 'response.completed',
  response: { id: 'resp_test', status: 'completed', model: 'gpt-test', usage: { input_tokens: 3, output_tokens: 1 } },
}
const failure = { type: 'error', error: { type: 'server_error', code: 'upstream_transport', message: 'test failure' } }
const frame = (event) => `event: response\ndata: ${JSON.stringify(event)}\n\n`

function gate() {
  const { promise, resolve } = Promise.withResolvers()
  return { promise, release: resolve }
}

async function fixture(t, handler) {
  resetOpenAIAccountRuntime()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-early-'))
  const dir = path.join(root, 'vms', 'vm-test')
  const runDir = path.join(dir, 'run')
  fs.mkdirSync(runDir, { recursive: true })
  fs.mkdirSync(path.join(dir, 'cli-home'))
  const socket = path.join(runDir, 'codex-kernel.sock')
  fs.writeFileSync(path.join(runDir, 'internal.token'), 'test-only-token\n', { mode: 0o600 })
  const vm = {
    id: 'vm-test',
    platform: 'openai',
    family: 'codex',
    schedulable: true,
    status: 'running',
    has_token: true,
    runtime: { worker_socket: socket, codex_kernel_socket: socket },
  }
  fs.writeFileSync(path.join(root, 'vms', 'vm-test.json'), JSON.stringify(vm))
  fs.writeFileSync(
    path.join(dir, 'codex-credentials.json'),
    JSON.stringify({
      accounts: [{ id: 'test-account', access_token: 'fake-test-token', chatgpt_account_id: 'test-account' }],
    }),
  )
  let calls = 0
  const server = http.createServer(async (req, res) => {
    if (req.url.endsWith('/cancel')) {
      res.end('{"ok":true}')
      return
    }
    calls++
    assert.equal(req.headers['x-kin-internal-token'], 'test-only-token')
    for await (const _ of req) {
      /* drain the envelope */
    }
    try {
      await handler(req, res)
    } catch (error) {
      res.destroy(error)
    }
  })
  server.listen(socket)
  await once(server, 'listening')
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
    resetOpenAIAccountRuntime()
  })
  return {
    root,
    exec: { vmId: vm.id, vm, homeDir: path.join(dir, 'cli-home') },
    get calls() {
      return calls
    },
  }
}

const unixTest = process.platform === 'win32' ? test.skip : test
const options = { timeout: 8000 }
const envelope = { body: { model: 'gpt-test', stream: true, input: 'ping' }, stream: true }

test('fork early commit accepts only real in-progress lifecycle events or existing output', () => {
  assert.equal(isCodexStreamCommitEvent(created), true)
  assert.equal(isCodexStreamCommitEvent({ ...created, type: 'response.in_progress' }), true)
  for (const event of [
    null,
    {},
    failure,
    completed,
    { type: 'response.created' },
    { ...created, response: { id: '' } },
    { ...created, response: { id: 'resp_bad', status: 'failed' } },
    { ...created, response: { id: 'resp_bad', error: { code: 'bad' } } },
    { type: 'response_headers', headers: { secret: 'internal' } },
    { type: 'ping' },
  ])
    assert.equal(isCodexStreamCommitEvent(event), false)
  assert.equal(isCodexStreamCommitEvent(delta), true)
})

unixTest('Codex lifecycle reaches the consumer before output without inventing TTFT', options, async (t) => {
  const output = gate()
  t.after(output.release)
  const fx = await fixture(t, async (_req, res) => {
    res.setHeader('content-type', 'text/event-stream')
    // Internal diagnostics must never escape when the buffered frames are released early.
    res.write(
      'event: kin_outbound_headers\ndata: {"type":"kin_outbound_headers","headers":{"authorization":"secret"}}\n\n',
    )
    res.write(frame(created).slice(0, 40))
    await delay(10)
    res.write(frame(created).slice(40))
    await output.promise
    res.end(frame(completed))
  })
  const gotCreated = gate()
  const lines = []
  let commits = 0
  const resultPromise = streamCodexKernel({
    exec: fx.exec,
    envelope,
    forwardLifecycle: true,
    onCommit: () => commits++,
    onEvent: (line) => {
      lines.push(line)
      if (line.includes('"type":"response.created"')) gotCreated.release()
    },
  })
  await gotCreated.promise
  assert.equal(commits, 1)
  assert.doesNotMatch(lines.join('\n'), /secret|kin_outbound_headers|response.completed/)
  output.release()
  const result = await resultPromise
  assert.equal(result.committed, true)
  assert.equal(result.ttftMs, null)
  assert.ok(result.firstByteMs >= 0)
  assert.equal(commits, 1)
})

for (const kind of ['Codex default', 'shared Claude']) {
  unixTest(`${kind} still buffers lifecycle until output`, options, async (t) => {
    const output = gate()
    const sent = gate()
    t.after(output.release)
    const fx = await fixture(t, async (_req, res) => {
      res.setHeader('content-type', 'text/event-stream')
      res.write(frame(created))
      sent.release()
      await output.promise
      res.end(frame(delta) + frame(completed))
    })
    const lines = []
    const client = kind === 'Codex default' ? streamCodexKernel : streamGoWorker
    const pending = client({ exec: fx.exec, envelope, onEvent: (line) => lines.push(line) })
    await sent.promise
    await delay(30)
    assert.deepEqual(lines, [])
    output.release()
    const result = await pending
    assert.equal(result.committed, true)
    assert.match(lines.join('\n'), /response.created/)
    assert.ok(result.ttftMs >= result.firstByteMs)
  })
}

unixTest('a silent HTTP rejection stays retryable even with early SSE enabled', options, async (t) => {
  const fx = await fixture(t, (_req, res) => {
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '30' })
    res.end('{"error":{"code":"rate_limit_error"}}')
  })
  const result = await streamCodexKernel({
    exec: fx.exec,
    envelope,
    forwardLifecycle: true,
    onEvent: () => assert.fail('HTTP rejection must not reach SSE'),
  })
  assert.equal(result.status, 429)
  assert.equal(result.committed, false)
  assert.equal(result.headers['retry-after'], '30')
})

unixTest('an error before lifecycle stays invisible and can retry once', options, async (t) => {
  const fx = await fixture(t, (_req, res) => {
    res.setHeader('content-type', 'text/event-stream')
    res.end(frame(failure))
  })
  const result = await runCodexKernelHop({
    hop: streamCodexKernel,
    args: { exec: fx.exec, envelope, forwardLifecycle: true },
    onEvent: () => assert.fail('pre-lifecycle failure must stay buffered'),
  })
  assert.equal(fx.calls, 2)
  assert.equal(result.committed, false)
  assert.equal(result.transport_retried, true)
})

unixTest('an error after lifecycle never replays or retries the account', options, async (t) => {
  const fx = await fixture(t, (_req, res) => {
    res.setHeader('content-type', 'text/event-stream')
    res.end(frame(created) + frame(failure))
  })
  const lines = []
  const result = await runCodexKernelHop({
    hop: streamCodexKernel,
    args: { exec: fx.exec, envelope, forwardLifecycle: true },
    onEvent: (line) => lines.push(line),
  })
  assert.equal(fx.calls, 1)
  assert.equal(result.committed, true)
  assert.equal(result.ok, false)
  assert.equal(result.transport_retried, undefined)
  assert.equal(result.ttftMs, null)
  assert.match(lines.join('\n'), /response.created/)
  assert.match(lines.join('\n'), /upstream_transport/)
})

unixTest('disconnect after lifecycle cancels the hop, without stamping a token', options, async (t) => {
  const fx = await fixture(t, (_req, res) => {
    res.setHeader('content-type', 'text/event-stream')
    res.write(frame(created))
  })
  const abort = new AbortController()
  const result = await streamCodexKernel({
    exec: fx.exec,
    envelope,
    forwardLifecycle: true,
    signal: abort.signal,
    onEvent: (line) => {
      if (line.includes('response.created')) abort.abort()
    },
  })
  assert.equal(result.committed, true)
  assert.equal(result.body.error.code, 'client_cancelled')
  assert.equal(result.ttftMs, null)
})

for (const [protocol, stream] of [
  ['openai.responses', false],
  ['openai.chat', true],
  ['anthropic.messages', true],
]) {
  unixTest(`${protocol} stream=${stream} retains the original commit policy`, options, async (t) => {
    const fx = await fixture(t, (_req, res) => res.end())
    const inbound = {
      model: 'gpt-test',
      input: 'ping',
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 32,
      stream,
    }
    const res = {
      headersSent: false,
      write() {
        this.headersSent = true
      },
      end() {},
    }
    let calls = 0
    await handleCodexProtocol({
      req: { headers: {} },
      res,
      protocol,
      ctx: { path: '/v1/responses', body: inbound },
      inbound,
      logBag: {},
      stats: { errors: 0, requests: 0, by_route: {} },
      routing: {
        codex: {
          protocols: { 'anthropic.messages': { mode: 'convert', enabled: true } },
          convert: { anthropic_to_codex: true },
        },
      },
      projectRoot: fx.root,
      json: () => {},
      writeSSEHeaders: () => {
        res.headersSent = true
      },
      ops: {
        writeCodexKernelConfig: () => ({}),
        ensureCodexKernel: async () => ({ ok: true }),
        streamCodexKernel: async ({ forwardLifecycle }) => {
          calls++
          assert.equal(forwardLifecycle, false)
          return { ok: true, status: 200, body: completed.response, terminalState: 'verified' }
        },
      },
    })
    assert.equal(calls, 1)
  })
}

for (const early of [false, true]) {
  unixTest(
    `HTTP Responses first packet is ${early ? 'immediate' : 'buffered (upstream baseline)'}`,
    options,
    async (t) => {
      const fx = await fixture(t, async (_req, res) => {
        res.setHeader('content-type', 'text/event-stream')
        res.write(frame(created))
        await delay(600)
        res.end(frame(delta) + frame(completed))
      })
      const logBag = {}
      const handlers = createRespond({ rewrite: { enabled: false } })
      const gateway = http.createServer(async (req, res) => {
        const inbound = { model: 'gpt-test', input: 'ping', stream: true }
        await handleCodexProtocol({
          req,
          res,
          protocol: 'openai.responses',
          ctx: { path: req.url, body: inbound },
          inbound,
          logBag,
          stats: { errors: 0, requests: 0, by_route: {} },
          ...handlers,
          routing: {},
          projectRoot: fx.root,
          requestStartedAt: Date.now(),
          ops: {
            writeCodexKernelConfig: () => ({}),
            ensureCodexKernel: async () => ({ ok: true }),
            streamCodexKernel: (opts) => {
              assert.equal(opts.forwardLifecycle, true)
              return streamCodexKernel({ ...opts, forwardLifecycle: early })
            },
          },
        })
      })
      gateway.listen(0, '127.0.0.1')
      await once(gateway, 'listening')
      t.after(async () => {
        gateway.closeAllConnections()
        await new Promise((resolve) => gateway.close(resolve))
      })
      const started = Date.now()
      let firstPacketMs = null
      let textMs = null
      let wire = ''
      await new Promise((resolve, reject) => {
        http
          .get(`http://127.0.0.1:${gateway.address().port}/v1/responses`, (res) => {
            assert.equal(res.statusCode, 200)
            res.on('data', (chunk) => {
              wire += chunk
              if (firstPacketMs == null) firstPacketMs = Date.now() - started
              if (textMs == null && wire.includes('"delta":"pong"')) textMs = Date.now() - started
            })
            res.on('end', resolve)
            res.on('error', reject)
          })
          .on('error', reject)
      })
      assert.match(wire, /event: response.created\ndata:/)
      assert.match(wire, /event: response.completed\ndata:/)
      if (early) assert.ok(textMs - firstPacketMs >= 400, `${firstPacketMs} vs ${textMs}`)
      else assert.ok(firstPacketMs >= 550, `${firstPacketMs}`)
      assert.ok(logBag.first_token_ms - logBag.first_byte_ms >= 500)
      assert.equal(fx.calls, 1)
      t.diagnostic(
        JSON.stringify({ firstPacketMs, textMs, firstByteMs: logBag.first_byte_ms, ttftMs: logBag.first_token_ms }),
      )
    },
  )
}
