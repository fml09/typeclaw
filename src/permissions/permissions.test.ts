import { describe, expect, test } from 'bun:test'

import type { SessionOrigin } from '@/agent/session-origin'

import { BUILTIN_ROLES, expandOwnerWildcard } from './builtins'
import { createBoundedCache, createPermissionService, findUngrantedPluginPermissions } from './permissions'
import { rolesConfigSchema, type RolesConfig } from './schema'

function parseRoles(raw: unknown): RolesConfig {
  const result = rolesConfigSchema.safeParse(raw)
  if (!result.success) throw new Error(`roles invalid: ${result.error.message}`)
  return result.data
}

const PLUGIN_PERMS = [
  'security.bypass.secretExfilBash',
  'security.bypass.gitExfil',
  'security.bypass.secretExfilRead',
] as const

const tui: SessionOrigin = { kind: 'tui', sessionId: 's' }
const slackOwnerChat: SessionOrigin = {
  kind: 'channel',
  adapter: 'slack-bot',
  workspace: 'T0123',
  chat: 'C_GEN',
  thread: null,
  lastInboundAuthorId: 'U_ME',
}
const slackStrangerChat: SessionOrigin = {
  kind: 'channel',
  adapter: 'slack-bot',
  workspace: 'T0123',
  chat: 'C_GEN',
  thread: null,
  lastInboundAuthorId: 'U_STRANGER',
}

describe('PermissionService — defaults', () => {
  test('undefined origin → guest', () => {
    const svc = createPermissionService()
    expect(svc.resolveRole(undefined)).toBe('guest')
    expect(svc.has(undefined, 'channel.respond')).toBe(false)
  })

  test('undefined origin holds NOTHING even after guest is granted that permission (the fail-safe floor)', () => {
    // guest is now a grantable role; an operator may open it channel.respond.
    // The floor must live on the undefined origin, not on guest being empty —
    // so has(undefined, ...) stays false regardless of what guest carries.
    const roles = parseRoles({ guest: { match: ['slack:*'], permissions: ['channel.respond'] } })
    const svc = createPermissionService({ roles })
    // sanity: a matched guest origin DOES get the granted permission
    expect(svc.has(slackStrangerChat, 'channel.respond')).toBe(true)
    // but the undefined origin is closed regardless
    expect(svc.has(undefined, 'channel.respond')).toBe(false)
    // resolveRole/describe still report guest for audit; only has() is forced closed
    expect(svc.resolveRole(undefined)).toBe('guest')
  })

  test('system origin → owner (runtime infrastructure acts on operator behalf)', () => {
    const svc = createPermissionService({ pluginPermissions: PLUGIN_PERMS })
    expect(svc.resolveRole({ kind: 'system', component: 'memory-logger' })).toBe('owner')
    // A guest-triggered system process still resolves to owner — the
    // triggering origin does not demote it.
    expect(
      svc.resolveRole({
        kind: 'system',
        component: 'memory-logger',
        triggeredBy: { kind: 'channel', adapter: 'slack-bot', workspace: 'T0', chat: 'C0', thread: null },
      }),
    ).toBe('owner')
  })

  test('tui origin → owner via built-in match', () => {
    const svc = createPermissionService({ pluginPermissions: PLUGIN_PERMS })
    expect(svc.resolveRole(tui)).toBe('owner')
    expect(svc.has(tui, 'channel.respond')).toBe(true)
    expect(svc.has(tui, 'cron.schedule')).toBe(true)
    expect(svc.has(tui, 'cron.modify')).toBe(true)
    expect(svc.has(tui, 'security.bypass.secretExfilBash')).toBe(true)
    expect(svc.has(tui, 'security.bypass.gitExfil')).toBe(true)
  })

  test('channel origin with no roles → guest', () => {
    const svc = createPermissionService({ pluginPermissions: PLUGIN_PERMS })
    expect(svc.resolveRole(slackOwnerChat)).toBe('guest')
    expect(svc.has(slackOwnerChat, 'channel.respond')).toBe(false)
  })
})

