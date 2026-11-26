import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { PassThrough } from 'node:stream'
import { gzipSync, zstdCompressSync } from 'node:zlib'
import { readBody, readRawBody } from '../../src/lib/http/respond.mjs'
import { ErrorCode } from '../../src/lib/core/errors.mjs'

function makeRequest(headers = {}, chunks = []) {
  const stream = new PassThrough()
  stream.headers = headers
  queueMicrotask(() => {
    for (const chunk of chunks) {
      stream.write(chunk)
    }
    stream.end()
  })
  return stream
}

test('readBody reads identity and uncompressed JSON bodies', async () => {
  const payload = { model: 'gpt-5', input: 'hello world' }
  const raw = Buffer.from(JSON.stringify(payload), 'utf8')
  const parsed = await readBody(makeRequest({}, [raw]), 4096)
  assert.deepEqual(parsed, payload)

  const identityParsed = await readBody(makeRequest({ 'content-encoding': 'identity' }, [raw]), 4096)
  assert.deepEqual(identityParsed, payload)
})

test('readBody and readRawBody decompress zstd and gzip payloads transparently', async () => {
  const payload = {
    model: 'gpt-5',
    input: 'repetitive prompt context '.repeat(400),
  }
  const raw = Buffer.from(JSON.stringify(payload), 'utf8')

  const zstdBytes = zstdCompressSync(raw)
  assert.ok(zstdBytes.length < raw.length)
  const fromZstd = await readBody(
    makeRequest({ 'content-encoding': 'zstd' }, [
      zstdBytes.subarray(0, Math.ceil(zstdBytes.length / 2)),
      zstdBytes.subarray(Math.ceil(zstdBytes.length / 2)),
    ]),
    65536,
  )
  assert.deepEqual(fromZstd, payload)

  const gzipBytes = gzipSync(raw)
  const rawFromGzip = await readRawBody(makeRequest({ 'content-encoding': 'GZIP' }, [gzipBytes]), 65536)
  assert.deepEqual(rawFromGzip, raw)
})

test('readBody and readRawBody handle 0-byte empty body cleanly for identity and compressed encodings', async () => {
  const emptyRaw = await readRawBody(makeRequest({}, []), 1024)
  assert.equal(emptyRaw.length, 0)

  const emptyZstd = await readBody(makeRequest({ 'content-encoding': 'zstd' }, []), 1024)
  assert.deepEqual(emptyZstd, {})

  const emptyGzip = await readRawBody(makeRequest({ 'content-encoding': 'gzip' }, []), 1024)
  assert.equal(emptyGzip.length, 0)
})

test('readBody rejects unsupported content-encoding with 415', async () => {
  await assert.rejects(
    () => readBody(makeRequest({ 'content-encoding': 'br' }, [Buffer.from('abc')]), 1024),
    (err) => err.status === 415 && err.body?.error?.code === 'unsupported_content_encoding',
  )
})

test('readBody rejects corrupt compressed payload with 400', async () => {
  await assert.rejects(
    () => readBody(makeRequest({ 'content-encoding': 'zstd' }, [Buffer.from('not-valid-zstd-frame')]), 1024),
    (err) => err.status === 400 && err.body?.error?.code === 'invalid_compressed_body',
  )

  await assert.rejects(
    () => readBody(makeRequest({ 'content-encoding': 'gzip' }, [Buffer.from('not-valid-gzip')]), 1024),
    (err) => err.status === 400 && err.body?.error?.code === 'invalid_compressed_body',
  )
})

test('readRawBody enforces maxBytes on both raw compressed stream and decompressed output', async () => {
  const rawTooBigForLimit = Buffer.from('A'.repeat(20000), 'utf8')
  const compressedBomb = zstdCompressSync(rawTooBigForLimit)
  assert.ok(compressedBomb.length < 512)

  await assert.rejects(
    () => readRawBody(makeRequest({ 'content-encoding': 'zstd' }, [compressedBomb]), 1024),
    (err) => err.status === 413 && err.body?.error?.code === ErrorCode.BODY_TOO_LARGE,
  )

  const noisy = randomBytes(2048)
  const bigCompressed = gzipSync(noisy)
  assert.ok(bigCompressed.length > 512)

  await assert.rejects(
    () => readRawBody(makeRequest({ 'content-encoding': 'gzip' }, [bigCompressed]), 512),
    (err) => err.status === 413 && err.body?.error?.code === ErrorCode.BODY_TOO_LARGE,
  )
})
