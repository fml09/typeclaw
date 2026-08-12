import { describe, expect, test } from 'bun:test'

import { z } from 'zod'

import type { PermissionService } from '@/permissions'
import { createStream } from '@/stream'

import type { AgentSession } from '../index'
import { LiveSubagentRegistry } from '../live-subagents'
import type { SessionOrigin } from '../session-origin'
import type {
  CreateSessionForSubagent,
  CreateSessionForSubagentOptions,
  Subagent,
  SubagentRegistry,
} from '../subagents'
import { createSpawnSubagentTool, resolveSpawnMode } from './spawn-subagent'

const ctx = {} as Parameters<ReturnType<typeof createSpawnSubagentTool>['execute']>[4]

type StubSession = AgentSession & { emit: (event: unknown) => void; abortCount: { n: number } }

function stubSession(): StubSession {
  const calls = { prompt: [] as string[], disposed: 0, abortCount: { n: 0 } }
  const listeners = new Set<(event: unknown) => void>()
  const session = {
    prompt: async (text: string) => {
      calls.prompt.push(text)
      await new Promise((r) => setImmediate(r))
    },
    dispose: () => {
      calls.disposed += 1
    },
    subscribe: (l: (event: unknown) => void) => {
      listeners.add(l)
      return () => {
        listeners.delete(l)
      }
    },
    abort: async () => {
      calls.abortCount.n += 1
    },
    emit: (event: unknown) => {
      for (const l of listeners) l(event)
    },
    abortCount: calls.abortCount,
  } as unknown as StubSession
  return session
}

function emittingSession(emitOnPrompt: () => unknown): StubSession {
  const session = stubSession()
  const orig = session.prompt.bind(session)
  session.prompt = async (text: string) => {
    const event = emitOnPrompt()
    if (event !== undefined) session.emit(event)
    await orig(text)
  }
  return session
}

function makeRegistry(overrides: Record<string, Subagent<unknown>> = {}): SubagentRegistry {
  const publicSub: Subagent<unknown> = { systemPrompt: 'You are public.', visibility: 'public' }
  const internalSub: Subagent<unknown> = { systemPrompt: 'You are internal.' }
  return {
    explorer: publicSub,
    'memory-logger': internalSub,
    ...overrides,
  }
}

function fixedSpawn(opts: {
  createSession: CreateSessionForSubagent
  registry?: SubagentRegistry
  permissions?: PermissionService
  parentSessionId?: string
}) {
  const registry = opts.registry ?? makeRegistry()
  const liveRegistry = new LiveSubagentRegistry()
  let counter = 0
  const tool = createSpawnSubagentTool({
    registry,
    liveRegistry,
    createSessionForSubagent: opts.createSession,
    agentDir: '/agent',
    parentSessionId: opts.parentSessionId ?? 'ses_parent',
    getOrigin: () => ({ kind: 'tui', sessionId: 'ses_parent' }),
    ...(opts.permissions ? { permissions: opts.permissions } : {}),
    generateTaskId: () => {
      counter += 1
      return `bg_test${counter}`
    },
    now: () => 1_000,
    stream: createStream(),
  })
  return { tool, liveRegistry, registry }
}

describe('createSpawnSubagentTool — visibility gate', () => {
  test('public subagent (explorer) spawns successfully', async () => {
    const session = stubSession()
    const { tool } = fixedSpawn({ createSession: async () => session })

    const result = await tool.execute(
      'call_1',
      { subagent_type: 'explorer', prompt: 'find X', run_in_foreground: true },
      undefined,
      undefined,
      ctx,
    )
    const details = result.details as { ok: boolean; mode?: string }
    expect(details.ok).toBe(true)
    expect(details.mode).toBe('sync')
  })

  test('internal subagent (memory-logger) is rejected as unknown', async () => {
    const session = stubSession()
    const { tool } = fixedSpawn({ createSession: async () => session })

    const result = await tool.execute(
      'call_1',
      {
        subagent_type: 'memory-logger',
        prompt: 'consolidate',
      },
      undefined,
      undefined,
      ctx,
    )
    const details = result.details as { ok: boolean; error?: string }
    expect(details.ok).toBe(false)
    expect(details.error).toContain('Unknown subagent: memory-logger')
  })

  test('unknown subagent error does NOT leak internal subagent names', async () => {
    const session = stubSession()
    const { tool } = fixedSpawn({ createSession: async () => session })

    const result = await tool.execute(
      'call_1',
      {
        subagent_type: 'memory-logger',
        prompt: 'consolidate',
      },
      undefined,
      undefined,
      ctx,
    )
    const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
    expect(text).not.toContain('memory-logger\b')
    expect(text).toContain('Available: explorer')
  })

  test('empty public-subagent set surfaces "(none)" in error', async () => {
    const internalOnly: SubagentRegistry = {
      'memory-logger': { systemPrompt: 'internal' },
    }
    const session = stubSession()
    const { tool } = fixedSpawn({ createSession: async () => session, registry: internalOnly })

    const result = await tool.execute('call_1', { subagent_type: 'explorer', prompt: 'q' }, undefined, undefined, ctx)
    const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
    expect(text).toContain('Available: (none)')
  })
})

