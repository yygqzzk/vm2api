#!/usr/bin/env node
// Local Docker acceptance only: actual gateway/Unix-socket client, no provider calls.
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'

if (process.env.VM2API_CORRELATION_FIXTURE !== '1') throw new Error('Local acceptance opt-in required')
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const modeFile = path.join(process.env.KIN_DATA_DIR, 'fixture-mode')
const frame = (event) => `event: response\ndata: ${JSON.stringify(event)}\n\n`
const server = http.createServer(async (req, res) => {
  if (req.headers['x-kin-internal-token'] !== config.internal_token) {
    res.writeHead(401).end('{}')
    return
  }
  if (req.url === '/internal/health' || req.url.endsWith('/cancel')) {
    res.end('{"ok":true}')
    return
  }
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const envelope = JSON.parse(Buffer.concat(chunks).toString())
  const mode = fs.readFileSync(modeFile, 'utf8').trim()
  if (mode === 'unknown' || (mode === 'mixed' && config.vm_id.endsWith('-1'))) { res.destroy(); return }
  if (mode === 'reject' || mode === 'invalid' || mode === 'mixed') {
    res.writeHead(mode === 'invalid' ? 400 : 503, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { type: mode === 'invalid' ? 'invalid_request_error' : 'server_error', code: mode === 'invalid' ? 'invalid_request' : 'server_error', message: 'controlled pool rejection' } }))
    return
  }
  const model = envelope.body?.model || 'gpt-5.5'
  const response = {
    id: 'resp_fixture', object: 'response', status: 'completed', model,
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'controlled backup succeeded', annotations: [] }] }],
    usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write(frame({ type: 'response.created', response: { id: response.id, status: 'in_progress', model } }))
  const delta = frame({ type: 'response.output_text.delta', delta: 'controlled backup succeeded' })
  if (mode === 'after-output') {
    res.write(delta, () => res.destroy())
    return
  }
  res.write(delta)
  res.end(frame({ type: 'response.completed', response }))
})
server.listen(config.socket_path)
process.on('SIGTERM', () => { server.closeAllConnections(); server.close(() => process.exit(0)) })
