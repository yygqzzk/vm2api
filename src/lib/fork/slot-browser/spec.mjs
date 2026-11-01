import crypto from 'node:crypto'
import { validTimezone } from '../../core/timezone.mjs'
import { isLocalEgressProxy, portsForProxy, slotNetworkForVm } from '../../vm/egress.mjs'
import { isKvmRuntime } from '../../vm/runtime-kind.mjs'
import { browserSeccomp } from './seccomp.mjs'

export const DEFAULT_BROWSER_IMAGE = 'local/vm2api-slot-browser:1'
export const BROWSER_LIMIT = 2
export const TICKET_TTL_MS = 30_000
export const IDLE_MS = 300_000

export class BrowserError extends Error {
  constructor(code, message, status = 409) {
    super(message)
    this.code = code
    this.status = status
  }
}

export function browserNames(vmId) {
  if (typeof vmId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(vmId)) {
    throw new BrowserError('invalid_vm', '槽位 ID 不合法', 400)
  }
  const key = crypto.createHash('sha256').update(vmId).digest('hex').slice(0, 24)
  return { container: `kin-browser-${key}`, volume: `kin-browser-profile-${key}` }
}

export function browserEnvironment(vm) {
  if (isKvmRuntime(vm)) throw new BrowserError('browser_unsupported', '槽位浏览器目前只支持 Linux Docker 槽')
  const timezone = validTimezone(vm.timezone) || 'UTC'
  const locale = vm.locale || 'en_US.UTF-8'
  if (!/^[a-z]{2,3}_[A-Z]{2}\.UTF-?8$/i.test(locale)) {
    throw new BrowserError('browser_locale', '请先将槽位语言设为 UTF-8 locale，例如 en_US.UTF-8')
  }
  let language
  try {
    language = Intl.getCanonicalLocales(locale.split('.')[0].replace('_', '-'))[0]
  } catch {
    throw new BrowserError('browser_locale', '槽位语言不合法')
  }
  const languages = [language, language.split('-')[0]].filter((value, index, all) => all.indexOf(value) === index)
  return { timezone, locale, language, languages: languages.join(','), screen: '1280x800' }
}

// Hash secrets rather than persisting or returning them. A changed exit, owner,
// node or environment invalidates the running browser's lease.
export function browserBinding(vm) {
  const proxy = vm.proxy || {}
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify([
        vm.node_id || '',
        vm.owner_user_id || null,
        [proxy.id, proxy.url, proxy.host, proxy.port, proxy.username, proxy.password, proxy.enabled],
        vm.timezone || '',
        vm.locale || '',
        vm.runtime?.type || 'docker',
      ]),
    )
    .digest('hex')
}

export function navigationUrl(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new BrowserError('invalid_url', '需要有效的 HTTPS 地址', 400)
  }
  if (url.protocol !== 'https:' || url.username || url.password || String(value).length > 16384) {
    throw new BrowserError('invalid_url', '只允许 HTTPS 地址，不允许在地址中携带用户名密码', 400)
  }
  return url.href
}

export function buildBrowserSpec(vm, network, { image = DEFAULT_BROWSER_IMAGE } = {}) {
  const env = browserEnvironment(vm)
  const names = browserNames(vm.id)
  const netName = slotNetworkForVm(vm)
  const local = isLocalEgressProxy(vm.proxy)
  if (!netName || network?.Name !== netName || network.Driver !== 'bridge' || network.EnableIPv6) {
    throw new BrowserError('browser_network', '槽位出口网络未就绪或不是受支持的 IPv4 bridge')
  }
  if (!local && network.Options?.['com.docker.network.bridge.enable_ip_masquerade'] !== 'false') {
    throw new BrowserError('browser_network', '代理出口网络未禁用直连 NAT，拒绝启动浏览器')
  }
  const gateway = network.IPAM?.Config?.find((entry) => entry.Gateway && !entry.Gateway.includes(':'))?.Gateway
  if (!gateway) throw new BrowserError('browser_network', '槽位出口网络没有 IPv4 网关')
  const dnsHost = local ? '8.8.8.8' : gateway
  const dnsPort = local ? 53 : portsForProxy(vm.proxy.id).dns
  return {
    name: names.container,
    environment: { ...env, egress: local ? 'local' : 'socks5', proxy_id: vm.proxy.id },
    body: {
      Image: image,
      Hostname: 'slot-browser',
      Env: [
        `TZ=${env.timezone}`,
        `LANG=${env.locale}`,
        `LC_ALL=${env.locale}`,
        `BROWSER_LANGUAGE=${env.language}`,
        `BROWSER_LANGUAGES=${env.languages}`,
        `BROWSER_DNS_HOST=${dnsHost}`,
        `BROWSER_DNS_PORT=${dnsPort}`,
      ],
      Labels: { 'kin.browser': '1', 'kin.browser.vm': vm.id, 'kin.browser.binding': browserBinding(vm) },
      HostConfig: {
        NetworkMode: netName,
        RestartPolicy: { Name: 'no' },
        ReadonlyRootfs: true,
        Memory: 1536 * 1024 * 1024,
        MemorySwap: 1536 * 1024 * 1024,
        NanoCpus: 1_000_000_000,
        PidsLimit: 256,
        ShmSize: 256 * 1024 * 1024,
        CapDrop: ['ALL'],
        // Only the fixed entrypoint uses these to install namespace-local rules
        // and change UID. setpriv removes them before starting Chromium.
        CapAdd: ['NET_ADMIN', 'SETUID', 'SETGID', 'SETPCAP', 'CHOWN', 'FOWNER'],
        SecurityOpt: ['no-new-privileges', `seccomp=${browserSeccomp}`],
        Sysctls: {
          'net.ipv6.conf.all.disable_ipv6': '1',
          'net.ipv6.conf.default.disable_ipv6': '1',
          // Namespace-local DNS DNAT/SNAT; INPUT remains default DROP.
          'net.ipv4.conf.all.route_localnet': '1',
        },
        Dns: ['8.8.8.8'],
        Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=256m,mode=1777', '/run/browser': 'rw,nosuid,nodev,noexec,size=8m' },
        Mounts: [{ Type: 'volume', Source: names.volume, Target: '/profile' }],
        LogConfig: { Type: 'json-file', Config: { 'max-size': '1m', 'max-file': '1' } },
      },
    },
  }
}