describe('createSpawnSubagentTool — sync mode', () => {
  test('returns mode=sync with final message captured from message_end event', async () => {
    const session = emittingSession(() => ({
      type: 'message_end',
      message: { content: 'Found three matches in src/.' },
    }))
    const { tool, liveRegistry } = fixedSpawn({ createSession: async () => session })

    const result = await tool.execute(
      'call_1',
      { subagent_type: 'explorer', prompt: 'q', run_in_foreground: true },
      undefined,
      undefined,
      ctx,
    )

    const details = result.details as {
      ok: boolean
      mode?: string
      taskId?: string
      finalMessage?: string
    }
    expect(details.ok).toBe(true)
    expect(details.mode).toBe('sync')
    expect(details.taskId).toBe('bg_test1')
    expect(details.finalMessage).toBe('Found three matches in src/.')
    expect(result.content[0]?.type === 'text' ? result.content[0].text : '').toBe('Found three matches in src/.')
    expect(liveRegistry.get('bg_test1')?.status).toBe('completed')
  })

  test('returns mode=sync with synthesized text when no final message was captured', async () => {
    const session = stubSession()
    const { tool } = fixedSpawn({ createSession: async () => session })

    const result = await tool.execute(
      'call_1',
      { subagent_type: 'explorer', prompt: 'q', run_in_foreground: true },
      undefined,
      undefined,
      ctx,
    )
    const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
    expect(text).toMatch(/explorer completed in/)
  })

  test('propagates failure with error envelope when subagent throws', async () => {
    const session = stubSession()
    session.prompt = async () => {
      throw new Error('provider exploded')
    }
    const { tool, liveRegistry } = fixedSpawn({ createSession: async () => session })

    const result = await tool.execute(
      'call_1',
      { subagent_type: 'explorer', prompt: 'q', run_in_foreground: true },
      undefined,
      undefined,
      ctx,
    )
    const details = result.details as { ok: boolean; error?: string }
    expect(details.ok).toBe(false)
    expect(details.error).toBe('provider exploded')
    expect(liveRegistry.get('bg_test1')?.status).toBe('failed')
  })

  test('foreground failure with finalMessage marks output as partial recovery data, not verdict', async () => {
    const session = emittingSession(() => ({
      type: 'message_end',
      message: { content: '<verdict>approve</verdict>' },
    }))
    const origPrompt = session.prompt.bind(session)
    session.prompt = async (text: string) => {
      await origPrompt(text)
      throw new Error('crashed after partial output')
    }
    const { tool, liveRegistry } = fixedSpawn({ createSession: async () => session })

    const result = await tool.execute(
      'call_1',
      { subagent_type: 'explorer', prompt: 'q', run_in_foreground: true },
      undefined,
      undefined,
      ctx,
    )

    const details = result.details as {
      ok: boolean
      error?: string
      finalMessage?: string
      recoveryData?: boolean
      partial?: boolean
      verdict?: boolean
    }
    expect(details.ok).toBe(false)
    expect(details.error).toBe('crashed after partial output')
    expect(details.finalMessage).toBe('<verdict>approve</verdict>')
    expect(details.recoveryData).toBe(true)
    expect(details.partial).toBe(true)
    expect(details.verdict).toBe(false)
    const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
    expect(text).toContain('PARTIAL RECOVERY DATA')
    expect(text).toContain('not a completed')
    expect(text).toContain('even if it contains verdict-shaped text')
    expect(liveRegistry.get('bg_test1')?.status).toBe('failed')
  })
})

