import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { restartHandoffPath } from '@/agent/restart-handoff'
import type { RuntimeRestarter } from '@/capabilities'
import { createStream, type StreamMessage } from '@/stream'

import { createRestartTool } from './restart'

let server: ReturnType<typeof Bun.serve> | null = null
const fakeCtx = {} as Parameters<ReturnType<typeof createRestartTool>['execute']>[4]

afterEach(() => {
  server?.stop(true)
  server = null
})

// Bun.serve returns a bound port before its accept loop is guaranteed to be
// serving; under parallel-test contention the very first 127.0.0.1 connection
// can be refused/reset, which sendHttp reports as a fast ok:false and demotes
// the restart to a failure. Probe the listener with a bounded TCP connect
// (never an HTTP request — the recording fetch handlers would count it) before
// handing the server to a test.
async function serveReady(options: Parameters<typeof Bun.serve>[0]): Promise<ReturnType<typeof Bun.serve>> {
  const server = Bun.serve(options)
  const port = server.port
  if (port === undefined) return server
  for (let i = 0; i < 40; i++) {
    if (await canConnect(port)) return server
    await Bun.sleep(5)
  }
  return server
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port }, () => {
      socket.end()
      resolve(true)
    })
    socket.on('error', () => resolve(false))
  })
}

async function startOkServer(): Promise<ReturnType<typeof Bun.serve>> {
  return serveReady({
    port: 0,
    fetch() {
      return Response.json({ ok: true, result: { containerName: 'coder', scheduled: true } })
    },
  })
}

// Production callers run against a real hostd on the same host where 5s is
// generous. These tests run against an in-process `Bun.serve` under the
// same 18-worker parallel-test contention as the rest of the suite, where
// a 127.0.0.1 HTTP roundtrip can occasionally exceed 5s and flip the
// happy-path expectation `ok: true` to `ok: false, reason: 'daemon ack
// timeout'`. Passing a 30s budget here is the test-only seam documented
// at CreateRestartToolOptions.ackTimeoutMs.
const TEST_ACK_TIMEOUT_MS = 30_000

