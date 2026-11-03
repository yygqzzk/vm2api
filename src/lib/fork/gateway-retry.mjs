import { isClientCancelledResult } from '../core/errors.mjs'

export const GATEWAY_RETRY_HEADER = 'x-vm2api-retry'

const POOL_ADMISSION_ERRORS = new Set([
  'capacity_unavailable',
  'session_window_full',
  'pool_wait_queue_full',
  'pool_resting',
  'quota_exhausted',
  'no_codex_vm',
])

/** No execution was admitted; another independently configured pool may serve it. */
export function poolAdmissionRetry(reason) {
  return POOL_ADMISSION_ERRORS.has(reason) ? 'next-channel' : 'never'
}

/** Only a confirmed rejection can authorize restarting inference in another pool. */
export function gatewayRetryDecision(result, { stateBound = false } = {}) {
  if (!result || result.ok || result.committed || stateBound || isClientCancelledResult(result)) return 'never'
  if (
    result.gatewayOutcomeUnknown === true ||
    result.transport_retried === true ||
    result.rust_transport_retried === true ||
    result.transportError ||
    result.jobHeld === true ||
    result.executionReleased === false ||
    result.terminalState === 'incomplete' ||
    result.finalState === 'incomplete'
  )
    return 'outcome-unknown'
  const error = result.body?.error
  const code = String(error?.code || result.error_code || '')
  if (
    error?.details?.retryable === false ||
    result.policy?.scope === 'request' ||
    /invalid|bad_request|content_policy|usage_policy|refusal|guard|not_portable|tool_arguments|protocol_error|key_group|model_not_allowed|permission_error/i.test(
      `${code} ${error?.type || ''}`,
    )
  )
    return 'never'
  const status = Number(result.status)
  if (
    [408, 504, 524].includes(status) ||
    /timeout|network|transport|interrupted|incomplete|empty_stream|empty_response/i.test(code)
  )
    return 'outcome-unknown'
  if (error && [401, 403, 429].includes(status)) return 'next-channel'
  if (
    error &&
    [500, 502, 503, 529].includes(status) &&
    /^(server_error|provider_error|upstream_error|overloaded_error|internal_error|no_capacity|overloaded|codex_kernel_unavailable|account_pool_exhausted|pool_overloaded|pool_unavailable|pool_rate_limited|quota_exhausted)$/.test(
      code,
    )
  )
    return 'next-channel'
  return status >= 500 ? 'outcome-unknown' : 'never'
}
