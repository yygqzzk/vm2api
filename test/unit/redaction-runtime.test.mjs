import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { after, afterEach, describe, it } from 'node:test'
import { runApiInference } from '../../src/lib/pool/api-protocol.mjs'
import * as converters from '../../src/lib/protocol/convert.mjs'
import {
  ensureRedaction,
  maskJson,
  publishRedactionForTests,
  restoreJsonValue,
} from '../../src/lib/redaction/runtime.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-redact-runtime-'))
const bin = process.env.KIN_REDACT_BIN || path.join(root, 'kin-redact')
let helper = null

afterEach(async () => {
  try {
    if (helper && helper.exitCode === null && helper.signalCode === null) {
      const closed = once(helper, 'close')
      helper.kill()
      await closed
    }
  } finally {
    helper = null
    publishRedactionForTests(null)
  }
})
after(() => fs.rmSync(root, { recursive: true, force: true }))

describe('redaction runtime', () => {
  it('stays out of the request path when the switch is off', async () => {
    const state = await ensureRedaction({}, { projectRoot: root, binPath: bin })
    assert.equal(state.enabled, false)
    assert.equal(state.ready, true)
    const body = { messages: [{ role: 'user', content: 'sk-proj-Aa1Bb2Cc3Dd4Ee5Ff6Gg' }] }
    assert.deepEqual(await maskJson(body, { principal: 'key-a' }), body)
  })

  it('rejects an older helper that cannot enforce the requested limit', async () => {
    const oldBin = path.join(root, 'old-helper.mjs')
    fs.writeFileSync(
      oldBin,
      `#!${process.execPath}
import fs from 'node:fs'
import http from 'node:http'
const arg = (name) => process.argv[process.argv.indexOf(name) + 1]
http.createServer((req, res) => {
  req.resume()
  res.end(JSON.stringify({ protocol: 1 }))
}).listen(arg('-sock'), () => fs.writeFileSync(arg('-capability'), 'synthetic-capability'))
`,
      { mode: 0o700 },
    )
    await assert.rejects(
      ensureRedaction(
        { redaction: { enabled: true, secrets: true, personal: false } },
        { projectRoot: root, binPath: oldBin },
      ),
      { code: 'redaction_unavailable', status: 503, message: /must be rebuilt/ },
    )
  })

  it('masks and restores through the real helper and API hop when enabled', { timeout: 60_000 }, async (t) => {
    if (!fs.existsSync(bin)) {
      execFileSync('go', ['build', '-o', bin, './cmd/kin-redact'], {
        cwd: path.join(process.cwd(), 'redact'),
        stdio: 'inherit',
      })
    }
    const policy = { enabled: true, secrets: true, personal: false, words: [], rules: [] }
    const routing = { redaction: policy, failover: { max_request_mib: 64 } }
    const state = await ensureRedaction(routing, { projectRoot: root, binPath: bin })
    assert.equal(state.ready, true)
    helper = state.child
    assert.equal(state.maxBodyBytes, 64 * 1024 * 1024)
    const secret = 'sk-' + 'proj-' + 'Aa1Bb2Cc3Dd4Ee5Ff6Gg'
    const body = { model: 'claude-haiku-4-5', messages: [{ role: 'user', content: `token ${secret}` }] }
    const context = { principal: 'key-a', session: 's1' }
    const masked = await maskJson(body, context)
    const text = JSON.stringify(masked)
    assert.equal(text.includes(secret), false)
    assert.ok(text.includes('{{R_API_KEY_'))
    assert.ok(JSON.stringify(await restoreJsonValue(masked, context)).includes(secret))
    assert.equal(
      JSON.stringify(await restoreJsonValue(masked, { ...context, principal: 'key-b' })).includes(secret),
      false,
    )

    fs.mkdirSync(path.join(root, 'run'), { recursive: true })
    let posted
    const kernel = http.createServer(async (req, res) => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      posted = JSON.parse(JSON.parse(Buffer.concat(chunks)).body)
      const events = [
        {
          type: 'message_start',
          message: { id: 'msg_redact', type: 'message', role: 'assistant', content: [], model: body.model },
        },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: posted.messages[0].content } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
        { type: 'message_stop' },
      ]
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''))
    })
    await new Promise((resolve, reject) => {
      kernel.once('error', reject)
      kernel.listen(path.join(root, 'run/api-kernel.sock'), resolve)
    })
    t.after(() => new Promise((resolve) => kernel.close(resolve)))
    const result = await runApiInference({
      cfg: { paths: { data: root, project: root } },
      scheduler: {
        pick: () => ({
          ok: true,
          endpoint: { id: 'endpoint', kind: 'claude', protocol: 'anthropic', base_url: 'https://example.invalid' },
          upstream_model: body.model,
          key: { id: 'fake-key', api_key: 'fixture' },
        }),
      },
      protocol: 'anthropic.messages',
      inbound: body,
      convertedBody: body,
      clientStream: false,
      converters,
      routing,
      redactionPrincipal: context.principal,
      redactionSession: context.session,
    })
    assert.equal(result.ok, true, JSON.stringify(result.body))
    assert.equal(JSON.stringify(posted).includes(secret), false)
    assert.ok(JSON.stringify(posted).includes('{{R_API_KEY_'))
    assert.ok(JSON.stringify(result.body).includes(secret))
  })

  it('processes a body above 32 MiB when the panel allows 64 MiB', { timeout: 60_000 }, async () => {
    if (!fs.existsSync(bin)) {
      execFileSync('go', ['build', '-o', bin, './cmd/kin-redact'], {
        cwd: path.join(process.cwd(), 'redact'),
        stdio: 'inherit',
      })
    }
    const policy = { enabled: true, secrets: false, personal: false, words: ['synthetic-secret'] }
    const state = await ensureRedaction(
      { redaction: policy, failover: { max_request_mib: 64 } },
      { projectRoot: root, binPath: bin },
    )
    helper = state.child
    const raw = { principal: 'synthetic-repro', session: 'raw', policy, maxBodyBytes: 63 }
    assert.equal((await state.client.mask({ ...raw, body: '界'.repeat(21) })).body, '界'.repeat(21))
    for (const body of ['界'.repeat(21) + 'x', '界'.repeat(128 * 1024)]) {
      await assert.rejects(state.client.mask({ ...raw, body }), { status: 413, code: 'redaction_body_too_large' })
    }
    const ctx = { principal: 'synthetic-repro', session: 'large-body', maxBodyBytes: state.maxBodyBytes }
    const original = { probe: 'synthetic-secret' }
    const saved = await maskJson(original, ctx)
    assert.ok(!saved.probe.includes('synthetic-secret'))
    const overhead = Buffer.byteLength(JSON.stringify({ data: '', probe: '__END__' }))
    for (const bytes of [32 * 1024 * 1024 + 1, 33761894, 64 * 1024 * 1024]) {
      const body = { data: 'x'.repeat(bytes - overhead), probe: '__END__' }
      const masked = await maskJson(body, ctx)
      assert.equal(masked.data.length, body.data.length)
      assert.equal(masked.probe, '__END__')
      const restored = await restoreJsonValue(masked, ctx)
      assert.equal(restored.data, body.data)
      assert.equal(restored.probe, '__END__')
    }

    const resized = await ensureRedaction(
      { redaction: policy, failover: { max_request_mib: 8 } },
      { projectRoot: root, binPath: bin },
    )
    assert.equal(resized.maxBodyBytes, 8 * 1024 * 1024)
    assert.equal(resized.child, helper)
    const oversized = { data: 'x'.repeat(8 * 1024 * 1024 + 1 - Buffer.byteLength('{"data":""}')) }
    const current = { principal: ctx.principal, session: ctx.session }
    for (const transform of [maskJson, restoreJsonValue]) {
      await assert.rejects(transform(oversized, current), (error) => {
        assert.equal(error.status, 413)
        assert.equal(error.code, 'redaction_body_too_large')
        assert.equal(error.details.retryable, false)
        return true
      })
    }
    // A request that already captured the previous limit keeps that limit.
    assert.equal((await maskJson(oversized, ctx)).data.length, oversized.data.length)
    assert.deepEqual(await restoreJsonValue(saved, current), original)
    const raised = await ensureRedaction(
      { redaction: policy, failover: { max_request_mib: 128 } },
      { projectRoot: root, binPath: bin },
    )
    assert.equal(raised.maxBodyBytes, 128 * 1024 * 1024)
    assert.equal(raised.child, helper)
  })
})