describe('PermissionService — user-declared roles', () => {
  test('trusted role with channel match grants channel.respond + bypass.low; per-guard medium/high bypasses are NOT default', () => {
    const roles = parseRoles({
      trusted: { match: ['slack:T0123 author:U_ME'] },
    })
    const svc = createPermissionService({ roles, pluginPermissions: PLUGIN_PERMS })
    expect(svc.resolveRole(slackOwnerChat)).toBe('trusted')
    expect(svc.has(slackOwnerChat, 'channel.respond')).toBe(true)
    expect(svc.has(slackOwnerChat, 'security.bypass.low')).toBe(true)
    expect(svc.has(slackOwnerChat, 'security.bypass.secretExfilBash')).toBe(false)
    expect(svc.has(slackOwnerChat, 'security.bypass.gitExfil')).toBe(false)
    expect(svc.has(slackOwnerChat, 'security.bypass.gitRemoteTainted')).toBe(false)
  })

  test('stranger in same chat does not match author rule → guest', () => {
    const roles = parseRoles({
      trusted: { match: ['slack:T0123 author:U_ME'] },
    })
    const svc = createPermissionService({ roles, pluginPermissions: PLUGIN_PERMS })
    expect(svc.resolveRole(slackStrangerChat)).toBe('guest')
    expect(svc.has(slackStrangerChat, 'channel.respond')).toBe(false)
  })

  test('severity ordering: trusted wins over member regardless of declaration order', () => {
    const roles = parseRoles({
      trusted: { match: ['slack:T0123 author:U_ME'] },
      member: { match: ['slack:T0123'] },
    })
    const svc = createPermissionService({ roles, pluginPermissions: PLUGIN_PERMS })
    expect(svc.resolveRole(slackOwnerChat)).toBe('trusted')
    expect(svc.resolveRole(slackStrangerChat)).toBe('member')
  })

  test('severity ordering: owner wins even when member with broader match is declared first', () => {
    const roles = parseRoles({
      member: { match: ['*'] },
      owner: { match: ['slack:T0123 author:U_ME'] },
    })
    const svc = createPermissionService({ roles, pluginPermissions: PLUGIN_PERMS })
    expect(svc.resolveRole(slackOwnerChat)).toBe('owner')
    expect(svc.resolveRole(slackStrangerChat)).toBe('member')
  })

  test('severity ordering: trusted wins even when member with broader match is declared first', () => {
    const roles = parseRoles({
      member: { match: ['slack:T0123'] },
      trusted: { match: ['slack:T0123 author:U_ME'] },
    })
    const svc = createPermissionService({ roles, pluginPermissions: PLUGIN_PERMS })
    expect(svc.resolveRole(slackOwnerChat)).toBe('trusted')
    expect(svc.resolveRole(slackStrangerChat)).toBe('member')
  })

  test('custom roles slot between trusted and member', () => {
    const roles = parseRoles({
      member: { match: ['*'] },
      partner: { match: ['slack:T0123 author:U_PARTNER'], permissions: ['channel.respond'] },
    })
    const svc = createPermissionService({ roles, pluginPermissions: PLUGIN_PERMS })
    const partner: SessionOrigin = { ...slackOwnerChat, lastInboundAuthorId: 'U_PARTNER' }
    expect(svc.resolveRole(partner)).toBe('partner')
    expect(svc.resolveRole(slackStrangerChat)).toBe('member')
  })

  test('custom roles cannot intercept TUI (owner always wins for TUI)', () => {
    const roles = parseRoles({
      ops: { match: ['tui'], permissions: ['channel.respond'] },
    })
    const svc = createPermissionService({ roles, pluginPermissions: PLUGIN_PERMS })
    expect(svc.resolveRole(tui)).toBe('owner')
  })

  test('multiple custom roles: later declaration overrides earlier (later wins)', () => {
    const roles = parseRoles({
      beta: { match: ['slack:T0123'], permissions: ['channel.respond'] },
      alpha: { match: ['slack:T0123'], permissions: ['channel.respond'] },
    })
    const svc = createPermissionService({ roles, pluginPermissions: PLUGIN_PERMS })
    expect(svc.resolveRole(slackOwnerChat)).toBe('alpha')
  })

  test('explicit permissions array replaces built-in (no merge)', () => {
    const roles = parseRoles({
      trusted: { match: ['slack:T0123 author:U_ME'], permissions: ['channel.respond'] },
    })
    const svc = createPermissionService({ roles, pluginPermissions: PLUGIN_PERMS })
    expect(svc.has(slackOwnerChat, 'channel.respond')).toBe(true)
    expect(svc.has(slackOwnerChat, 'security.bypass.secretExfilBash')).toBe(false)
  })

  test('owner user match appends to built-in tui match', () => {
    const roles = parseRoles({
      owner: { match: ['slack:T0123 author:U_ME'] },
    })
    const svc = createPermissionService({ roles, pluginPermissions: PLUGIN_PERMS })
    expect(svc.resolveRole(tui)).toBe('owner')
    expect(svc.resolveRole(slackOwnerChat)).toBe('owner')
  })

  test('custom role grants only the permissions it declares', () => {
    const roles = parseRoles({
      partner: { match: ['slack:T0123 author:U_PARTNER'], permissions: ['cron.schedule'] },
    })
    const svc = createPermissionService({ roles, pluginPermissions: PLUGIN_PERMS })
    const partner: SessionOrigin = { ...slackOwnerChat, lastInboundAuthorId: 'U_PARTNER' }
    expect(svc.resolveRole(partner)).toBe('partner')
    expect(svc.has(partner, 'cron.schedule')).toBe(true)
    expect(svc.has(partner, 'channel.respond')).toBe(false)
  })
})