describe('createSpawnSubagentTool — background mode', () => {
  test('returns immediately with task_id and registers as running', async () => {
    let resolvePrompt: () => void = () => {}
    const session = stubSession()
    session.prompt = () =>
      new Promise<void>((r) => {
        resolvePrompt = r
      })
    const { tool, liveRegistry } = fixedSpawn({ createSession: async () => session })

    const result = await tool.execute(
      'call_1',
      {
        subagent_type: 'explorer',
        prompt: 'long search',
      },
      undefined,
      undefined,
      ctx,
    )

    const details = result.details as { ok: boolean; mode?: string; taskId?: string }
    expect(details.ok).toBe(true)
    expect(details.mode).toBe('background')
    expect(details.taskId).toBe('bg_test1')
    expect(liveRegistry.get('bg_test1')?.status).toBe('running')

    resolvePrompt()
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
  })

  test('background completion publishes a subagent.completed broadcast to the stream', async () => {
    const stream = createStream()
    const events: unknown[] = []
    stream.subscribe({ target: { kind: 'broadcast' } }, (msg) => {
      events.push(msg.payload)
    })
    const liveRegistry = new LiveSubagentRegistry()
    const session = stubSession()
    let counter = 0
    const tool = createSpawnSubagentTool({
      registry: makeRegistry(),
      liveRegistry,
      createSessionForSubagent: async () => session,
      agentDir: '/agent',
      parentSessionId: 'ses_parent',
      getOrigin: () => ({ kind: 'tui', sessionId: 'ses_parent' }),
      stream,
      generateTaskId: () => {
        counter += 1
        return `bg_b${counter}`
      },
      now: () => 1_000,
    })

    const result = await tool.execute(
      'call_1',
      {
        subagent_type: 'explorer',
        prompt: 'q',
      },
      undefined,
      undefined,
      ctx,
    )
    const details = result.details as { ok: boolean; taskId?: string }
    expect(details.ok).toBe(true)

    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))

    expect(events.length).toBeGreaterThan(0)
    const completion = events.find((e) => (e as { kind?: string }).kind === 'subagent.completed') as
      | Record<string, unknown>
      | undefined
    expect(completion).toBeDefined()
    expect(completion?.taskId).toBe(details.taskId)
    expect(completion?.subagent).toBe('explorer')
    expect(completion?.ok).toBe(true)
  })

  test('loop-aborted background completion publishes failure with recoverable output', async () => {
    const stream = createStream()
    const events: unknown[] = []
    stream.subscribe({ target: { kind: 'broadcast' } }, (msg) => {
      events.push(msg.payload)
    })
    const liveRegistry = new LiveSubagentRegistry()
    const session = emittingSession(() => ({
      type: 'message_end',
      message: { role: 'assistant', content: 'Partial review evidence.' },
    }))
    Object.assign(session, { getAbortReason: () => 'loop_guard:block' })
    const tool = createSpawnSubagentTool({
      registry: makeRegistry(),
      liveRegistry,
      createSessionForSubagent: async () => session,
      agentDir: '/agent',
      parentSessionId: 'ses_parent',
      getOrigin: () => ({ kind: 'tui', sessionId: 'ses_parent' }),
      stream,
      generateTaskId: () => 'bg_loop',
      now: () => 1_000,
    })

    await tool.execute('call_1', { subagent_type: 'explorer', prompt: 'q' }, undefined, undefined, ctx)
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))

    expect(liveRegistry.get('bg_loop')?.status).toBe('failed')
    const completion = events.find((event) => (event as { kind?: string }).kind === 'subagent.completed') as
      | Record<string, unknown>
      | undefined
    expect(completion?.ok).toBe(false)
    expect(completion?.error).toContain('loop_guard:block')
    expect(completion?.hasRecoverableOutput).toBe(true)
  })

  test('channel-origin background completion carries the channel key for rollover-safe routing', async () => {
    const stream = createStream()
    const events: unknown[] = []
    stream.subscribe({ target: { kind: 'broadcast' } }, (msg) => {
      events.push(msg.payload)
    })
    const tool = createSpawnSubagentTool({
      registry: makeRegistry(),
      liveRegistry: new LiveSubagentRegistry(),
      createSessionForSubagent: async () => stubSession(),
      agentDir: '/agent',
      parentSessionId: 'ses_parent',
      getOrigin: () => ({
        kind: 'channel',
        adapter: 'slack-bot',
        workspace: 'T1',
        chat: 'C1',
        thread: 't1',
      }),
      stream,
      generateTaskId: () => 'bg_ch',
      now: () => 1_000,
    })

    await tool.execute('call_1', { subagent_type: 'explorer', prompt: 'q' }, undefined, undefined, ctx)
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))

    const completion = events.find((e) => (e as { kind?: string }).kind === 'subagent.completed') as
      | Record<string, unknown>
      | undefined
    expect(completion?.channelKey).toEqual({ adapter: 'slack-bot', workspace: 'T1', chat: 'C1', thread: 't1' })
  })

  test('non-channel (tui) origin omits the channel key', async () => {
    const stream = createStream()
    const events: unknown[] = []
    stream.subscribe({ target: { kind: 'broadcast' } }, (msg) => {
      events.push(msg.payload)
    })
    const tool = createSpawnSubagentTool({
      registry: makeRegistry(),
      liveRegistry: new LiveSubagentRegistry(),
      createSessionForSubagent: async () => stubSession(),
      agentDir: '/agent',
      parentSessionId: 'ses_parent',
      getOrigin: () => ({ kind: 'tui', sessionId: 'ses_parent' }),
      stream,
      generateTaskId: () => 'bg_tui',
      now: () => 1_000,
    })

    await tool.execute('call_1', { subagent_type: 'explorer', prompt: 'q' }, undefined, undefined, ctx)
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))

    const completion = events.find((e) => (e as { kind?: string }).kind === 'subagent.completed') as
      | Record<string, unknown>
      | undefined
    expect(completion).toBeDefined()
    expect(completion?.channelKey).toBeUndefined()
  })
})