describe('createRestartTool', () => {
  test('publishes through an injected runtime restarter without taking termination ownership', async () => {
    const requests: Array<{ build: boolean }> = []
    const restarter: RuntimeRestarter = {
      requestRestart: async (request) => {
        requests.push(request)
        return { ok: true }
      },
    }
    let exitCode: number | undefined
    const tool = createRestartTool({
      containerName: 'managed-agent',
      restarter,
      originatingSessionId: 'ses-managed',
      exit: (code) => {
        exitCode = code
      },
    })

    const result = await tool.execute('id', { build: true }, undefined, undefined, fakeCtx)

    expect(requests).toEqual([{ build: true }])
    expect(result.details).toEqual({ ok: true, containerName: 'managed-agent' })
    await new Promise((resolve) => setTimeout(resolve, 750))
    expect(exitCode).toBeUndefined()
  })

  test('uses HTTP hostd transport when URL and token are configured', async () => {
    const requests: Array<{ auth: string | null; body: unknown }> = []
    server = await serveReady({
      port: 0,
      async fetch(req) {
        requests.push({ auth: req.headers.get('authorization'), body: await req.json() })
        return Response.json({ ok: true, result: { containerName: 'coder', scheduled: true } })
      },
    })
    let exitCode: number | undefined
    const tool = createRestartTool({
      containerName: 'coder',
      hostdUrl: `http://127.0.0.1:${server.port}`,
      ackTimeoutMs: TEST_ACK_TIMEOUT_MS,
      hostdToken: 'secret',
      originatingSessionId: 'ses-test-origin',
      exit: (code) => {
        exitCode = code
      },
    })

    const result = await tool.execute('id', {}, undefined, undefined, fakeCtx)

    expect(result.details).toEqual({ ok: true, containerName: 'coder' })
    expect(requests).toEqual([
      {
        auth: 'Bearer secret',
        body: { kind: 'restart', containerName: 'coder', build: false },
      },
    ])
    await new Promise((resolve) => setTimeout(resolve, 750))
    expect(exitCode).toBeUndefined()
  })

  test('forwards build:true in the RPC body when invoked with { build: true }', async () => {
    const requests: Array<{ body: unknown }> = []
    server = await serveReady({
      port: 0,
      async fetch(req) {
        requests.push({ body: await req.json() })
        return Response.json({ ok: true, result: { containerName: 'coder', scheduled: true } })
      },
    })
    const tool = createRestartTool({
      containerName: 'coder',
      hostdUrl: `http://127.0.0.1:${server.port}`,
      ackTimeoutMs: TEST_ACK_TIMEOUT_MS,
      hostdToken: 'secret',
      originatingSessionId: 'ses-test-origin',
      exit: () => {},
    })

    const result = await tool.execute('id', { build: true }, undefined, undefined, fakeCtx)

    expect(result.details).toEqual({ ok: true, containerName: 'coder' })
    expect(requests).toEqual([{ body: { kind: 'restart', containerName: 'coder', build: true } }])
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining('image rebuild') })
  })

  test('omitting build defaults to build:false in the RPC body', async () => {
    const requests: Array<{ body: unknown }> = []
    server = await serveReady({
      port: 0,
      async fetch(req) {
        requests.push({ body: await req.json() })
        return Response.json({ ok: true, result: { containerName: 'coder', scheduled: true } })
      },
    })
    const tool = createRestartTool({
      containerName: 'coder',
      hostdUrl: `http://127.0.0.1:${server.port}`,
      ackTimeoutMs: TEST_ACK_TIMEOUT_MS,
      hostdToken: 'secret',
      originatingSessionId: 'ses-test-origin',
      exit: () => {},
    })

    const result = await tool.execute('id', {}, undefined, undefined, fakeCtx)

    expect(requests).toEqual([{ body: { kind: 'restart', containerName: 'coder', build: false } }])
    expect(result.content[0]).toMatchObject({ text: expect.not.stringContaining('image rebuild') })
  })

  test('returns denial details when HTTP restart is rejected', async () => {
    server = await serveReady({
      port: 0,
      fetch() {
        return Response.json({ ok: false, reason: 'invalid restart token' })
      },
    })
    const tool = createRestartTool({
      containerName: 'coder',
      hostdUrl: `http://127.0.0.1:${server.port}`,
      ackTimeoutMs: TEST_ACK_TIMEOUT_MS,
      hostdToken: 'bad',
      originatingSessionId: 'ses-test-origin',
      exit: () => {
        throw new Error('exit should not run')
      },
    })

    const result = await tool.execute('id', {}, undefined, undefined, fakeCtx)

    expect(result.details).toEqual({ ok: false, containerName: 'coder', reason: 'invalid restart token' })
  })

  test('does not exit when hostd rejects restart before ACK', async () => {
    server = await serveReady({
      port: 0,
      fetch() {
        return Response.json({ ok: false, reason: 'host daemon source has drifted' })
      },
    })
    let exitCalled = false
    const tool = createRestartTool({
      containerName: 'coder',
      hostdUrl: `http://127.0.0.1:${server.port}`,
      ackTimeoutMs: TEST_ACK_TIMEOUT_MS,
      hostdToken: 'secret',
      originatingSessionId: 'ses-test-origin',
      exit: () => {
        exitCalled = true
      },
    })

    const result = await tool.execute('id', { build: true }, undefined, undefined, fakeCtx)

    expect(result.details).toEqual({ ok: false, containerName: 'coder', reason: 'host daemon source has drifted' })
    // Wait the full prod-side EXIT_DELAY_MS plus margin. exitCalled should
    // stay false because the denial path skips the exit timer entirely;
    // the wait observes the absence of an event, so it has to pay the full
    // budget rather than poll.
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    expect(exitCalled).toBe(false)
  })

  test('publishes a container-restarting broadcast on successful ACK', async () => {
    // given
    server = await startOkServer()
    const stream = createStream()
    const received: StreamMessage[] = []
    stream.subscribe({ target: { kind: 'broadcast' } }, (msg) => {
      received.push(msg)
    })
    const tool = createRestartTool({
      containerName: 'coder',
      hostdUrl: `http://127.0.0.1:${server.port}`,
      ackTimeoutMs: TEST_ACK_TIMEOUT_MS,
      hostdToken: 'secret',
      originatingSessionId: 'ses-test-origin',
      exit: () => {},
      stream,
    })

    // when
    await tool.execute('id', {}, undefined, undefined, fakeCtx)

    // then
    expect(received).toHaveLength(1)
    const payload = received[0]?.payload as { kind: string; restartedAt: string }
    expect(payload.kind).toBe('container-restarting')
    expect(typeof payload.restartedAt).toBe('string')
    expect(() => new Date(payload.restartedAt).toISOString()).not.toThrow()
    expect(new Date(payload.restartedAt).toISOString()).toBe(payload.restartedAt)
  })

  test('broadcast carries the originatingSessionId passed at construction', async () => {
    // given
    server = await startOkServer()
    const stream = createStream()
    const received: StreamMessage[] = []
    stream.subscribe({ target: { kind: 'broadcast' } }, (msg) => {
      received.push(msg)
    })
    const tool = createRestartTool({
      containerName: 'coder',
      hostdUrl: `http://127.0.0.1:${server.port}`,
      ackTimeoutMs: TEST_ACK_TIMEOUT_MS,
      hostdToken: 'secret',
      originatingSessionId: 'ses-the-one-that-asked',
      exit: () => {},
      stream,
    })

    // when
    await tool.execute('id', {}, undefined, undefined, fakeCtx)

    // then
    expect(received).toHaveLength(1)
    const payload = received[0]?.payload as { originatingSessionId: string }
    expect(payload.originatingSessionId).toBe('ses-the-one-that-asked')
  })

  test('does not publish a broadcast when hostd denies the restart', async () => {
    // given
    server = await serveReady({
      port: 0,
      fetch() {
        return Response.json({ ok: false, reason: 'denied' })
      },
    })
    const stream = createStream()
    const received: StreamMessage[] = []
    stream.subscribe({ target: { kind: 'broadcast' } }, (msg) => {
      received.push(msg)
    })
    const tool = createRestartTool({
      containerName: 'coder',
      hostdUrl: `http://127.0.0.1:${server.port}`,
      ackTimeoutMs: TEST_ACK_TIMEOUT_MS,
      hostdToken: 'bad',
      originatingSessionId: 'ses-test-origin',
      exit: () => {
        throw new Error('exit should not run')
      },
      stream,
    })

    // when
    await tool.execute('id', {}, undefined, undefined, fakeCtx)

    // then
    expect(received).toHaveLength(0)
  })

  test('completes successfully when stream is omitted (back-compat for non-runtime callers)', async () => {
    // given
    server = await startOkServer()
    let exitCode: number | undefined
    const tool = createRestartTool({
      containerName: 'coder',
      hostdUrl: `http://127.0.0.1:${server.port}`,
      ackTimeoutMs: TEST_ACK_TIMEOUT_MS,
      hostdToken: 'secret',
      originatingSessionId: 'ses-test-origin',
      exit: (code) => {
        exitCode = code
      },
    })

    // when
    const result = await tool.execute('id', {}, undefined, undefined, fakeCtx)

    // then
    expect(result.details).toEqual({ ok: true, containerName: 'coder' })
    await new Promise((resolve) => setTimeout(resolve, 750))
    expect(exitCode).toBeUndefined()
  })
})