describe('PermissionService — cron/subagent provenance', () => {
  test('cron session resolves to scheduledByRole directly', () => {
    const svc = createPermissionService({ pluginPermissions: PLUGIN_PERMS })
    const cronAsOwner: SessionOrigin = {
      kind: 'cron',
      jobId: 'backup',
      jobKind: 'prompt',
      scheduledByRole: 'owner',
    }
    expect(svc.resolveRole(cronAsOwner)).toBe('owner')
    expect(svc.has(cronAsOwner, 'security.bypass.secretExfilBash')).toBe(true)
  })

  test('cron without scheduledByRole → guest (no laundering)', () => {
    const svc = createPermissionService({ pluginPermissions: PLUGIN_PERMS })
    const cron: SessionOrigin = { kind: 'cron', jobId: 'j', jobKind: 'prompt' }
    expect(svc.resolveRole(cron)).toBe('guest')
  })

  test('cron with unknown role string → guest (forged role rejected)', () => {
    const svc = createPermissionService({ pluginPermissions: PLUGIN_PERMS })
    const cron: SessionOrigin = {
      kind: 'cron',
      jobId: 'j',
      jobKind: 'prompt',
      scheduledByRole: 'admin',
    }
    expect(svc.resolveRole(cron)).toBe('guest')
  })

  test('subagent inherits spawnedByRole', () => {
    const svc = createPermissionService({ pluginPermissions: PLUGIN_PERMS })
    const sub: SessionOrigin = {
      kind: 'subagent',
      subagent: 'memory-logger',
      parentSessionId: 'p',
      spawnedByRole: 'owner',
    }
    expect(svc.resolveRole(sub)).toBe('owner')
  })

  test('subagent without spawnedByRole → guest', () => {
    const svc = createPermissionService({ pluginPermissions: PLUGIN_PERMS })
    const sub: SessionOrigin = {
      kind: 'subagent',
      subagent: 'memory-logger',
      parentSessionId: 'p',
    }
    expect(svc.resolveRole(sub)).toBe('guest')
  })
})