describe('createSpawnSubagentTool — permissions gating', () => {
  function permService(allowed: Set<string>): PermissionService {
    return {
      has: (_origin, permission) => allowed.has(permission),
      resolveRole: () => 'tester',
      compareRoleSeverity: () => undefined,
      permissionsForRole: () => undefined,
      describe: () => ({ role: 'tester', permissions: [...allowed] }),
      replaceRoles: () => {},
    }
  }

  test('denied when origin lacks subagent.spawn and no per-subagent permission', async () => {
    const session = stubSession()
    const { tool } = fixedSpawn({
      createSession: async () => session,
      permissions: permService(new Set()),
    })

    const result = await tool.execute('call_1', { subagent_type: 'explorer', prompt: 'q' }, undefined, undefined, ctx)
    const details = result.details as { ok: boolean; error?: string }
    expect(details.ok).toBe(false)
    expect(details.error).toContain('denied')
  })

  test('allowed via generic subagent.spawn fallback', async () => {
    const session = stubSession()
    const { tool } = fixedSpawn({
      createSession: async () => session,
      permissions: permService(new Set(['subagent.spawn'])),
    })

    const result = await tool.execute('call_1', { subagent_type: 'explorer', prompt: 'q' }, undefined, undefined, ctx)
    const details = result.details as { ok: boolean }
    expect(details.ok).toBe(true)
  })

  test('allowed via per-subagent permission even without generic spawn', async () => {
    const session = stubSession()
    const { tool } = fixedSpawn({
      createSession: async () => session,
      permissions: permService(new Set(['subagent.spawn.explorer'])),
    })

    const result = await tool.execute('call_1', { subagent_type: 'explorer', prompt: 'q' }, undefined, undefined, ctx)
    const details = result.details as { ok: boolean }
    expect(details.ok).toBe(true)
  })

  test('requiresSpecificPermission=true subagent IGNORES the generic subagent.spawn (per-subagent only)', async () => {
    const session = stubSession()
    const restrictedRegistry: SubagentRegistry = {
      operator: {
        systemPrompt: 'You are restricted.',
        visibility: 'public',
        requiresSpecificPermission: true,
      },
    }
    const { tool } = fixedSpawn({
      createSession: async () => session,
      registry: restrictedRegistry,
      permissions: permService(new Set(['subagent.spawn'])),
    })

    const result = await tool.execute('call_1', { subagent_type: 'operator', prompt: 'q' }, undefined, undefined, ctx)
    const details = result.details as { ok: boolean; error?: string }
    expect(details.ok).toBe(false)
    expect(details.error).toContain('denied')
  })

  test('requiresSpecificPermission=true subagent IS spawnable when the specific permission is held', async () => {
    const session = stubSession()
    const restrictedRegistry: SubagentRegistry = {
      operator: {
        systemPrompt: 'You are restricted.',
        visibility: 'public',
        requiresSpecificPermission: true,
      },
    }
    const { tool } = fixedSpawn({
      createSession: async () => session,
      registry: restrictedRegistry,
      permissions: permService(new Set(['subagent.spawn.operator'])),
    })

    const result = await tool.execute('call_1', { subagent_type: 'operator', prompt: 'q' }, undefined, undefined, ctx)
    const details = result.details as { ok: boolean }
    expect(details.ok).toBe(true)
  })

  test('operator (no requiresSpecificPermission) is spawnable on the generic member grant', async () => {
    const session = stubSession()
    const { tool } = fixedSpawn({
      createSession: async () => session,
      registry: { operator: { systemPrompt: 'You are the operator.', visibility: 'public' } },
      permissions: permService(new Set(['subagent.spawn'])),
    })

    const result = await tool.execute('call_1', { subagent_type: 'operator', prompt: 'q' }, undefined, undefined, ctx)
    const details = result.details as { ok: boolean }
    expect(details.ok).toBe(true)
  })

  test('the legacy subagent.spawn.operator grant still admits operator on its own', async () => {
    const session = stubSession()
    const { tool } = fixedSpawn({
      createSession: async () => session,
      registry: { operator: { systemPrompt: 'You are the operator.', visibility: 'public' } },
      permissions: permService(new Set(['subagent.spawn.operator'])),
    })

    const result = await tool.execute('call_1', { subagent_type: 'operator', prompt: 'q' }, undefined, undefined, ctx)
    const details = result.details as { ok: boolean }
    expect(details.ok).toBe(true)
  })
})

