import { TestReportError } from './rules.mjs'

const ROOT = '/api/panel/fork/test-reports'

export async function handleTestReports(
  req,
  res,
  url,
  { reports, visibleVms, summaryVms = visibleVms, json, readBody },
) {
  const vms = visibleVms()
  const ids = vms.map((vm) => vm.id)
  const path = url.pathname
  try {
    if (req.method === 'GET' && path === ROOT) {
      const { vm_id, source, verdict, model, limit, offset } = Object.fromEntries(url.searchParams)
      return json(res, 200, {
        ok: true,
        data: reports.list(ids, {
          vm_id,
          source,
          verdict,
          model,
          ...(limit != null ? { limit } : {}),
          ...(offset != null ? { offset } : {}),
        }),
      })
    }
    if (req.method === 'GET' && path === `${ROOT}/summary`) {
      const vmId = url.searchParams.get('vm_id')
      const summaries = await summaryVms()
      const currentIds = new Set(visibleVms().map((vm) => vm.id))
      return json(res, 200, {
        ok: true,
        data: { items: reports.overview(summaries.filter((vm) => currentIds.has(vm.id) && (!vmId || vm.id === vmId))) },
      })
    }
    if (path === `${ROOT}/rules` && req.method === 'GET') {
      const id = url.searchParams.get('vm_id')
      if (!ids.includes(id)) throw new TestReportError('vm not found', 404)
      return json(res, 200, { ok: true, data: { rule: reports.rule(id) } })
    }
    if (path === `${ROOT}/auto-schedule` && req.method === 'GET') {
      const id = url.searchParams.get('vm_id')
      if (!ids.includes(id)) throw new TestReportError('vm not found', 404)
      const schedule = reports.schedule?.(id) || reports.auto.plan(id)
      return json(res, 200, {
        ok: true,
        data: {
          automatic: reports.auto.view(id),
          rule_enabled: reports.rule(id).enabled,
          test_schedule: { enabled: schedule?.enabled === true, next_run_at: schedule?.next_run_at || null },
        },
      })
    }
    if (path === `${ROOT}/auto-schedule/release` && req.method === 'POST') {
      let body
      try {
        body = await readBody(req, 8192)
      } catch {
        throw new TestReportError('无效的 JSON 或请求体过大')
      }
      if (!visibleVms().some((vm) => vm.id === body?.vm_id)) throw new TestReportError('vm not found', 404)
      const automatic = reports.auto.release(body.vm_id)
      if (automatic.action_error) throw new TestReportError(automatic.action_error, 409)
      return json(res, 200, { ok: true, data: { automatic } })
    }
    if ([`${ROOT}/rules`, `${ROOT}/auto-schedule`].includes(path) && req.method === 'PUT') {
      let body
      try {
        body = await readBody(req, 64 * 1024)
      } catch {
        throw new TestReportError('无效的 JSON 或请求体过大')
      }
      if (!Array.isArray(body?.vm_ids) || !body.vm_ids.length || body.vm_ids.length > 500)
        throw new TestReportError('请选择 1–500 个槽位')
      // Slot ownership may change while the request body is being read.
      const writableIds = visibleVms().map((vm) => vm.id)
      if (body.vm_ids.some((id) => typeof id !== 'string' || !writableIds.includes(id)))
        throw new TestReportError('vm not found', 404)
      const targets = [...new Set(body.vm_ids)]
      if (path === `${ROOT}/auto-schedule`) {
        const policy = reports.auto.save(targets, body.policy, body.paused_action)
        const action_errors = targets.flatMap((id) => {
          const message = reports.auto.view(id).action_error
          return message ? [{ id, message }] : []
        })
        return json(res, 200, { ok: true, data: { policy, updated: targets.length, action_errors } })
      }
      const rule = reports.saveRule(targets, body.rule)
      return json(res, 200, { ok: true, data: { rule, updated: targets.length } })
    }
    if (req.method === 'GET' && /^\d+$/.test(path.slice(ROOT.length + 1))) {
      const item = reports.detail(ids, path.slice(ROOT.length + 1))
      if (!item) throw new TestReportError('记录不存在', 404)
      return json(res, 200, { ok: true, data: { item } })
    }
    return json(res, 404, { ok: false, error: { message: 'not found' } })
  } catch (error) {
    if (!(error instanceof TestReportError)) throw error
    return json(res, error.status, { ok: false, error: { code: 'test_report_error', message: error.message } })
  }
}

export function testReportsRouteAllowed(method, path, role) {
  if (method === 'GET' && [ROOT, `${ROOT}/summary`, `${ROOT}/rules`, `${ROOT}/auto-schedule`].includes(path))
    return true
  if (method === 'GET' && new RegExp(`^${ROOT}/[0-9]+$`).test(path)) return true
  if (method === 'POST' && path === `${ROOT}/auto-schedule/release`) return ['user', 'super'].includes(role)
  return method === 'PUT' && [`${ROOT}/rules`, `${ROOT}/auto-schedule`].includes(path) && role === 'user'
}