describe('PermissionService — role resolution cache', () => {
  test('repeated resolveRole/has calls for the same origin stay correct', () => {
    const roles = parseRoles({ trusted: { match: ['slack:T0123 author:U_ME'] } })
    const svc = createPermissionService({ roles, pluginPermissions: PLUGIN_PERMS })
    for (let i = 0; i < 5; i++) {
      expect(svc.resolveRole(slackOwnerChat)).toBe('trusted')
      expect(svc.has(slackOwnerChat, 'channel.respond')).toBe(true)
      expect(svc.resolveRole(slackStrangerChat)).toBe('guest')
      expect(svc.has(slackStrangerChat, 'channel.respond')).toBe(false)
    }
  })

  test('replaceRoles reflects a PROMOTION (no stale under-privileged read)', () => {
    const svc = createPermissionService({ pluginPermissions: PLUGIN_PERMS })
    // given: warms the cache with the pre-grant verdict
    expect(svc.resolveRole(slackOwnerChat)).toBe('guest')
    // when: the operator grants trusted to this author
    svc.replaceRoles(parseRoles({ trusted: { match: ['slack:T0123 author:U_ME'] } }))
    // then: the new grant is visible immediately, not the cached guest
    expect(svc.resolveRole(slackOwnerChat)).toBe('trusted')
    expect(svc.has(slackOwnerChat, 'channel.respond')).toBe(true)
  })

  test('replaceRoles reflects a DEMOTION (no stale OVER-privileged read — the security case)', () => {
    const svc = createPermissionService({
      roles: parseRoles({ trusted: { match: ['slack:T0123 author:U_ME'] } }),
      pluginPermissions: PLUGIN_PERMS,
    })
    // given: warms the cache while the author is trusted
    expect(svc.resolveRole(slackOwnerChat)).toBe('trusted')
    expect(svc.has(slackOwnerChat, 'security.bypass.low')).toBe(true)
    // when: the operator revokes the grant
    svc.replaceRoles(parseRoles({}))
    // then: the cache must NOT keep handing back trusted
    expect(svc.resolveRole(slackOwnerChat)).toBe('guest')
    expect(svc.has(slackOwnerChat, 'channel.respond')).toBe(false)
    expect(svc.has(slackOwnerChat, 'security.bypass.low')).toBe(false)
  })

  test('replacePluginPermissions reflects owner-wildcard expansion changes', () => {
    const svc = createPermissionService({ roles: parseRoles({ owner: { match: ['slack:T0123 author:U_ME'] } }) })
    // given: no plugin perms yet, so owner has no bypass; warm the cache via has()
    expect(svc.resolveRole(slackOwnerChat)).toBe('owner')
    expect(svc.has(slackOwnerChat, 'security.bypass.gitExfil')).toBe(false)
    // when: a plugin registers a bypass permission the owner wildcard expands to
    svc.replacePluginPermissions?.({
      pluginPermissions: ['security.bypass.gitExfil'],
      ownerWildcardExclusions: [],
    })
    // then: the owner now holds it (role name cached OR not, the permission set is fresh)
    expect(svc.resolveRole(slackOwnerChat)).toBe('owner')
    expect(svc.has(slackOwnerChat, 'security.bypass.gitExfil')).toBe(true)
  })

  test('two authors in the same chat resolve independently (key includes authorId — no cross-author leak)', () => {
    const roles = parseRoles({ trusted: { match: ['slack:T0123 author:U_ME'] } })
    const svc = createPermissionService({ roles, pluginPermissions: PLUGIN_PERMS })
    // given: warm the trusted author first
    expect(svc.resolveRole(slackOwnerChat)).toBe('trusted')
    // then: a different author in the SAME workspace+chat must not inherit the cached trusted verdict
    expect(svc.resolveRole(slackStrangerChat)).toBe('guest')
    // and repeated interleaving stays correct
    expect(svc.resolveRole(slackOwnerChat)).toBe('trusted')
    expect(svc.resolveRole(slackStrangerChat)).toBe('guest')
  })

  test('workspace is part of the key (same author in another workspace is not trusted)', () => {
    const roles = parseRoles({ trusted: { match: ['slack:T0123 author:U_ME'] } })
    const svc = createPermissionService({ roles, pluginPermissions: PLUGIN_PERMS })
    expect(svc.resolveRole(slackOwnerChat)).toBe('trusted')
    // the rule pins workspace T0123, so the same author in T9999 is NOT trusted;
    // this fails if `workspace` is dropped from the cache key
    expect(svc.resolveRole({ ...slackOwnerChat, workspace: 'T9999' })).toBe('guest')
  })

  test('chat is part of the key (a chat-scoped grant does not leak to a sibling chat)', () => {
    // A chat-CONSTRAINED rule: only C_GEN is trusted. If `chat` were omitted
    // from the cache key, the warmed C_GEN verdict would leak to C_OTHER.
    const roles = parseRoles({ trusted: { match: ['slack:T0123/C_GEN author:U_ME'] } })
    const svc = createPermissionService({ roles, pluginPermissions: PLUGIN_PERMS })
    expect(svc.resolveRole(slackOwnerChat)).toBe('trusted')
    expect(svc.resolveRole({ ...slackOwnerChat, chat: 'C_OTHER' })).toBe('guest')
  })

  test('discord thread parent is matched and isolated in the role cache', () => {
    const roles = parseRoles({ trusted: { match: ['discord:GUILD/PARENT author:U_ME'] } })
    const svc = createPermissionService({ roles, pluginPermissions: PLUGIN_PERMS })
    const thread: SessionOrigin = {
      kind: 'channel',
      adapter: 'discord-bot',
      workspace: 'GUILD',
      chat: 'THREAD',
      thread: null,
      parentChat: 'PARENT',
      lastInboundAuthorId: 'U_ME',
    }

    expect(svc.resolveRole(thread)).toBe('trusted')
    expect(svc.resolveRole({ ...thread, parentChat: 'OTHER_PARENT' })).toBe('guest')
    expect(svc.resolveRole({ ...thread, parentChat: undefined })).toBe('guest')
  })

  test('adapter is part of the key (identical coordinates under discord-bot do not inherit slack verdict)', () => {
    // Same workspace/chat/author, different adapter. Only slack is trusted;
    // if `adapter` were omitted from the key, the discord origin would inherit
    // the warmed slack `trusted` verdict.
    const roles = parseRoles({ trusted: { match: ['slack:T0123 author:U_ME'] } })
    const svc = createPermissionService({ roles, pluginPermissions: PLUGIN_PERMS })
    const discordSameCoords: SessionOrigin = { ...slackOwnerChat, adapter: 'discord-bot' }
    expect(svc.resolveRole(slackOwnerChat)).toBe('trusted')
    expect(svc.resolveRole(discordSameCoords)).toBe('guest')
  })

  test('cache stays bounded under a flood of distinct external coordinates', () => {
    // Channel keys come from externally-controlled ids; a flood of distinct
    // chats must not grow the cache without limit. Resolve far more distinct
    // origins than the internal cap, then assert the warm hot entry and a fresh
    // cold entry both still resolve correctly — eviction must not corrupt
    // verdicts, only bound memory.
    const roles = parseRoles({ trusted: { match: ['slack:T0123/C_GEN author:U_ME'] } })
    const svc = createPermissionService({ roles, pluginPermissions: PLUGIN_PERMS })
    expect(svc.resolveRole(slackOwnerChat)).toBe('trusted')
    for (let i = 0; i < 10_000; i++) {
      expect(svc.resolveRole({ ...slackStrangerChat, chat: `C_FLOOD_${i}` })).toBe('guest')
    }
    // A chat that was evicted recomputes to the same correct verdict
    expect(svc.resolveRole(slackOwnerChat)).toBe('trusted')
    expect(svc.resolveRole({ ...slackOwnerChat, chat: 'C_OTHER' })).toBe('guest')
  })
})

