import test from 'node:test'
import assert from 'node:assert/strict'
import { gatewayRetryDecision, poolAdmissionRetry } from '../../src/lib/fork/gateway-retry.mjs'
import { createRespond } from '../../src/lib/http/respond.mjs'

const rejected = { ok: false, status: 503, body: { error: { code: 'server_error', message: 'unavailable' } } }

for (const [name, result, expected] of [
  ['confirmed rejection', rejected, 'next-channel'],
  [
    'generic 5xx is not proof',
    { ...rejected, body: { error: { code: 'unknown_gateway_failure' } } },
    'outcome-unknown',
  ],
  ['timeout with generic code', { ...rejected, status: 504 }, 'outcome-unknown'],
  ['pool exhausted', { ...rejected, status: 429, body: { error: { code: 'pool_rate_limited' } } }, 'next-channel'],
  ['earlier uncertain execution', { ...rejected, gatewayOutcomeUnknown: true }, 'outcome-unknown'],
  ['hidden transport retry', { ...rejected, transport_retried: true }, 'outcome-unknown'],
  ['network outcome unknown', { ...rejected, transportError: true }, 'outcome-unknown'],
  ['kernel job still held', { ...rejected, jobHeld: true }, 'outcome-unknown'],
  ['execution not released', { ...rejected, executionReleased: false }, 'outcome-unknown'],
  ['incomplete buffered generation', { ...rejected, terminalState: 'incomplete' }, 'outcome-unknown'],
  ['timeout', { ...rejected, body: { error: { code: 'worker_timeout' } } }, 'outcome-unknown'],
  ['committed output', { ...rejected, committed: true }, 'never'],
  ['invalid input', { ...rejected, body: { error: { code: 'invalid_request' } } }, 'never'],
  [
    'policy refusal',
    { ...rejected, body: { error: { code: 'refusal_guard', details: { retryable: false } } } },
    'never',
  ],
  ['request scoped failure', { ...rejected, policy: { scope: 'request', action: 'stop' } }, 'never'],
  ['success', { ok: true, status: 200 }, 'never'],
]) {
  test(`outer gateway retry: ${name}`, () => assert.equal(gatewayRetryDecision(result), expected))
}

test('account-owned continuation and admission authorization cannot move to another pool', () => {
  assert.equal(gatewayRetryDecision(rejected, { stateBound: true }), 'never')
  assert.equal(poolAdmissionRetry('quota_exhausted'), 'next-channel')
  assert.equal(poolAdmissionRetry('pool_wait_queue_full'), 'next-channel')
  assert.equal(poolAdmissionRetry('vm_pool_unavailable'), 'never')
  assert.equal(poolAdmissionRetry('response_not_portable'), 'never')
})

test('HTTP errors expose only the explicit gateway decision, defaulting to never', () => {
  const { json } = createRespond({ rewrite: { enabled: false } })
  for (const decision of [undefined, 'next-channel', 'outcome-unknown']) {
    let headers
    const res = {
      _kinRequestId: 'execution-1',
      _kinGatewayRetry: decision,
      writeHead(_status, value) {
        headers = value
      },
      end() {},
    }
    json(res, 503, rejected.body)
    assert.equal(headers['x-vm2api-retry'], decision || 'never')
    assert.equal(headers['x-request-id'], 'execution-1')
  }
})