describe('createSpawnSubagentTool — concurrency', () => {
  test('two concurrent spawns get distinct task_ids', async () => {
    let resolveA: () => void = () => {}
    let resolveB: () => void = () => {}
    const sessions = [
      (() => {
        const s = stubSession()
        s.prompt = () =>
          new Promise<void>((r) => {
            resolveA = r
          })
        return s
      })(),
      (() => {
        const s = stubSession()
        s.prompt = () =>
          new Promise<void>((r) => {
            resolveB = r
          })
        return s
      })(),
    ]
    let idx = 0
    const liveRegistry = new LiveSubagentRegistry()
    let counter = 0
    const tool = createSpawnSubagentTool({
      registry: makeRegistry(),
      liveRegistry,
      createSessionForSubagent: async () => {
        const s = sessions[idx]
        if (s === undefined) throw new Error('out of sessions')
        idx += 1
        return s
      },
      agentDir: '/agent',
      parentSessionId: 'ses_parent',
      getOrigin: () => ({ kind: 'tui', sessionId: 'ses_parent' }),
      generateTaskId: () => {
        counter += 1
        return `bg_p${counter}`
      },
      now: () => 1_000,
    })

    const p1 = tool.execute('call_1', { subagent_type: 'explorer', prompt: 'a' }, undefined, undefined, ctx)
    const p2 = tool.execute('call_2', { subagent_type: 'explorer', prompt: 'b' }, undefined, undefined, ctx)
    const [r1, r2] = await Promise.all([p1, p2])
    const d1 = r1.details as { taskId: string }
    const d2 = r2.details as { taskId: string }

    expect(d1.taskId).toBe('bg_p1')
    expect(d2.taskId).toBe('bg_p2')
    expect(d1.taskId).not.toBe(d2.taskId)
    expect(
      liveRegistry
        .list()
        .map((e) => e.taskId)
        .sort(),
    ).toEqual(['bg_p1', 'bg_p2'])

    resolveA()
    resolveB()
    await new Promise((r) => setImmediate(r))
  })
})

describe('createSpawnSubagentTool — role inheritance', () => {
  function permService(role: string): PermissionService {
    return {
      has: () => true,
      resolveRole: () => role,
      compareRoleSeverity: () => undefined,
      permissionsForRole: () => undefined,
      describe: () => ({ role, permissions: ['subagent.spawn'] }),
      replaceRoles: () => {},
    }
  }

  test('forwards the parent origin role (resolved via permissions) as spawnedByRole', async () => {
    const session = stubSession()
    let capturedOptions: CreateSessionForSubagentOptions | undefined
    const { tool } = fixedSpawn({
      createSession: async (_subagent, options) => {
        capturedOptions = options
        return session
      },
      permissions: permService('owner'),
    })

    const result = await tool.execute('call_1', { subagent_type: 'explorer', prompt: 'q' }, undefined, undefined, ctx)

    const details = result.details as { ok: boolean }
    expect(details.ok).toBe(true)
    expect(capturedOptions?.spawnedByRole).toBe('owner')
  })

  test('does not forge a role when no permission service is wired', async () => {
    const session = stubSession()
    let capturedOptions: CreateSessionForSubagentOptions | undefined
    const { tool } = fixedSpawn({
      createSession: async (_subagent, options) => {
        capturedOptions = options
        return session
      },
    })

    const result = await tool.execute('call_1', { subagent_type: 'explorer', prompt: 'q' }, undefined, undefined, ctx)

    const details = result.details as { ok: boolean }
    expect(details.ok).toBe(true)
    expect(capturedOptions?.spawnedByRole).toBeUndefined()
  })
})

