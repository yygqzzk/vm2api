import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-principal-'))
const previous = process.env.KIN_DATA_DIR
process.env.KIN_DATA_DIR = root
const { createPanelSession, revokePanelSession } = await import('../../src/lib/core/security.mjs')
const { browserPrincipal } = await import('../../src/lib/fork/slot-browser/principal.mjs')
after(() => {
  if (previous == null) delete process.env.KIN_DATA_DIR
  else process.env.KIN_DATA_DIR = previous
  fs.rmSync(root, { recursive: true, force: true })
})

test('browser principal rechecks logout, role, enabled flag, owner and user identity', () => {
  let user = { id: 'user-a', role: 'admin', enabled: true }
  const token = createPanelSession('operator', { role: 'admin' })
  const principal = browserPrincipal(
    { headers: { authorization: `Bearer ${token}` }, panelUserId: 'user-a' },
    { masterKey: 'test-master', findUser: () => user },
  )
  assert.notEqual(principal.key, token)
  assert.equal(principal.valid({ owner_user_id: 'user-b' }), true)
  user.role = 'user'
  assert.equal(principal.valid({ owner_user_id: 'user-b' }), false)
  assert.equal(principal.valid({ owner_user_id: 'user-a' }), true)
  user.role = 'super'
  assert.equal(principal.valid({ owner_user_id: 'user-a' }), false)
  user.role = 'admin'
  user.enabled = false
  assert.equal(principal.valid({}), false)
  user.enabled = true
  user.id = 'replacement-user'
  assert.equal(principal.valid({}), false)
  user.id = 'user-a'
  revokePanelSession(token)
  assert.equal(principal.valid({}), false)
})

test('master access must match the configured key, not just a request role', () => {
  const context = { masterKey: 'test-master', findUser: () => null }
  const principal = browserPrincipal(
    { apiKeyKind: 'master', headers: { authorization: 'Bearer test-master' } },
    context,
  )
  assert.equal(principal.valid({}), true)
  assert.equal(
    browserPrincipal({ apiKeyKind: 'master', headers: { authorization: 'Bearer wrong' } }, context).valid({}),
    false,
  )
  assert.equal(browserPrincipal({ panelRole: 'admin', headers: {} }, context).valid({}), false)
})