describe('createBoundedCache', () => {
  test('never exceeds the cap, evicting the oldest insertion', () => {
    const cache = createBoundedCache<number>(3)
    cache.set('a', 1)
    cache.set('b', 2)
    cache.set('c', 3)
    expect(cache.size).toBe(3)
    // inserting a 4th key evicts 'a' (oldest), size stays at the cap
    cache.set('d', 4)
    expect(cache.size).toBe(3)
    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('b')).toBe(2)
    expect(cache.get('d')).toBe(4)
  })

  test('stays bounded under a flood far exceeding the cap', () => {
    const cache = createBoundedCache<number>(8)
    for (let i = 0; i < 1000; i++) cache.set(`k${i}`, i)
    expect(cache.size).toBe(8)
    // only the most-recent `max` insertions survive
    expect(cache.get('k999')).toBe(999)
    expect(cache.get('k0')).toBeUndefined()
  })

  test('re-setting an existing key updates in place without evicting', () => {
    const cache = createBoundedCache<number>(2)
    cache.set('a', 1)
    cache.set('b', 2)
    cache.set('a', 10)
    // 'a' was already present, so 'b' must not have been evicted
    expect(cache.size).toBe(2)
    expect(cache.get('a')).toBe(10)
    expect(cache.get('b')).toBe(2)
  })

  test('clear empties the cache', () => {
    const cache = createBoundedCache<number>(4)
    cache.set('a', 1)
    cache.set('b', 2)
    cache.clear()
    expect(cache.size).toBe(0)
    expect(cache.get('a')).toBeUndefined()
  })
})

describe('expandOwnerWildcard', () => {
  test('replaces sentinel with concrete bypass permissions', () => {
    const expanded = expandOwnerWildcard(BUILTIN_ROLES.owner.permissions, [
      'security.bypass.foo',
      'security.bypass.bar',
      'other.permission',
    ])
    expect(expanded).toContain('channel.respond')
    expect(expanded).toContain('cron.schedule')
    expect(expanded).toContain('security.bypass.foo')
    expect(expanded).toContain('security.bypass.bar')
    expect(expanded).not.toContain('other.permission')
    expect(expanded.some((p) => p.startsWith('__BUILTIN'))).toBe(false)
  })

  test('user-written wildcards are not honored (sentinel only)', () => {
    const expanded = expandOwnerWildcard(['*'], ['security.bypass.foo'])
    expect(expanded).toEqual(['*'])
  })
})