describe('createSpawnSubagentTool — per-spawn profile override', () => {
  test('forwards the `profile` tool param to createSessionForSubagent as profileOverride', async () => {
    // given a subagent whose schema accepts the profile field
    const session = stubSession()
    let capturedOptions: CreateSessionForSubagentOptions | undefined
    const registry: SubagentRegistry = {
      worker: {
        systemPrompt: 'X',
        visibility: 'public',
        profile: 'default',
        payloadSchema: z.object({ prompt: z.string().optional(), profile: z.string().optional() }).passthrough(),
      },
    }
    const { tool } = fixedSpawn({
      registry,
      createSession: async (_subagent, options) => {
        capturedOptions = options
        return session
      },
    })

    // when
    const result = await tool.execute(
      'call_1',
      { subagent_type: 'worker', prompt: 'fix the build', profile: 'deep' },
      undefined,
      undefined,
      ctx,
    )

    // then
    expect((result.details as { ok: boolean }).ok).toBe(true)
    expect(capturedOptions?.profileOverride).toBe('deep')
  })

  test('omitting `profile` leaves profileOverride undefined (subagent keeps its declared profile)', async () => {
    // given
    const session = stubSession()
    let capturedOptions: CreateSessionForSubagentOptions | undefined
    const registry: SubagentRegistry = {
      worker: {
        systemPrompt: 'X',
        visibility: 'public',
        profile: 'default',
        payloadSchema: z.object({ prompt: z.string().optional(), profile: z.string().optional() }).passthrough(),
      },
    }
    const { tool } = fixedSpawn({
      registry,
      createSession: async (_subagent, options) => {
        capturedOptions = options
        return session
      },
    })

    // when
    await tool.execute('call_1', { subagent_type: 'worker', prompt: 'fix the build' }, undefined, undefined, ctx)

    // then
    expect(capturedOptions?.profileOverride).toBeUndefined()
  })
})

describe('createSpawnSubagentTool — depth guard', () => {
  function spawnWithOrigin(origin: SessionOrigin) {
    const registry = makeRegistry()
    const liveRegistry = new LiveSubagentRegistry()
    let counter = 0
    const tool = createSpawnSubagentTool({
      registry,
      liveRegistry,
      createSessionForSubagent: async () => stubSession(),
      agentDir: '/agent',
      parentSessionId: 'ses_child',
      getOrigin: () => origin,
      generateTaskId: () => `bg_depth${(counter += 1)}`,
      now: () => 1_000,
    })
    return { tool }
  }

  test('a depth-1 subagent (spawned by a root session) can still spawn', async () => {
    const { tool } = spawnWithOrigin({
      kind: 'subagent',
      subagent: 'operator',
      parentSessionId: 'ses_child',
      spawnedByOrigin: { kind: 'tui', sessionId: 'ses_root' },
    })

    const result = await tool.execute('call_1', { subagent_type: 'explorer', prompt: 'q' }, undefined, undefined, ctx)

    const details = result.details as { ok: boolean }
    expect(details.ok).toBe(true)
  })

  test('a subagent already at MAX_SUBAGENT_DEPTH is refused', async () => {
    const { tool } = spawnWithOrigin({
      kind: 'subagent',
      subagent: 'operator',
      parentSessionId: 'ses_grandchild',
      spawnedByOrigin: {
        kind: 'subagent',
        subagent: 'reviewer',
        parentSessionId: 'ses_child',
        spawnedByOrigin: { kind: 'tui', sessionId: 'ses_root' },
      },
    })

    const result = await tool.execute('call_1', { subagent_type: 'explorer', prompt: 'q' }, undefined, undefined, ctx)

    const details = result.details as { ok: boolean; error?: string }
    expect(details.ok).toBe(false)
    expect(details.error).toContain('maximum delegation depth')
  })
})

