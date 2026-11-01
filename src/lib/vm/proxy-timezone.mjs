/**
 * "Slot follows its proxy" timezone default.
 *
 * Binding an exit node in Tokyo while the slot still claims America/Los_Angeles
 * is a fingerprint contradiction the upstream can see (`# Environment - Timezone`
 * vs the exit IP). After every bind the slot adopts the proxy's detected zone,
 * unless the operator pinned one by hand (`vm.timezone_source === 'manual'`).
 */
import { validTimezone } from '../core/timezone.mjs'
import { isLocalEgressProxy, localEgressIdForNode } from './egress.mjs'
import { slotHost } from './slot-host.mjs'
import { getVm, persistVmTimezone } from './vm-registry.mjs'

/**
 * @param {object} opts
 * @param {boolean} opts.force  apply even over a manually pinned timezone
 * @param {boolean} opts.detect run a geo lookup when the proxy has no location yet
 * @param {boolean} opts.refresh re-query the actual exit without overriding manual timezone policy
 * @returns {Promise<{ok: boolean, applied: boolean, timezone: string|null, reason: string|null}>}
 */
export async function syncVmTimezoneFromProxy(
  projectRoot,
  proxyPool,
  vmId,
  { force = false, detect = true, refresh = false, proxyId = null, persist = true } = {},
) {
  const id = String(vmId || '').trim()
  if (!id || !proxyPool) return skip('vm_id_required')
  if (!force && !proxyPool.followProxyTimezoneEnabled()) return skip('follow_proxy_timezone_disabled')
  const vm = getVm(projectRoot, id)
  if (!vm) return skip('vm_not_found')
  if (!force && vm.timezone_source === 'manual') return skip('timezone_pinned')
  const currentIdentity = (value) =>
    JSON.stringify([value?.proxy, value?.node_id, value?.timezone, value?.timezone_source])
  const identity = currentIdentity(vm)

  const bound = proxyId || vm.proxy?.id || null
  const boundRow = vm.proxy?.id === bound ? vm.proxy : { id: bound }
  const host = slotHost(vm)
  let timezone = ''
  const nodeRow = host.nodeId ? localEgressIdForNode(host.nodeId) : null
  if (bound && nodeRow && isLocalEgressProxy(boundRow) && proxyPool.getProxyByIdWithAuth?.(nodeRow)) {
    // The slot leaves from its own node: that VPS's local row carries its geo.
    timezone = proxyPool.proxyTimezone(nodeRow)
    if ((!timezone || refresh) && detect) {
      const detected = await proxyPool.detectGeo(nodeRow, { force: refresh })
      if (!detected?.ok) return skip(detected?.error || 'geo_lookup_failed')
      timezone = validTimezone(detected.geo?.timezone)
    }
  } else if (bound && host.nodeId && isLocalEgressProxy(boundRow)) {
    // No node row (local egress never seeded): ask the node's route directly.
    let url
    try {
      url = host.localExitProxyUrl(vm)
    } catch (err) {
      return skip(err?.code || 'node_egress_unavailable')
    }
    const exit = await proxyPool.exitGeo(`node:${host.nodeId}`, url, { detect, force: refresh })
    if (!exit.ok) return skip(exit.error)
    timezone = validTimezone(exit.geo?.timezone)
  } else {
    timezone = bound ? proxyPool.proxyTimezone(bound) : proxyPool.timezoneForVm(id)
    if ((!timezone || refresh) && detect && bound) {
      const detected = await proxyPool.detectGeo(bound, { force: refresh })
      if (!detected?.ok) return skip(detected?.error || 'geo_lookup_failed')
      timezone = validTimezone(detected.geo?.timezone)
    }
  }
  if (!timezone) return skip('proxy_timezone_unknown')
  // A bind/manual edit can finish while geo is in flight; do not overwrite it.
  if (currentIdentity(getVm(projectRoot, id)) !== identity) return skip('vm_changed')
  if (!force && !proxyPool.followProxyTimezoneEnabled()) return skip('follow_proxy_timezone_disabled')
  if (vm.timezone === timezone) {
    // Already aligned, but re-stamp the source so the panel stops showing the
    // zone as hand-pinned once the operator opted back into following.
    if (persist && force && vm.timezone_source !== 'proxy_geo') {
      persistVmTimezone(projectRoot, id, timezone, { source: 'proxy_geo' })
    }
    return { ok: true, applied: false, timezone, reason: 'already_current' }
  }
  if (!persist) return { ok: true, applied: true, timezone, reason: null }
  const summary = persistVmTimezone(projectRoot, id, timezone, { source: 'proxy_geo' })
  if (!summary) return skip('persist_failed')
  return { ok: true, applied: true, timezone, reason: null }
}

/** Apply one already-observed proxy location consistently to every still-bound slot. */
export async function syncProxyTimezones(projectRoot, proxyPool, proxyId, { beforeApply } = {}) {
  const ids = proxyPool.snapshot().proxies.find((proxy) => proxy.id === proxyId)?.bound_vm_ids || []
  const targets = ids.filter((id) => getVm(projectRoot, id)?.proxy?.id === proxyId)
  const changed = []
  for (const id of targets) {
    const preview = await syncVmTimezoneFromProxy(projectRoot, proxyPool, id, {
      proxyId,
      detect: false,
      persist: false,
    })
    if (preview.applied) changed.push(id)
  }
  if (changed.length) await beforeApply?.(changed)
  const timezones = []
  for (const id of targets) {
    if (getVm(projectRoot, id)?.proxy?.id !== proxyId) continue
    const result = await syncVmTimezoneFromProxy(projectRoot, proxyPool, id, { proxyId, detect: false })
    timezones.push({ vm_id: id, ...result })
  }
  return timezones
}

/** A slot without a zone takes its exit's; a set zone (manual or already synced) stays. */
export async function fillVmTimezoneFromExit(projectRoot, proxyPool, vmId) {
  const vm = getVm(projectRoot, vmId)
  if (!vm?.proxy?.id || validTimezone(vm.timezone)) return null
  return syncVmTimezoneFromProxy(projectRoot, proxyPool, vmId, { force: true, refresh: true })
}

function skip(reason) {
  return { ok: false, applied: false, timezone: null, reason }
}
