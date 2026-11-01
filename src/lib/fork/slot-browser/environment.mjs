import crypto from 'node:crypto'
import net from 'node:net'
import { getVm } from '../../vm/vm-registry.mjs'
import { syncProxyTimezones } from '../../vm/proxy-timezone.mjs'
import { validTimezone } from '../../core/timezone.mjs'
import { browserBinding, BrowserError } from './spec.mjs'

/** Use the pool's current exit, never the operator's network or a previous geo cache. */
export function createBrowserEnvironment({ projectRoot, proxyPool }) {
  return async function refreshEnvironment(vm) {
    const bound = proxyPool.getProxyForVm(vm.id)
    if (!bound || bound.id !== vm.proxy?.id) {
      throw new BrowserError('browser_proxy_unavailable', '槽位代理已变更、停用或不可用，请先确认代理绑定')
    }
    const snapshot = browserBinding(vm)
    const identity = bound.url
    const observed = await proxyPool.detectGeo(bound.id, { force: true })
    const current = getVm(projectRoot, vm.id)
    const live = proxyPool.getProxyForVm(vm.id)
    if (!current || browserBinding(current) !== snapshot || live?.id !== bound.id || live.url !== identity) {
      throw new BrowserError('browser_binding_changed', '检测期间槽位或代理已改变，请重新打开')
    }
    if (!observed.ok || !net.isIP(String(observed.geo?.ip || ''))) {
      throw new BrowserError(
        'browser_geo_failed',
        '无法确认代理实际出口，请稍后重试或在代理池重新测地理；不会使用旧缓存启动浏览器',
        502,
      )
    }
    if (
      proxyPool.followProxyTimezoneEnabled() &&
      current.timezone_source !== 'manual' &&
      !validTimezone(observed.geo.timezone)
    ) {
      throw new BrowserError(
        'browser_timezone_unknown',
        '代理地理结果没有有效时区，请重新测地理或手动固定槽位时区',
        502,
      )
    }
    await syncProxyTimezones(projectRoot, proxyPool, bound.id)
    return {
      vm: getVm(projectRoot, vm.id),
      // Only an opaque comparison key lives in the browser session. Actual geo
      // remains owned by the existing proxy pool, including its error metadata.
      exitKey: crypto.createHash('sha256').update(observed.geo.ip).digest('hex'),
    }
  }
}