describe('createSpawnSubagentTool — foreground/background resolution', () => {
  function textOf(result: { content: { type: string; text?: string }[] }): string {
    return result.content[0]?.type === 'text' ? (result.content[0].text ?? '') : ''
  }

  function spawnWithOrigin(origin: SessionOrigin, registry?: SubagentRegistry) {
    const liveRegistry = new LiveSubagentRegistry()
    let launched = 0
    let counter = 0
    const tool = createSpawnSubagentTool({
      registry: registry ?? makeRegistry(),
      liveRegistry,
      createSessionForSubagent: async () => {
        launched += 1
        return stubSession()
      },
      agentDir: '/agent',
      parentSessionId: 'ses_child',
      getOrigin: () => origin,
      generateTaskId: () => `bg_bg${(counter += 1)}`,
      now: () => 1_000,
      stream: createStream(),
    })
    return { tool, launchedCount: () => launched }
  }

  const subagentOrigin: SessionOrigin = {
    kind: 'subagent',
    subagent: 'researcher',
    parentSessionId: 'ses_child',
    spawnedByOrigin: { kind: 'tui', sessionId: 'ses_root' },
  }

  const tuiOrigin: SessionOrigin = { kind: 'tui', sessionId: 'ses_root' }

  const deepRegistry: SubagentRegistry = {
    reviewer: { systemPrompt: 'You are deep.', visibility: 'public', profile: 'deep' },
  }

  test('top-level spawn defaults to background', async () => {
    const { tool } = spawnWithOrigin(tuiOrigin)

    const result = await tool.execute('call_1', { subagent_type: 'explorer', prompt: 'q' }, undefined, undefined, ctx)

    const details = result.details as { ok: boolean; mode?: string }
    expect(details.ok).toBe(true)
    expect(details.mode).toBe('background')
  })

  test('top-level fast spawn honors run_in_foreground=true and runs sync', async () => {
    const { tool } = spawnWithOrigin(tuiOrigin)

    const result = await tool.execute(
      'call_1',
      { subagent_type: 'explorer', prompt: 'q', run_in_foreground: true },
      undefined,
      undefined,
      ctx,
    )

    const details = result.details as { ok: boolean; mode?: string }
    expect(details.ok).toBe(true)
    expect(details.mode).toBe('sync')
  })

  test('top-level deep-profile spawn is forced to background even when foreground is requested', async () => {
    const { tool } = spawnWithOrigin(tuiOrigin, deepRegistry)

    const result = await tool.execute(
      'call_1',
      { subagent_type: 'reviewer', prompt: 'review', run_in_foreground: true },
      undefined,
      undefined,
      ctx,
    )

    const details = result.details as { ok: boolean; mode?: string }
    expect(details.ok).toBe(true)
    expect(details.mode).toBe('background')
    expect(textOf(result)).toContain('BACKGROUND')
    expect(textOf(result)).toContain('deep profile')
  })

  test('deep-profile via per-spawn profile override is also forced to background from top-level', async () => {
    const overrideRegistry: SubagentRegistry = {
      operator: {
        systemPrompt: 'X',
        visibility: 'public',
        profile: 'default',
        payloadSchema: z.object({ prompt: z.string().optional(), profile: z.string().optional() }).passthrough(),
      },
    }
    const { tool } = spawnWithOrigin(tuiOrigin, overrideRegistry)

    const result = await tool.execute(
      'call_1',
      { subagent_type: 'operator', prompt: 'gnarly', profile: 'deep', run_in_foreground: true },
      undefined,
      undefined,
      ctx,
    )

    const details = result.details as { ok: boolean; mode?: string }
    expect(details.ok).toBe(true)
    expect(details.mode).toBe('background')
  })

  test('subagent origin defaults to foreground so the result folds in (planner->reviewer sync)', async () => {
    const plannerOrigin: SessionOrigin = {
      kind: 'subagent',
      subagent: 'planner',
      parentSessionId: 'ses_child',
      spawnedByOrigin: { kind: 'tui', sessionId: 'ses_root' },
    }
    const { tool, launchedCount } = spawnWithOrigin(plannerOrigin, deepRegistry)

    const result = await tool.execute(
      'call_1',
      { subagent_type: 'reviewer', prompt: 'review the plan' },
      undefined,
      undefined,
      ctx,
    )

    const details = result.details as { ok: boolean; mode?: string }
    expect(details.ok).toBe(true)
    expect(details.mode).toBe('sync')
    expect(launchedCount()).toBe(1)
  })

  test('foreground spawn from a subagent origin runs sync', async () => {
    const { tool, launchedCount } = spawnWithOrigin(subagentOrigin)

    const result = await tool.execute(
      'call_1',
      { subagent_type: 'explorer', prompt: 'q', run_in_foreground: true },
      undefined,
      undefined,
      ctx,
    )

    const details = result.details as { ok: boolean; mode?: string }
    expect(details.ok).toBe(true)
    expect(details.mode).toBe('sync')
    expect(launchedCount()).toBe(1)
  })

  test('explicit background (run_in_foreground=false) from a subagent that cannot drain degrades to foreground and still launches', async () => {
    const { tool, launchedCount } = spawnWithOrigin(subagentOrigin)

    const result = await tool.execute(
      'call_1',
      { subagent_type: 'explorer', prompt: 'q', run_in_foreground: false },
      undefined,
      undefined,
      ctx,
    )

    const details = result.details as { ok: boolean; mode?: string }
    expect(details.ok).toBe(true)
    expect(details.mode).toBe('sync')
    expect(launchedCount()).toBe(1)
    expect(textOf(result)).toContain('FOREGROUND')
    expect(textOf(result)).toContain('drain')
  })

  test('degrade override note is preserved when the degraded child fails', async () => {
    const session = stubSession()
    session.prompt = async () => {
      throw new Error('provider exploded')
    }
    const tool = createSpawnSubagentTool({
      registry: makeRegistry(),
      liveRegistry: new LiveSubagentRegistry(),
      createSessionForSubagent: async () => session,
      agentDir: '/agent',
      parentSessionId: 'ses_child',
      getOrigin: () => subagentOrigin,
      generateTaskId: () => 'bg_fail',
      now: () => 1_000,
      stream: createStream(),
    })

    const result = await tool.execute(
      'call_1',
      { subagent_type: 'explorer', prompt: 'q', run_in_foreground: false },
      undefined,
      undefined,
      ctx,
    )

    const details = result.details as { ok: boolean; error?: string }
    expect(details.ok).toBe(false)
    expect(details.error).toBe('provider exploded')
    const text = textOf(result)
    expect(text).toContain('FOREGROUND')
    expect(text).toContain('drain')
    expect(text).toContain('failed after')
  })

  test('subagent omitting the flag defaults to foreground with no override note', async () => {
    const { tool, launchedCount } = spawnWithOrigin(subagentOrigin)

    const result = await tool.execute('call_1', { subagent_type: 'explorer', prompt: 'q' }, undefined, undefined, ctx)

    const details = result.details as { ok: boolean; mode?: string }
    expect(details.ok).toBe(true)
    expect(details.mode).toBe('sync')
    expect(launchedCount()).toBe(1)
    expect(textOf(result)).not.toContain('FOREGROUND:')
  })

  test('drain-capable subagent (allowBackgroundFromSubagent) gets background when it opts in with run_in_foreground=false', async () => {
    const tool = createSpawnSubagentTool({
      registry: makeRegistry(),
      liveRegistry: new LiveSubagentRegistry(),
      createSessionForSubagent: async () => stubSession(),
      agentDir: '/agent',
      parentSessionId: 'ses_child',
      getOrigin: () => subagentOrigin,
      generateTaskId: () => 'bg_allowed',
      now: () => 1_000,
      stream: createStream(),
      allowBackgroundFromSubagent: true,
    })

    const result = await tool.execute(
      'call_1',
      { subagent_type: 'explorer', prompt: 'q', run_in_foreground: false },
      undefined,
      undefined,
      ctx,
    )

    const details = result.details as { ok: boolean; mode?: string }
    expect(details.ok).toBe(true)
    expect(details.mode).toBe('background')
  })
})

