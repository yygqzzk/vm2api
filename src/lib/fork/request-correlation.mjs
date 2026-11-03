/** Diagnostic correlation only; never a session, authorization or billing identity. */
export function requestCorrelation(req) {
  const raw = req?.headers?.['x-oneapi-request-id']
  const id = typeof raw === 'string' ? raw.trim() : ''
  const correlationId = id && id.length <= 128 && !/[\x00-\x1f\x7f]/.test(id) ? id : null
  const index = req?.headers?.['x-oneapi-retry-index']
  const retryIndex = typeof index === 'string' && /^\d{1,6}$/.test(index) ? Number(index) : null
  return { correlation_id: correlationId, retry_index: correlationId ? retryIndex : null }
}
