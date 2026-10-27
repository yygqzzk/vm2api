import { isDownstreamCommitEvent } from './go-worker-client.mjs'

export function isCodexStreamCommitEvent(event) {
  // A real response id commits this attempt; callers must not replay it after forwarding.
  if (
    (event?.type === 'response.created' || event?.type === 'response.in_progress') &&
    typeof event.response?.id === 'string' &&
    event.response.id.length > 0 &&
    !event.response.error &&
    (!event.response.status || event.response.status === 'in_progress')
  ) {
    return true
  }
  return isDownstreamCommitEvent(event)
}