describe('createRestartTool restart-pending handoff', () => {
  let agentDir: string

  beforeEach(async () => {
    agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-restart-tool-handoff-'))
  })

  afterEach(async () => {
    await rm(agentDir, { recursive: true, force: true })
  })

  test('writes the handoff file when agentDir and originatingSessionFile are passed', async () => {
    // given
    server = await startOkServer()
    const tool = createRestartTool({
      containerName: 'coder',
      hostdUrl: `http://127.0.0.1:${server.port}`,
      ackTimeoutMs: TEST_ACK_TIMEOUT_MS,
      hostdToken: 'secret',
      originatingSessionId: 'ses-originator',
      exit: () => {},
      agentDir,
      originatingSessionFile: '/some/abs/path/ses-originator.jsonl',
      handoffOrigin: { kind: 'tui' },
    })

    // when
    await tool.execute('id', {}, undefined, undefined, fakeCtx)

    // then
    const raw = await readFile(restartHandoffPath(agentDir), 'utf8')
    const parsed = JSON.parse(raw)
    expect(parsed.schemaVersion).toBe(2)
    expect(parsed.origin).toEqual({ kind: 'tui' })
    expect(parsed.originatingSessionId).toBe('ses-originator')
    expect(parsed.originatingSessionFile).toBe('ses-originator.jsonl')
    expect(typeof parsed.restartedAt).toBe('string')
    expect(new Date(parsed.restartedAt).toISOString()).toBe(parsed.restartedAt)
  })

  test('writes a channel-origin handoff carrying the channel key', async () => {
    // given
    server = await startOkServer()
    const tool = createRestartTool({
      containerName: 'coder',
      hostdUrl: `http://127.0.0.1:${server.port}`,
      ackTimeoutMs: TEST_ACK_TIMEOUT_MS,
      hostdToken: 'secret',
      originatingSessionId: 'ses-channel',
      exit: () => {},
      agentDir,
      originatingSessionFile: '/some/abs/path/ses-channel.jsonl',
      handoffOrigin: {
        kind: 'channel',
        key: { adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: null },
      },
    })

    // when
    await tool.execute('id', {}, undefined, undefined, fakeCtx)

    // then
    const parsed = JSON.parse(await readFile(restartHandoffPath(agentDir), 'utf8'))
    expect(parsed.schemaVersion).toBe(2)
    expect(parsed.origin).toEqual({
      kind: 'channel',
      key: { adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: null },
    })
    expect(parsed.originatingSessionFile).toBe('ses-channel.jsonl')
  })

  test('writes the LIVE turn author into the handoff, not the session-creation author', async () => {
    // given: the provider tracks a mutable holder advanced after construction
    server = await startOkServer()
    const liveAuthor = { current: 'U_OPENER' as string | undefined }
    const tool = createRestartTool({
      containerName: 'coder',
      hostdUrl: `http://127.0.0.1:${server.port}`,
      ackTimeoutMs: TEST_ACK_TIMEOUT_MS,
      hostdToken: 'secret',
      originatingSessionId: 'ses-channel',
      exit: () => {},
      agentDir,
      originatingSessionFile: '/some/abs/path/ses-channel.jsonl',
      handoffOrigin: {
        kind: 'channel',
        key: { adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: null },
      },
      triggeringAuthorIdProvider: () => liveAuthor.current,
    })

    // when: a different speaker drives the turn that fires the restart
    liveAuthor.current = 'U_LATER'
    await tool.execute('id', {}, undefined, undefined, fakeCtx)

    // then: the handoff carries the current-turn author, not the opener
    const parsed = JSON.parse(await readFile(restartHandoffPath(agentDir), 'utf8'))
    expect(parsed.triggeringAuthorId).toBe('U_LATER')
  })

  test('skips the handoff when handoffOrigin is omitted (cron/subagent/system origins)', async () => {
    // given
    server = await startOkServer()
    const tool = createRestartTool({
      containerName: 'coder',
      hostdUrl: `http://127.0.0.1:${server.port}`,
      ackTimeoutMs: TEST_ACK_TIMEOUT_MS,
      hostdToken: 'secret',
      originatingSessionId: 'ses-cron',
      exit: () => {},
      agentDir,
      originatingSessionFile: 'ses-cron.jsonl',
    })

    // when
    await tool.execute('id', {}, undefined, undefined, fakeCtx)

    // then
    expect(existsSync(restartHandoffPath(agentDir))).toBe(false)
  })

  test('skips the handoff when agentDir is omitted (non-TUI origins do not greet)', async () => {
    // given
    server = await startOkServer()
    const tool = createRestartTool({
      containerName: 'coder',
      hostdUrl: `http://127.0.0.1:${server.port}`,
      ackTimeoutMs: TEST_ACK_TIMEOUT_MS,
      hostdToken: 'secret',
      originatingSessionId: 'ses-channel',
      exit: () => {},
      originatingSessionFile: 'ses-channel.jsonl',
    })

    // when
    await tool.execute('id', {}, undefined, undefined, fakeCtx)

    // then
    expect(existsSync(restartHandoffPath(agentDir))).toBe(false)
  })

  test('skips the handoff when originatingSessionFile is omitted (in-memory sessions)', async () => {
    // given
    server = await startOkServer()
    const tool = createRestartTool({
      containerName: 'coder',
      hostdUrl: `http://127.0.0.1:${server.port}`,
      ackTimeoutMs: TEST_ACK_TIMEOUT_MS,
      hostdToken: 'secret',
      originatingSessionId: 'ses-inmem',
      exit: () => {},
      agentDir,
    })

    // when
    await tool.execute('id', {}, undefined, undefined, fakeCtx)

    // then
    expect(existsSync(restartHandoffPath(agentDir))).toBe(false)
  })

  test('does not write the handoff when hostd denies the restart', async () => {
    // given
    server = await serveReady({
      port: 0,
      fetch() {
        return Response.json({ ok: false, reason: 'denied' })
      },
    })
    const tool = createRestartTool({
      containerName: 'coder',
      hostdUrl: `http://127.0.0.1:${server.port}`,
      ackTimeoutMs: TEST_ACK_TIMEOUT_MS,
      hostdToken: 'bad',
      originatingSessionId: 'ses-originator',
      exit: () => {
        throw new Error('exit should not run')
      },
      agentDir,
      originatingSessionFile: 'ses-originator.jsonl',
      handoffOrigin: { kind: 'tui' },
    })

    // when
    await tool.execute('id', {}, undefined, undefined, fakeCtx)

    // then
    expect(existsSync(restartHandoffPath(agentDir))).toBe(false)
  })

  test('uses the broadcast restartedAt timestamp in the handoff (single source of truth)', async () => {
    // given
    server = await startOkServer()
    const stream = createStream()
    const received: StreamMessage[] = []
    stream.subscribe({ target: { kind: 'broadcast' } }, (msg) => received.push(msg))
    const tool = createRestartTool({
      containerName: 'coder',
      hostdUrl: `http://127.0.0.1:${server.port}`,
      ackTimeoutMs: TEST_ACK_TIMEOUT_MS,
      hostdToken: 'secret',
      originatingSessionId: 'ses-originator',
      exit: () => {},
      stream,
      agentDir,
      originatingSessionFile: 'ses-originator.jsonl',
      handoffOrigin: { kind: 'tui' },
    })

    // when
    await tool.execute('id', {}, undefined, undefined, fakeCtx)

    // then
    expect(received).toHaveLength(1)
    const broadcastTs = (received[0]!.payload as { restartedAt: string }).restartedAt
    const handoff = JSON.parse(await readFile(restartHandoffPath(agentDir), 'utf8'))
    expect(handoff.restartedAt).toBe(broadcastTs)
  })
})