describe('resolveSpawnMode', () => {
  const base = {
    foreground: undefined as boolean | undefined,
    fromSubagent: false,
    isDeepProfile: false,
    canBackgroundFromSubagent: false,
    subagentName: 'scout',
  }

  test('top-level default (foreground omitted) is background', () => {
    const r = resolveSpawnMode({ ...base })
    expect(r.background).toBe(true)
    expect(r.overrideNote).toBeUndefined()
  })

  test('top-level foreground=true is honored for a non-deep subagent', () => {
    const r = resolveSpawnMode({ ...base, foreground: true })
    expect(r.background).toBe(false)
    expect(r.overrideNote).toBeUndefined()
  })

  test('top-level deep + foreground=true is forced to background with an explaining note', () => {
    const r = resolveSpawnMode({ ...base, foreground: true, isDeepProfile: true, subagentName: 'researcher' })
    expect(r.background).toBe(true)
    expect(r.overrideNote).toContain('BACKGROUND')
    expect(r.overrideNote).toContain('researcher')
  })

  test('subagent origin default (foreground omitted) is foreground — the sync-fold path', () => {
    const r = resolveSpawnMode({
      ...base,
      fromSubagent: true,
      isDeepProfile: true,
      canBackgroundFromSubagent: true,
      subagentName: 'reviewer',
    })
    expect(r.background).toBe(false)
    expect(r.overrideNote).toBeUndefined()
  })

  test('drain-capable subagent can opt into background with foreground=false', () => {
    const r = resolveSpawnMode({
      ...base,
      foreground: false,
      fromSubagent: true,
      canBackgroundFromSubagent: true,
      subagentName: 'scout',
    })
    expect(r.background).toBe(true)
    expect(r.overrideNote).toBeUndefined()
  })

  test('subagent without drain degrades a background request (foreground=false) to foreground with a note', () => {
    const r = resolveSpawnMode({
      ...base,
      foreground: false,
      fromSubagent: true,
      subagentName: 'explorer',
    })
    expect(r.background).toBe(false)
    expect(r.overrideNote).toContain('FOREGROUND')
    expect(r.overrideNote).toContain('explorer')
  })

  test('subagent explicit foreground=true needs no note', () => {
    const r = resolveSpawnMode({ ...base, foreground: true, fromSubagent: true, subagentName: 'explorer' })
    expect(r.background).toBe(false)
    expect(r.overrideNote).toBeUndefined()
  })
})
