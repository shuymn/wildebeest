// The permissions an app holds or asks for, in plain language by group (the consent page and settings' authorized
// apps alike, so the two never disagree): `read` and `profile` read, `write` writes, `follow` and `push` stand alone,
// and the admin scopes administer (src/security/scopes.ts). Each group keeps its scopes' names, in the order given.

export type ScopeGroup = 'read' | 'write' | 'follow' | 'push' | 'admin'

const GROUPS: readonly ScopeGroup[] = ['read', 'write', 'follow', 'push', 'admin']

function groupOf(scope: string): ScopeGroup {
	if (scope.startsWith('admin:')) {
		return 'admin'
	}
	if (scope === 'profile' || scope.startsWith('read')) {
		return 'read'
	}
	return scope.startsWith('write') ? 'write' : scope === 'follow' ? 'follow' : 'push'
}

export function scopeGroups(scopes: readonly string[]): { group: ScopeGroup; scopes: string[] }[] {
	return GROUPS.map((group) => ({ group, scopes: scopes.filter((scope) => groupOf(scope) === group) })).filter(
		({ scopes }) => scopes.length > 0
	)
}
