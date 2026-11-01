import {
  extractApiKey,
  extractPanelToken,
  hashKey,
  timingSafeEqualStr,
  verifyPanelSession,
} from '../../core/security.mjs'
import { hasCapability } from '../../admin/panel-acl.mjs'
import { vmOwnerId } from '../../admin/resource-owner.mjs'

/** Keep the credential in memory only, so logout/role changes revoke an open view. */
export function browserPrincipal(req, { masterKey, findUser }) {
  const token = extractPanelToken(req) || extractApiKey(req)
  const master = req.apiKeyKind === 'master'
  const userId = req.panelUserId
  return {
    key: hashKey(token),
    valid(vm) {
      if (master) return !!token && !!masterKey && timingSafeEqualStr(token, masterKey)
      const session = verifyPanelSession(token)
      if (!session) return false
      const user = findUser(session.user)
      if (user?.enabled === false || (user?.id || null) !== (userId || null)) return false
      const role = user?.role || session.role
      return (
        hasCapability(role, 'vm.credential_write') &&
        (role === 'admin' || (!!userId && (!vm || vmOwnerId(vm) === userId)))
      )
    },
  }
}
