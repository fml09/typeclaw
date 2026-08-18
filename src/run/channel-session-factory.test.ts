import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SessionManager } from '@mariozechner/pi-coding-agent'
import type { AgentSession } from '@mariozechner/pi-coding-agent'

import type { CreateSessionOptions } from '@/agent'
import type { RuntimeRestarter } from '@/capabilities'
import type { ChannelRouter } from '@/channels'
import type { ReloadRegistry } from '@/reload'
import type { SessionFactory } from '@/sessions'
import type { Stream } from '@/stream'

import { buildChannelSessionFactory } from './channel-session-factory'
import { createPluginRuntime, type PluginRuntime } from './plugin-runtime'

function makeFakeRouter(): ChannelRouter {
  return {} as ChannelRouter
}

function makeFakeStream(): Stream {
  return {} as Stream
}

function makeFakeReloadRegistry(): ReloadRegistry {
  return {} as ReloadRegistry
}

function makeFakeSessionFactory(sessionDir: string): SessionFactory {
  return { sessionDir: () => sessionDir } as SessionFactory
}

function makeEmptyRuntime(): PluginRuntime {
  return createPluginRuntime({
    registry: { tools: [], subagents: [], cronJobs: [], skills: [], skillsDirs: [], doctorChecks: [] } as never,
    hooks: {} as never,
    subagents: { byName: new Map(), all: [] } as never,
    pluginSubagentByShim: new WeakMap(),
    hasAnyPluginContent: false,
    loadedPlugins: [],
    materializedSkills: null,
  })
}

function makeRuntimeWithPlugin(): PluginRuntime {
  return createPluginRuntime({
    registry: { tools: [], subagents: [], cronJobs: [], skills: [], skillsDirs: [], doctorChecks: [] } as never,
    hooks: {} as never,
    subagents: { byName: new Map(), all: [] } as never,
    pluginSubagentByShim: new WeakMap(),
    hasAnyPluginContent: true,
    loadedPlugins: [{ name: 'memory', version: undefined, source: '<bundled>' }],
    materializedSkills: null,
  })
}

const STUB_SESSION = { dispose: () => {} } as unknown as AgentSession

type Captured = CreateSessionOptions | undefined

