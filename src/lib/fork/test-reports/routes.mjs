import { TestReportError } from './rules.mjs'

const ROOT = '/api/panel/fork/test-reports'

export async function handleTestReports(req, res, url, { reports, visibleVms, json, readBody }) {
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
      return json(res, 200, { ok: true, data: { items: reports.overview(vmId ? vms.filter((vm) => vm.id === vmId) : vms) } })
    }
    if (path === `${ROOT}/rules` && req.method === 'GET') {
      const id = url.searchParams.get('vm_id')
      if (!ids.includes(id)) throw new TestReportError('vm not found', 404)
      return json(res, 200, { ok: true, data: { rule: reports.rule(id) } })
    }
    if (path === `${ROOT}/rules` && req.method === 'PUT') {
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
  if (method === 'GET' && [ROOT, `${ROOT}/summary`, `${ROOT}/rules`].includes(path)) return true
  if (method === 'GET' && new RegExp(`^${ROOT}/[0-9]+$`).test(path)) return true
  return method === 'PUT' && path === `${ROOT}/rules` && role === 'user'
}
