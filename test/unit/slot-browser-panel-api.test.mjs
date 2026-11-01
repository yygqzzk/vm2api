import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-panel-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'vms'))
  for (const [id, owner] of [
    ['vm-a', 'user-a'],
    ['vm-b', 'user-b'],
  ]) {
    fs.writeFileSync(
      path.join(root, 'vms', `${id}.json`),
      JSON.stringify({
        id,
        owner_user_id: owner,
        platform: 'openai',
        kind: 'codex',
        status: 'stopped',
        proxy: { id: 'px-test' },
      }),
    )
  }
  const calls = []
  const browser = {
    async handle(_req, res, _url, { json }) {
      calls.push('handle')
      return json(res, 200, { ok: true })
    },
    async beforeMutation() {
      calls.push('before')
    },
    afterMutation() {
      calls.push('after')
    },
    async purgeProfile() {
      calls.push('purge')
    },
    recordAuthorization(id, generated) {
      calls.push({ id, generated })
    },
  }
  async function call(role, method, url, body = {}) {
    let response
    const handler = createPanelHandler({
      cfg: { paths: { project: root } },
      slotBrowser: browser,
      requireAuth(req) {
        if (role === 'managed') req.apiKeyKind = 'managed'
        else Object.assign(req, { panelUser: 'operator', panelRole: role, panelUserId: 'user-a' })
        return true
      },
      readBody: async () => body,
      requireSlotProxy: () => ({ ok: true, proxyUrl: 'socks5://192.0.2.1:1080' }),
      json(_res, status, data) {
        response = { status, data }
        return true
      },
    })
    await handler({ method, headers: {} }, {}, new URL(`http://localhost${url}`))
    return response
  }
  return { root, calls, browser, call }
}

test('real panel routing applies tenant/operator gates before browser delegation', async (t) => {
  const f = fixture(t)
  assert.equal((await f.call('user', 'POST', '/api/panel/vms/vm-a/browser/start')).status, 200)
  assert.equal(f.calls.filter((item) => item === 'handle').length, 1)
  for (const [role, id, expected] of [
    ['user', 'vm-b', 404],
    ['super', 'vm-a', 403],
    ['managed', 'vm-a', 403],
  ]) {
    assert.equal((await f.call(role, 'POST', `/api/panel/vms/${id}/browser/start`)).status, expected)
  }
  assert.equal(f.calls.filter((item) => item === 'handle').length, 1)
})

test('existing Codex URL generator binds its actual generated session to the browser service', async (t) => {
  const f = fixture(t)
  const response = await f.call('user', 'POST', '/api/panel/vms/vm-a/oauth/generate-auth-url', { flavor: 'codex' })
  assert.equal(response.status, 200)
  const recorded = f.calls.find((item) => typeof item === 'object')
  assert.equal(recorded.id, 'vm-a')
  assert.equal(recorded.generated.flavor, 'codex')
  assert.equal(recorded.generated.auth_url, response.data.data.auth_url)
  assert.equal(recorded.generated.session_id, response.data.data.session_id)
})

test('a refused slot deletion must not purge its browser profile', async (t) => {
  const f = fixture(t)
  fs.writeFileSync(path.join(f.root, 'vms/active.json'), JSON.stringify({ active_vm: 'vm-a' }))
  assert.equal((await f.call('admin', 'DELETE', '/api/panel/vms/vm-a')).status, 409)
  assert.equal(f.calls.includes('purge'), false)
  assert.equal(f.calls.at(-1), 'after')
})

test('request-scoped mutation guards are released after an awaited handler failure', async (t) => {
  const f = fixture(t)
  f.browser.handle = async () => {
    throw new Error('controlled failure')
  }
  await assert.rejects(f.call('admin', 'GET', '/api/panel/vms/vm-a/browser'), /controlled failure/)
  assert.deepEqual(f.calls, ['after'])
})