describe('describe()', () => {
  test('returns role name and permission list', () => {
    const svc = createPermissionService({ pluginPermissions: PLUGIN_PERMS })
    const desc = svc.describe(tui)
    expect(desc.role).toBe('owner')
    expect(desc.permissions).toContain('channel.respond')
    expect(desc.permissions).toContain('security.bypass.secretExfilBash')
  })

  test('undefined origin → guest with empty permissions', () => {
    const svc = createPermissionService()
    const desc = svc.describe(undefined)
    expect(desc.role).toBe('guest')
    expect(desc.permissions).toEqual([])
  })
})

describe('PermissionService — compareRoleSeverity', () => {
  test('built-in tower orders owner > trusted > member > guest', () => {
    const svc = createPermissionService()
    expect(svc.compareRoleSeverity('owner', 'trusted')).toBe(1)
    expect(svc.compareRoleSeverity('trusted', 'member')).toBe(1)
    expect(svc.compareRoleSeverity('member', 'guest')).toBe(1)
    expect(svc.compareRoleSeverity('guest', 'owner')).toBe(-1)
    expect(svc.compareRoleSeverity('member', 'member')).toBe(0)
  })

  test('configured custom role slots between trusted and member', () => {
    const roles = parseRoles({
      partner: { match: ['slack:T0123 author:U_PARTNER'], permissions: ['channel.respond'] },
    })
    const svc = createPermissionService({ roles, pluginPermissions: PLUGIN_PERMS })
    expect(svc.compareRoleSeverity('partner', 'member')).toBe(1)
    expect(svc.compareRoleSeverity('partner', 'trusted')).toBe(-1)
    expect(svc.compareRoleSeverity('trusted', 'partner')).toBe(1)
  })

  test('two configured custom roles compare equal', () => {
    const roles = parseRoles({
      partner: { match: ['slack:T0 author:U_A'], permissions: ['channel.respond'] },
      vendor: { match: ['slack:T0 author:U_B'], permissions: ['channel.respond'] },
    })
    const svc = createPermissionService({ roles, pluginPermissions: PLUGIN_PERMS })
    expect(svc.compareRoleSeverity('partner', 'vendor')).toBe(0)
  })

  test('unknown role on either side returns undefined (caller must deny)', () => {
    const svc = createPermissionService()
    expect(svc.compareRoleSeverity('ghost', 'member')).toBeUndefined()
    expect(svc.compareRoleSeverity('owner', 'ghost')).toBeUndefined()
  })
})

describe('findUngrantedPluginPermissions', () => {
  test('a plugin permission no role lists is reported', () => {
    expect(findUngrantedPluginPermissions(undefined, ['standup.publish.remote'])).toEqual(['standup.publish.remote'])
  })

  test('granting it on a built-in role clears the report', () => {
    const roles = parseRoles({
      owner: { match: ['tui'], permissions: ['channel.respond', 'standup.publish.remote'] },
    })
    expect(findUngrantedPluginPermissions(roles, ['standup.publish.remote'])).toEqual([])
  })

  test('granting it on a custom role clears the report', () => {
    const roles = parseRoles({ ops: { match: ['discord:G1'], permissions: ['standup.publish.remote'] } })
    expect(findUngrantedPluginPermissions(roles, ['standup.publish.remote'])).toEqual([])
  })

  test('security.bypass.* is NOT reported — the owner wildcard auto-grants it', () => {
    expect(findUngrantedPluginPermissions(undefined, ['security.bypass.myGuard'])).toEqual([])
  })

  test('a security.bypass.* string excluded from the wildcard IS reported', () => {
    expect(findUngrantedPluginPermissions(undefined, ['security.bypass.myGuard'], ['security.bypass.myGuard'])).toEqual(
      ['security.bypass.myGuard'],
    )
  })

  test('replacing owner permissions without re-listing the plugin string re-reports it', () => {
    const roles = parseRoles({ owner: { match: ['tui'], permissions: ['channel.respond'] } })
    expect(findUngrantedPluginPermissions(roles, ['security.bypass.myGuard'])).toEqual(['security.bypass.myGuard'])
  })

  test('reports only the ungranted subset', () => {
    const roles = parseRoles({ member: { match: ['*'], permissions: ['a.one'] } })
    expect(findUngrantedPluginPermissions(roles, ['a.one', 'a.two'])).toEqual(['a.two'])
  })

  test('no plugin permissions → nothing to report', () => {
    expect(findUngrantedPluginPermissions(undefined, [])).toEqual([])
  })
})
