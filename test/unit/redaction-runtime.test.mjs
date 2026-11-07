import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
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

afterEach(() => {
  helper?.kill()
  helper = null
  publishRedactionForTests(null)
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

  it('masks and restores through the real helper and API hop when enabled', { timeout: 60_000 }, async (t) => {
    if (!fs.existsSync(bin)) {
      execFileSync('go', ['build', '-o', bin, './cmd/kin-redact'], {
        cwd: path.join(process.cwd(), 'redact'),
        stdio: 'inherit',
      })
    }
    const policy = { enabled: true, secrets: true, personal: false, words: [], rules: [] }
    const routing = { redaction: policy }
    const state = await ensureRedaction(routing, { projectRoot: root, binPath: bin })
    assert.equal(state.ready, true)
    helper = state.child
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

    fs.mkdirSync(path.join(root, 'run'))
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
})