describe('buildChannelSessionFactory — production wiring contract', () => {
  test('creates sessions with channelRouter set (the bug this factory fixes)', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'channel-session-factory-'))
    const router = makeFakeRouter()
    let captured: Captured = undefined
    const fakeCreateSession = async (options?: CreateSessionOptions) => {
      captured = options
      return STUB_SESSION
    }

    const factory = buildChannelSessionFactory({
      cwd: tmp,
      sessionFactory: makeFakeSessionFactory(join(tmp, 'sessions')),
      stream: makeFakeStream(),
      reloadRegistry: makeFakeReloadRegistry(),
      pluginRuntime: makeEmptyRuntime(),
      getChannelRouter: () => router,
      createSession: fakeCreateSession,
      rehydrateCapOptions: null,
    })

    await factory({
      key: { adapter: 'discord-bot', workspace: '@dm', chat: 'c1', thread: null },
      participants: [],
      origin: { kind: 'channel', adapter: 'discord-bot', workspace: '@dm', chat: 'c1', thread: null, participants: [] },
      originRef: { current: undefined },
    })

    expect(captured).toBeDefined()
    expect(captured!.channelRouter).toBe(router)
  })

  test('threads stream and reloadRegistry into the session (so reload + stream tools are wired)', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'channel-session-factory-'))
    const stream = makeFakeStream()
    const reloadRegistry = makeFakeReloadRegistry()
    let captured: Captured = undefined

    const factory = buildChannelSessionFactory({
      cwd: tmp,
      sessionFactory: makeFakeSessionFactory(join(tmp, 'sessions')),
      stream,
      reloadRegistry,
      pluginRuntime: makeEmptyRuntime(),
      getChannelRouter: makeFakeRouter,
      createSession: async (options) => {
        captured = options
        return STUB_SESSION
      },
      rehydrateCapOptions: null,
    })

    await factory({
      key: { adapter: 'discord-bot', workspace: '@dm', chat: 'c1', thread: null },
      participants: [],
      origin: { kind: 'channel', adapter: 'discord-bot', workspace: '@dm', chat: 'c1', thread: null, participants: [] },
      originRef: { current: undefined },
    })

    expect(captured!.stream).toBe(stream)
    expect(captured!.reloadRegistry).toBe(reloadRegistry)
  })

  test('threads the bound runtime restarter into channel sessions', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'channel-session-factory-'))
    const restarter: RuntimeRestarter = { requestRestart: async () => ({ ok: true }) }
    let captured: Captured = undefined

    const factory = buildChannelSessionFactory({
      cwd: tmp,
      sessionFactory: makeFakeSessionFactory(join(tmp, 'sessions')),
      stream: makeFakeStream(),
      reloadRegistry: makeFakeReloadRegistry(),
      pluginRuntime: makeEmptyRuntime(),
      getChannelRouter: makeFakeRouter,
      containerName: 'managed-agent',
      restarter,
      createSession: async (options) => {
        captured = options
        return STUB_SESSION
      },
      rehydrateCapOptions: null,
    })

    await factory({
      key: { adapter: 'discord-bot', workspace: '@dm', chat: 'c1', thread: null },
      participants: [],
      origin: { kind: 'channel', adapter: 'discord-bot', workspace: '@dm', chat: 'c1', thread: null, participants: [] },
      originRef: { current: undefined },
    })

    expect(captured).toBeDefined()
    expect(captured!.restarter).toBe(restarter)
  })

  test('omits plugin wiring when the runtime has no plugin content (avoids cost of plugin tool injection)', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'channel-session-factory-'))
    let captured: Captured = undefined

    const factory = buildChannelSessionFactory({
      cwd: tmp,
      sessionFactory: makeFakeSessionFactory(join(tmp, 'sessions')),
      stream: makeFakeStream(),
      reloadRegistry: makeFakeReloadRegistry(),
      pluginRuntime: makeEmptyRuntime(),
      getChannelRouter: makeFakeRouter,
      createSession: async (options) => {
        captured = options
        return STUB_SESSION
      },
      rehydrateCapOptions: null,
    })

    await factory({
      key: { adapter: 'discord-bot', workspace: '@dm', chat: 'c1', thread: null },
      participants: [],
      origin: { kind: 'channel', adapter: 'discord-bot', workspace: '@dm', chat: 'c1', thread: null, participants: [] },
      originRef: { current: undefined },
    })

    expect(captured!.plugins).toBeUndefined()
  })

  test('threads plugin runtime into the session when plugins are present', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'channel-session-factory-'))
    const runtime = makeRuntimeWithPlugin()
    let captured: Captured = undefined

    const factory = buildChannelSessionFactory({
      cwd: tmp,
      sessionFactory: makeFakeSessionFactory(join(tmp, 'sessions')),
      stream: makeFakeStream(),
      reloadRegistry: makeFakeReloadRegistry(),
      pluginRuntime: runtime,
      getChannelRouter: makeFakeRouter,
      createSession: async (options) => {
        captured = options
        return STUB_SESSION
      },
      rehydrateCapOptions: null,
    })

    await factory({
      key: { adapter: 'discord-bot', workspace: '@dm', chat: 'c1', thread: null },
      participants: [],
      origin: { kind: 'channel', adapter: 'discord-bot', workspace: '@dm', chat: 'c1', thread: null, participants: [] },
      originRef: { current: undefined },
    })

    expect(captured!.plugins).toBeDefined()
    expect(captured!.plugins!.registry).toBe(runtime.get().registry)
    expect(captured!.plugins!.hooks).toBe(runtime.get().hooks)
    expect(captured!.plugins!.agentDir).toBe(tmp)
  })

  test('passes through the channel origin verbatim so channel_send target matches inbound', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'channel-session-factory-'))
    let captured: Captured = undefined
    const origin = {
      kind: 'channel' as const,
      adapter: 'discord-bot' as const,
      workspace: 'guild-123',
      chat: 'channel-456',
      thread: null,
      participants: [{ authorId: 'u1', authorName: 'alice', firstMessageAt: 1, lastMessageAt: 1, messageCount: 1 }],
    }

    const factory = buildChannelSessionFactory({
      cwd: tmp,
      sessionFactory: makeFakeSessionFactory(join(tmp, 'sessions')),
      stream: makeFakeStream(),
      reloadRegistry: makeFakeReloadRegistry(),
      pluginRuntime: makeEmptyRuntime(),
      getChannelRouter: makeFakeRouter,
      createSession: async (options) => {
        captured = options
        return STUB_SESSION
      },
      rehydrateCapOptions: null,
    })

    await factory({
      key: { adapter: 'discord-bot', workspace: 'guild-123', chat: 'channel-456', thread: null },
      participants: origin.participants,
      origin,
      originRef: { current: undefined },
    })

    expect(captured!.origin).toEqual(origin)
  })

  test('reads getChannelRouter lazily so the manager-router construction cycle resolves', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'channel-session-factory-'))
    let router: ChannelRouter | null = null
    let captured: Captured = undefined

    const factory = buildChannelSessionFactory({
      cwd: tmp,
      sessionFactory: makeFakeSessionFactory(join(tmp, 'sessions')),
      stream: makeFakeStream(),
      reloadRegistry: makeFakeReloadRegistry(),
      pluginRuntime: makeEmptyRuntime(),
      getChannelRouter: () => {
        if (router === null) throw new Error('router not yet bound')
        return router
      },
      createSession: async (options) => {
        captured = options
        return STUB_SESSION
      },
      rehydrateCapOptions: null,
    })

    router = makeFakeRouter()

    await factory({
      key: { adapter: 'discord-bot', workspace: '@dm', chat: 'c1', thread: null },
      participants: [],
      origin: { kind: 'channel', adapter: 'discord-bot', workspace: '@dm', chat: 'c1', thread: null, participants: [] },
      originRef: { current: undefined },
    })

    expect(captured!.channelRouter).toBe(router)
  })

  test('uses sessionFactory.sessionDir() so persisted sessions land where the rest of the runtime expects', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'channel-session-factory-'))
    const sessionDir = join(tmp, 'sessions')
    let capturedSm: SessionManager | null = null

    const factory = buildChannelSessionFactory({
      cwd: tmp,
      sessionFactory: makeFakeSessionFactory(sessionDir),
      stream: makeFakeStream(),
      reloadRegistry: makeFakeReloadRegistry(),
      pluginRuntime: makeEmptyRuntime(),
      getChannelRouter: makeFakeRouter,
      createSession: async (options) => {
        capturedSm = options?.sessionManager ?? null
        return STUB_SESSION
      },
      rehydrateCapOptions: null,
    })

    await factory({
      key: { adapter: 'discord-bot', workspace: '@dm', chat: 'c1', thread: null },
      participants: [],
      origin: { kind: 'channel', adapter: 'discord-bot', workspace: '@dm', chat: 'c1', thread: null, participants: [] },
      originRef: { current: undefined },
    })

    expect(capturedSm).not.toBeNull()
  })

  test('returns hooks and getTranscriptPath so the channel router can fire session.idle/session.end', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'channel-session-factory-'))
    const runtime = makeRuntimeWithPlugin()

    const factory = buildChannelSessionFactory({
      cwd: tmp,
      sessionFactory: makeFakeSessionFactory(join(tmp, 'sessions')),
      stream: makeFakeStream(),
      reloadRegistry: makeFakeReloadRegistry(),
      pluginRuntime: runtime,
      getChannelRouter: makeFakeRouter,
      createSession: async () => STUB_SESSION,
      rehydrateCapOptions: null,
    })

    const result = await factory({
      key: { adapter: 'discord-bot', workspace: '@dm', chat: 'c1', thread: null },
      participants: [],
      origin: { kind: 'channel', adapter: 'discord-bot', workspace: '@dm', chat: 'c1', thread: null, participants: [] },
      originRef: { current: undefined },
    })

    expect(result.hooks).toBe(runtime.get().hooks)
    expect(typeof result.getTranscriptPath).toBe('function')
    expect(result.getTranscriptPath?.()).toMatch(/sessions[/\\]/)
  })

  test('omits hooks when no plugin runtime content (matches existing plugin-omission policy)', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'channel-session-factory-'))

    const factory = buildChannelSessionFactory({
      cwd: tmp,
      sessionFactory: makeFakeSessionFactory(join(tmp, 'sessions')),
      stream: makeFakeStream(),
      reloadRegistry: makeFakeReloadRegistry(),
      pluginRuntime: makeEmptyRuntime(),
      getChannelRouter: makeFakeRouter,
      createSession: async () => STUB_SESSION,
      rehydrateCapOptions: null,
    })

    const result = await factory({
      key: { adapter: 'discord-bot', workspace: '@dm', chat: 'c1', thread: null },
      participants: [],
      origin: { kind: 'channel', adapter: 'discord-bot', workspace: '@dm', chat: 'c1', thread: null, participants: [] },
      originRef: { current: undefined },
    })

    expect(result.hooks).toBeUndefined()
  })

  test('caps oversized tool results in the JSONL before pi-coding-agent opens it', async () => {
    const { mkdirSync, writeFileSync, readFileSync } = await import('node:fs')
    const tmp = mkdtempSync(join(tmpdir(), 'channel-session-factory-'))
    const sessionDir = join(tmp, 'sessions')
    mkdirSync(sessionDir, { recursive: true })
    const sessionFile = 'poisoned.jsonl'
    const sessionPath = join(sessionDir, sessionFile)
    const lines = [
      JSON.stringify({ type: 'session', id: 'poisoned-id', timestamp: '2026-05-12T00:00:00Z', cwd: tmp, version: 3 }),
      JSON.stringify({
        type: 'message',
        id: 'e1',
        parentId: null,
        timestamp: '2026-05-12T00:00:01Z',
        message: {
          role: 'toolResult',
          toolCallId: 'functions.read:1',
          toolName: 'read',
          content: [{ type: 'image', mimeType: 'image/png', data: 'A'.repeat(5000) }],
        },
      }),
    ]
    writeFileSync(sessionPath, `${lines.join('\n')}\n`)
    const capLogs: string[] = []
    const warnLogs: string[] = []

    const factory = buildChannelSessionFactory({
      cwd: tmp,
      sessionFactory: makeFakeSessionFactory(sessionDir),
      stream: makeFakeStream(),
      reloadRegistry: makeFakeReloadRegistry(),
      pluginRuntime: makeEmptyRuntime(),
      getChannelRouter: makeFakeRouter,
      createSession: async () => STUB_SESSION,
      rehydrateCapOptions: { imageMaxBytes: 100, textMaxBytes: 100, exemptTools: new Set() },
      logger: { info: (msg) => capLogs.push(msg), warn: (msg) => warnLogs.push(msg) },
    })

    await factory({
      key: { adapter: 'discord-bot', workspace: '@dm', chat: 'c1', thread: null },
      existingSessionId: 'poisoned-id',
      existingSessionFile: sessionFile,
      participants: [],
      origin: { kind: 'channel', adapter: 'discord-bot', workspace: '@dm', chat: 'c1', thread: null, participants: [] },
      originRef: { current: undefined },
    })

    const after = readFileSync(sessionPath, 'utf8')
    expect(after).not.toContain('A'.repeat(5000))
    expect(after).toContain('tool-result-cap')
    expect(capLogs.some((l) => l.includes('rehydrate-cap'))).toBe(true)
  })

  test('leaves the JSONL untouched when rehydrateCapOptions is null', async () => {
    const { mkdirSync, writeFileSync, readFileSync } = await import('node:fs')
    const tmp = mkdtempSync(join(tmpdir(), 'channel-session-factory-'))
    const sessionDir = join(tmp, 'sessions')
    mkdirSync(sessionDir, { recursive: true })
    const sessionFile = 'untouched.jsonl'
    const sessionPath = join(sessionDir, sessionFile)
    const original = `${JSON.stringify({
      type: 'session',
      id: 'untouched-id',
      timestamp: '2026-05-12T00:00:00Z',
      cwd: tmp,
      version: 3,
    })}\n${JSON.stringify({
      type: 'message',
      id: 'e1',
      parentId: null,
      timestamp: '2026-05-12T00:00:01Z',
      message: {
        role: 'toolResult',
        toolCallId: 'functions.read:1',
        toolName: 'read',
        content: [{ type: 'image', mimeType: 'image/png', data: 'A'.repeat(5000) }],
      },
    })}\n`
    writeFileSync(sessionPath, original)

    const factory = buildChannelSessionFactory({
      cwd: tmp,
      sessionFactory: makeFakeSessionFactory(sessionDir),
      stream: makeFakeStream(),
      reloadRegistry: makeFakeReloadRegistry(),
      pluginRuntime: makeEmptyRuntime(),
      getChannelRouter: makeFakeRouter,
      createSession: async () => STUB_SESSION,
      rehydrateCapOptions: null,
    })

    await factory({
      key: { adapter: 'discord-bot', workspace: '@dm', chat: 'c1', thread: null },
      existingSessionId: 'untouched-id',
      existingSessionFile: sessionFile,
      participants: [],
      origin: { kind: 'channel', adapter: 'discord-bot', workspace: '@dm', chat: 'c1', thread: null, participants: [] },
      originRef: { current: undefined },
    })

    expect(readFileSync(sessionPath, 'utf8')).toBe(original)
  })

  test('rejects path-traversal sessionFile and falls back to a fresh session', async () => {
    const { mkdirSync, writeFileSync, readFileSync, existsSync } = await import('node:fs')
    const tmp = mkdtempSync(join(tmpdir(), 'channel-session-factory-'))
    const sessionDir = join(tmp, 'sessions')
    mkdirSync(sessionDir, { recursive: true })
    // A bystander file outside sessions/ that the cap pass must never touch
    // even if a tampered channels/sessions.json#sessionFile points at it.
    const bystander = join(tmp, 'bystander.jsonl')
    const bystanderContent = `${JSON.stringify({
      type: 'message',
      id: 'b1',
      parentId: null,
      timestamp: '2026-05-12T00:00:01Z',
      message: {
        role: 'toolResult',
        toolCallId: 'functions.read:1',
        toolName: 'read',
        content: [{ type: 'image', mimeType: 'image/png', data: 'A'.repeat(5000) }],
      },
    })}\n`
    writeFileSync(bystander, bystanderContent)
    const warnLogs: string[] = []

    const factory = buildChannelSessionFactory({
      cwd: tmp,
      sessionFactory: makeFakeSessionFactory(sessionDir),
      stream: makeFakeStream(),
      reloadRegistry: makeFakeReloadRegistry(),
      pluginRuntime: makeEmptyRuntime(),
      getChannelRouter: makeFakeRouter,
      createSession: async () => STUB_SESSION,
      rehydrateCapOptions: { imageMaxBytes: 100, textMaxBytes: 100, exemptTools: new Set() },
      logger: { info: () => {}, warn: (msg) => warnLogs.push(msg) },
    })

    await factory({
      key: { adapter: 'discord-bot', workspace: '@dm', chat: 'c1', thread: null },
      existingSessionId: 'malicious',
      existingSessionFile: '../bystander.jsonl',
      participants: [],
      origin: { kind: 'channel', adapter: 'discord-bot', workspace: '@dm', chat: 'c1', thread: null, participants: [] },
      originRef: { current: undefined },
    })

    expect(readFileSync(bystander, 'utf8')).toBe(bystanderContent)
    expect(existsSync(join(sessionDir, '../bystander.jsonl.cap.tmp'))).toBe(false)
    expect(warnLogs.some((l) => l.includes('invalid sessionFile'))).toBe(true)
  })
})
