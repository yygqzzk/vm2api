import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'

for (const upstream of ['anthropic', 'openai']) {
  for (const protocol of ['anthropic.messages', 'openai.chat']) {
    for (const stream of [false, true]) {
      test(`API tool name roundtrip: ${upstream} -> ${protocol}, stream=${stream}`, async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'api-tool-roundtrip-'))
        const socket = path.join(root, 'run/api-kernel.sock')
        fs.mkdirSync(path.dirname(socket), { recursive: true })
        const routing = { compatibility: { persona_preset: 'none', official_cc_passthrough: false }, failover: {} }
        const routingPath = path.join(root, 'routing.json')
        fs.writeFileSync(routingPath, JSON.stringify(routing))
        let wireName
        const kernel = http.createServer((req, res) => {
          const chunks = []
          req.on('data', (chunk) => chunks.push(chunk))
          req.on('end', () => {
            const envelope = JSON.parse(Buffer.concat(chunks).toString())
            const body = JSON.parse(envelope.body)
            wireName = body.tools[0].name
            const item = { type: 'function_call', id: 'fc_1', call_id: 'tool_1', name: wireName, arguments: '{}' }
            const events =
              upstream === 'openai'
                ? [
                    { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } },
                    {
                      type: 'response.function_call_arguments.done',
                      output_index: 0,
                      item_id: item.id,
                      arguments: item.arguments,
                    },
                    {
                      type: 'response.completed',
                      response: {
                        id: 'resp_1',
                        object: 'response',
                        status: 'completed',
                        output: [item],
                        usage: { input_tokens: 1, output_tokens: 1 },
                      },
                    },
                  ]
                : [
                    {
                      type: 'message_start',
                      message: {
                        type: 'message',
                        id: 'msg_1',
                        role: 'assistant',
                        model: body.model,
                        content: [],
                        usage: { input_tokens: 1, output_tokens: 0 },
                      },
                    },
                    {
                      type: 'content_block_start',
                      index: 0,
                      content_block: { type: 'tool_use', id: 'tool_1', name: wireName, input: {} },
                    },
                    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
                    { type: 'content_block_stop', index: 0 },
                    {
                      type: 'message_delta',
                      delta: { stop_reason: 'tool_use', stop_sequence: null },
                      usage: { output_tokens: 1 },
                    },
                    { type: 'message_stop' },
                  ]
            res.writeHead(200, { 'content-type': 'text/event-stream' })
            res.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''))
          })
        })
        await new Promise((resolve, reject) => {
          kernel.once('error', reject)
          kernel.listen(socket, resolve)
        })
        const response = {
          headersSent: false,
          chunks: [],
          on() {},
          once() {},
          off() {},
          write(value) {
            this.headersSent = true
            this.chunks.push(value)
          },
          end() {},
        }
        const callerTool = 'custom_lookup'
        const body = {
          model: 'claude-haiku-4-5',
          stream,
          messages: [{ role: 'user', content: 'hello' }],
          tools:
            protocol === 'anthropic.messages'
              ? [{ name: callerTool, input_schema: { type: 'object' } }]
              : [{ type: 'function', function: { name: callerTool, parameters: { type: 'object' } } }],
        }
        const handler = createHandleProtocol({
          json: (_res, status, output) => {
            response.status = status
            response.body = output
            return output
          },
          writeSSEHeaders: () => {
            response.headersSent = true
          },
          readBody: async () => body,
          requireAuth: () => true,
          cfg: {
            rewrite: { enabled: false },
            intercept: { rules: [] },
            distill: { enabled: false },
            limits: { max_body_bytes: 1 << 20, upstream_timeout_ms: 2000 },
            paths: { data: root },
          },
          requestLog: { start: () => ({ request_id: 'tool-roundtrip', t0: Date.now() }), finish() {} },
          stickyRouter: {},
          accountQuota: {},
          apiKeyStore: { acquire: () => ({ ok: true }), release() {} },
          apiScheduler: {
            pick: () => ({
              ok: true,
              endpoint: {
                id: 'ep-test',
                kind: upstream === 'openai' ? 'openai' : 'claude',
                protocol: upstream,
                base_url: 'https://fixture.invalid',
              },
              upstream_model: upstream === 'openai' ? 'gpt-5.4' : body.model,
              key: { id: 'fake-key', api_key: 'fixture' },
            }),
          },
          apiEndpointStore: {},
          stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
          routingConfigPath: routingPath,
          routingConfig: routing,
          groupsRepo: { rateMultiplier: () => 1 },
        })
        const pathname = protocol === 'anthropic.messages' ? '/v1/messages' : '/v1/chat/completions'
        const req = {
          method: 'POST',
          url: pathname,
          headers: { authorization: 'Bearer fixture', 'user-agent': 'test-client' },
          apiKeyKind: 'managed',
          apiKeyRecord: { category: 'api' },
          once() {},
          off() {},
        }
        try {
          await handler.handleProtocol(req, response, protocol, pathname)
          assert.notEqual(wireName, undefined, JSON.stringify(response.body))
          assert.equal(wireName, `mcp__${callerTool}`)
          const output = stream ? response.chunks.join('') : JSON.stringify(response.body)
          assert.ok(output.includes(callerTool), output)
          assert.equal(output.includes(wireName), false, output)
          if (!stream) assert.equal(response.status, 200)
        } finally {
          await new Promise((resolve) => kernel.close(resolve))
          fs.rmSync(root, { recursive: true, force: true })
        }
      })
    }
  }
}
