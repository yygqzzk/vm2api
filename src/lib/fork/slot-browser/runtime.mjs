import { setTimeout as delay } from 'node:timers/promises'
import { slotHost } from '../../vm/slot-host.mjs'
import { containerName } from '../../vm/vm-runtime.mjs'
import { isLocalEgressProxy, localEgressProxyUrl, slotNetworkForVm } from '../../vm/egress.mjs'
import { isCodexVm } from '../../vm/vm-kind.mjs'
import {
  containerAction,
  createContainerRaw,
  dockerJson,
  dockerRequest,
  inspectContainerOrNull,
  inspectNetworkOrNull,
  removeContainer,
} from '../../cluster/docker-remote.mjs'
import {
  BROWSER_FINGERPRINT_SCHEMA,
  BROWSER_LIMIT,
  BrowserError,
  browserNames,
  buildBrowserSpec,
  DEFAULT_BROWSER_IMAGE,
} from './spec.mjs'
import { browserRpc, browserTransport } from './transport.mjs'

function assertOwned(info, vmId) {
  if (info && (info.Config?.Labels?.['kin.browser'] !== '1' || info.Config.Labels['kin.browser.vm'] !== vmId)) {
    throw new BrowserError('browser_name_conflict', '同名容器不属于该槽位浏览器，拒绝操作')
  }
}

function sameProfileIdentity(volume, vm) {
  return (
    volume.Labels['kin.browser.owner'] === (vm.owner_user_id || '') &&
    volume.Labels['kin.browser.machine'] === (vm.fingerprint?.guest_machine_id || '')
  )
}

async function profileVolume(connect, vm) {
  const result = await dockerRequest(connect, { path: `/volumes/${browserNames(vm.id).volume}` })
  if (result.status === 404) return null
  if (result.status !== 200) throw new BrowserError('browser_volume', '无法检查浏览器数据卷', 502)
  let volume
  try {
    volume = JSON.parse(result.body.toString())
  } catch {
    throw new BrowserError('browser_volume', 'Docker 返回了无效的数据卷信息', 502)
  }
  if (volume?.Labels?.['kin.browser.vm'] !== vm.id || volume.Labels['kin.browser'] !== '1') {
    throw new BrowserError('browser_volume', '同名数据卷不属于该槽位浏览器，拒绝操作')
  }
  return volume
}

