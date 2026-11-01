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
  imagePresent,
  inspectContainerOrNull,
  inspectNetworkOrNull,
  removeContainer,
} from '../../cluster/docker-remote.mjs'
import { BROWSER_LIMIT, BrowserError, browserNames, buildBrowserSpec, DEFAULT_BROWSER_IMAGE } from './spec.mjs'
import { browserRpc, browserTransport } from './transport.mjs'

function assertOwned(info, vmId) {
  if (info && (info.Config?.Labels?.['kin.browser'] !== '1' || info.Config.Labels['kin.browser.vm'] !== vmId)) {
    throw new BrowserError('browser_name_conflict', '同名容器不属于该槽位浏览器，拒绝操作')
  }
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

  async function stop(vm, { deleteProfile = false } = {}) {
    if (hostFor(vm).native) return
    const connect = connector(vm)
    const names = browserNames(vm.id)
    const existing = await inspectContainerOrNull(connect, names.container)
    assertOwned(existing, vm.id)
    if (existing) {
      if (existing.State?.Running) await containerAction(connect, names.container, 'stop', { t: 12 })
      await removeContainer(connect, names.container)
    }
    if (deleteProfile) {
      const result = await dockerRequest(connect, { path: `/volumes/${names.volume}` })
      if (result.status === 404) return
      if (result.status !== 200) throw new BrowserError('browser_volume', '无法检查浏览器数据卷', 502)
      let volume
      try {
        volume = JSON.parse(result.body.toString())
      } catch {
        throw new BrowserError('browser_volume', 'Docker 返回了无效的数据卷信息', 502)
      }
      if (volume.Labels?.['kin.browser.vm'] !== vm.id || volume.Labels?.['kin.browser'] !== '1') {
        throw new BrowserError('browser_volume', '数据卷不属于该槽位浏览器，拒绝删除')
      }
      await dockerJson(connect, { method: 'DELETE', path: `/volumes/${names.volume}` }, [204])
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
    if (!(await imagePresent(connect, image))) {
      throw new BrowserError(
        'browser_image_missing',
        `槽位所在节点缺少共享浏览器镜像 ${image}，请按 docs/fork/SLOT-BROWSER.md 构建`,
      )
    }
    // A control-plane restart must not launch a second writer on the old profile.
    await stop(vm)
    const filters = encodeURIComponent(JSON.stringify({ label: ['kin.browser=1'] }))
    const running = await dockerJson(connect, { path: `/containers/json?filters=${filters}` })
    if (running.length >= BROWSER_LIMIT) throw new BrowserError('browser_limit', '节点同时最多开启 2 个槽位浏览器', 429)
    const names = browserNames(vm.id)
    const volumeResult = await dockerRequest(connect, { path: `/volumes/${names.volume}` })
    if (volumeResult.status === 200) {
      let volume
      try {
        volume = JSON.parse(volumeResult.body.toString())
      } catch {
        throw new BrowserError('browser_volume', 'Docker 返回了无效的数据卷信息', 502)
      }
      if (volume.Labels?.['kin.browser.vm'] !== vm.id || volume.Labels?.['kin.browser'] !== '1') {
        throw new BrowserError('browser_volume', '同名数据卷不属于该槽位浏览器')
      }
      if (
        volume.Labels['kin.browser.owner'] !== (vm.owner_user_id || '') ||
        volume.Labels['kin.browser.machine'] !== (vm.fingerprint?.guest_machine_id || '')
      ) {
        throw new BrowserError(
          'browser_profile_changed',
          '槽位属主或计算机身份已改变。请管理员确认后重置浏览器登录态，旧数据不会自动交给新属主',
        )
      }
    } else if (volumeResult.status === 404) {
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
    } else throw new BrowserError('browser_volume', '无法检查浏览器数据卷', 502)
    await createContainerRaw(connect, spec.name, spec.body)
    try {
      await containerAction(connect, spec.name, 'start')
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        const info = await inspectContainerOrNull(connect, spec.name)
        if (!info?.State?.Running)
          throw new BrowserError(
            'browser_start_failed',
            '浏览器启动失败，请检查节点 sandbox 与镜像运行条件；不会自动关闭 sandbox',
          )
        const state = await browserRpc(connect, spec.name, { op: 'status' }).catch(() => null)
        if (state?.ready) return { vm, connect, container: spec.name, environment: spec.environment }
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