export function createBrowserRuntime({
  image = process.env.VM2API_BROWSER_IMAGE || DEFAULT_BROWSER_IMAGE,
  hostFor = slotHost,
} = {}) {
  function connector(vm) {
    const host = hostFor(vm)
    if (host.native) throw new BrowserError('browser_unsupported', '槽位浏览器目前只支持 Linux Docker 节点')
    return host.dockerApi()
  }

  async function fingerprintImage(connect) {
    const result = await dockerRequest(connect, { path: `/images/${encodeURIComponent(image)}/json` })
    if (result.status === 404) {
      throw new BrowserError(
        'browser_image_missing',
        `槽位所在节点缺少共享浏览器镜像 ${image}，请按 docs/fork/SLOT-BROWSER.md 构建`,
      )
    }
    if (result.status !== 200) throw new BrowserError('browser_image', '无法检查浏览器镜像', 502)
    const info = JSON.parse(result.body.toString())
    if (info.Config?.Labels?.['io.vm2api.browser.fingerprint'] !== BROWSER_FINGERPRINT_SCHEMA) {
      throw new BrowserError(
        'browser_image_incompatible',
        '浏览器镜像不支持槽位指纹，请按 docs/fork/SLOT-BROWSER.md 更新镜像',
      )
    }
    const engine = await dockerJson(connect, { path: '/version' })
    // Cross-architecture emulation can run Chrome while rejecting its seccomp filters.
    if (info.Os !== 'linux' || !['amd64', 'arm64'].includes(info.Architecture) || info.Architecture !== engine.Arch) {
      throw new BrowserError(
        'browser_image_platform',
        '请构建与节点 CPU 架构一致的 Linux 浏览器镜像，不支持跨架构模拟运行',
      )
    }
    return info.Id
  }

  async function stop(vm, { deleteProfile = false, resetProfile = false } = {}) {
    if (hostFor(vm).native) return
    const connect = connector(vm)
    const names = browserNames(vm.id)
    const resetName = `${names.container}-reset`
    const reset = await inspectContainerOrNull(connect, resetName)
    assertOwned(reset, vm.id)
    if (reset) {
      if (reset.Config?.Labels?.['kin.browser.profile-reset'] !== '1') {
        throw new BrowserError('browser_name_conflict', '同名容器不是浏览器清理任务，拒绝操作')
      }
      await removeContainer(connect, resetName)
    }
    const existing = await inspectContainerOrNull(connect, names.container)
    assertOwned(existing, vm.id)
    if (existing) {
      if (existing.State?.Running) await containerAction(connect, names.container, 'stop', { t: 12 })
      await removeContainer(connect, names.container)
    }
    if (!deleteProfile && !resetProfile) return
    const volume = await profileVolume(connect, vm)
    if (!volume) return
    if (deleteProfile || !sameProfileIdentity(volume, vm)) {
      await dockerJson(connect, { method: 'DELETE', path: `/volumes/${names.volume}` }, [204])
      return
    }
    const imageId = await fingerprintImage(connect)
    const id = await createContainerRaw(connect, resetName, {
      Image: imageId,
      User: '1000:1000',
      Entrypoint: ['python3', '/opt/slot-browser/desktop.py'],
      Cmd: ['reset-profile'],
      Labels: { 'kin.browser': '1', 'kin.browser.vm': vm.id, 'kin.browser.profile-reset': '1' },
      HostConfig: {
        NetworkMode: 'none',
        ReadonlyRootfs: true,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        Memory: 128 * 1024 * 1024,
        MemorySwap: 128 * 1024 * 1024,
        NanoCpus: 1_000_000_000,
        PidsLimit: 16,
        Mounts: [{ Type: 'volume', Source: names.volume, Target: '/profile' }],
        LogConfig: { Type: 'json-file', Config: { 'max-size': '1m', 'max-file': '1' } },
      },
    })
    try {
      await containerAction(connect, id, 'start')
      const result = await dockerJson(connect, {
        method: 'POST',
        path: `/containers/${encodeURIComponent(id)}/wait?condition=not-running`,
        timeoutMs: 60_000,
      })
      if (result.StatusCode !== 0 || result.Error?.Message) {
        throw new BrowserError('browser_profile_reset_failed', '浏览器登录态清理失败，请保留数据卷后检查', 502)
      }
    } finally {
      await removeContainer(connect, id)
    }
  }

  async function start(vm) {
    if (hostFor(vm).kind === 'local' && isCodexVm(vm) && isLocalEgressProxy(vm.proxy) && localEgressProxyUrl()) {
      throw new BrowserError(
        'browser_egress_mismatch',
        '该 GPT 本地槽使用部署级代理。请显式绑定同一个 SOCKS5 后再打开浏览器，避免登录与推理出口不一致',
      )
    }
    const connect = connector(vm)
    const parent = await inspectContainerOrNull(connect, containerName(vm.id))
    if (!parent?.State?.Running || parent.HostConfig?.NetworkMode !== slotNetworkForVm(vm)) {
      throw new BrowserError('browser_slot_not_ready', '请先启动槽位并确认其出口绑定已生效')
    }
    const network = await inspectNetworkOrNull(connect, slotNetworkForVm(vm))
    const spec = buildBrowserSpec(vm, network, { image })
    spec.body.Image = await fingerprintImage(connect)
    // A control-plane restart must not launch a second writer on the old profile.
    await stop(vm)
    const filters = encodeURIComponent(JSON.stringify({ label: ['kin.browser=1'] }))
    const running = await dockerJson(connect, { path: `/containers/json?filters=${filters}` })
    if (running.filter((entry) => entry.Labels?.['kin.browser.profile-reset'] !== '1').length >= BROWSER_LIMIT)
      throw new BrowserError('browser_limit', '节点同时最多开启 2 个槽位浏览器', 429)
    const names = browserNames(vm.id)
    const volume = await profileVolume(connect, vm)
    if (volume) {
      if (!sameProfileIdentity(volume, vm)) {
        throw new BrowserError(
          'browser_profile_changed',
          '槽位属主或计算机身份已改变。请管理员确认后重置浏览器登录态，旧数据不会自动交给新属主',
        )
      }
    } else {
      await dockerJson(
        connect,
        {
          method: 'POST',
          path: '/volumes/create',
          body: {
            Name: names.volume,
            Labels: {
              'kin.browser': '1',
              'kin.browser.vm': vm.id,
              'kin.browser.owner': vm.owner_user_id || '',
              'kin.browser.machine': vm.fingerprint?.guest_machine_id || '',
            },
          },
        },
        [201],
      )
    }
    await createContainerRaw(connect, spec.name, spec.body)
    try {
      await containerAction(connect, spec.name, 'start')
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        const info = await inspectContainerOrNull(connect, spec.name)
        if (!info?.State?.Running)
          throw new BrowserError(
            'browser_start_failed',
            '浏览器启动失败，请检查节点 sandbox、镜像及持久身份数据；不会自动重置身份或关闭 sandbox',
          )
        const state = await browserRpc(connect, spec.name, { op: 'status' }).catch(() => null)
        if (state?.ready)
          return { vm, connect, container: spec.name, environment: { ...spec.environment, identity: state.identity } }
        await delay(300)
      }
      throw new BrowserError('browser_start_timeout', '浏览器未能在 30 秒内就绪', 504)
    } catch (error) {
      await stop(vm)
      throw error
    }
  }

  return {
    start,
    stop,
    rpc: (session, message) => browserRpc(session.connect, session.container, message),
    transport: (session) => browserTransport(session.connect, session.container, 'vnc'),
  }
}
