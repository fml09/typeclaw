import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { acquireRestartHandoffLock, restartHandoffPath } from '@/agent/restart-handoff'
import { createStream, type StreamMessage } from '@/stream'

import { requestContainerRestart } from './index'

let server: ReturnType<typeof Bun.serve> | null = null

const TEST_ACK_TIMEOUT_MS = 30_000

afterEach(() => {
  server?.stop(true)
  server = null
})

describe('requestContainerRestart', () => {
  let agentDir: string

  beforeEach(async () => {
    agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-request-restart-'))
  })

  afterEach(async () => {
    await rm(agentDir, { recursive: true, force: true })
  })

  test('uses an injected runtime restarter before consulting hostd environment', async () => {
    const requests: Array<{ build: boolean }> = []
    const result = await requestContainerRestart({
      containerName: 'managed-agent',
      restarter: {
        async requestRestart(request) {
          requests.push(request)
          return { ok: true }
        },
      },
      build: false,
      restartedAt: '2026-08-18T12:34:56.000Z',
    })

    expect(requests).toEqual([{ build: false }])
    expect(result).toEqual({
      ok: true,
      containerName: 'managed-agent',
      restartedAt: '2026-08-18T12:34:56.000Z',
    })
  })

  test('treats an explicit null restarter as authoritative instead of falling back to hostd', async () => {
    let requests = 0
    server = Bun.serve({
      port: 0,
      fetch() {
        requests++
        return Response.json({ ok: true, result: { containerName: 'wrong', scheduled: true } })
      },
    })

    const result = await requestContainerRestart({
      containerName: 'managed-agent',
      restarter: null,
      hostdUrl: `http://127.0.0.1:${server.port}`,
      hostdToken: 'stale-token',
    })

    expect(result.ok).toBe(false)
    expect(requests).toBe(0)
  })

  test('uses HTTP transport and returns the accepted restart timestamp', async () => {
    // given
    const requests: Array<{ auth: string | null; body: unknown }> = []
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        requests.push({ auth: req.headers.get('authorization'), body: await req.json() })
        return Response.json({ ok: true, result: { containerName: 'coder', scheduled: true } })
      },
    })

    // when
    const result = await requestContainerRestart({
      containerName: 'coder',
      hostdUrl: `http://127.0.0.1:${server.port}`,
      hostdToken: 'secret',
      ackTimeoutMs: TEST_ACK_TIMEOUT_MS,
      restartedAt: '2026-01-02T03:04:05.000Z',
    })

    // then
    expect(result).toEqual({ ok: true, containerName: 'coder', restartedAt: '2026-01-02T03:04:05.000Z' })
    expect(requests).toEqual([
      {
        auth: 'Bearer secret',
        body: { kind: 'restart', containerName: 'coder', build: false },
      },
    ])
  })

  test('returns failure without writing a handoff when hostd rejects the restart', async () => {
    // given
    server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({ ok: false, reason: 'not registered: coder' })
      },
    })

    // when
    const result = await requestContainerRestart({
      containerName: 'coder',
      hostdUrl: `http://127.0.0.1:${server.port}`,
      hostdToken: 'secret',
      ackTimeoutMs: TEST_ACK_TIMEOUT_MS,
      agentDir,
      originatingSessionId: 'ses-origin',
      originatingSessionFile: '/tmp/sessions/ses-origin.jsonl',
    })

    // then
    expect(result).toEqual({ ok: false, containerName: 'coder', reason: 'not registered: coder' })
    expect(existsSync(restartHandoffPath(agentDir))).toBe(false)
  })

  test('writes handoff only when every handoff field is present', async () => {
    // given
    server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({ ok: true, result: { containerName: 'coder', scheduled: true } })
      },
    })

    // when: originatingSessionFile missing → no handoff
    await requestContainerRestart({
      containerName: 'coder',
      hostdUrl: `http://127.0.0.1:${server.port}`,
      hostdToken: 'secret',
      ackTimeoutMs: TEST_ACK_TIMEOUT_MS,
      agentDir,
      originatingSessionId: 'ses-incomplete',
      handoffOrigin: { kind: 'tui' },
      restartedAt: '2026-01-02T03:04:05.000Z',
    })
    expect(existsSync(restartHandoffPath(agentDir))).toBe(false)

    // when: handoffOrigin missing → no handoff
    await requestContainerRestart({
      containerName: 'coder',
      hostdUrl: `http://127.0.0.1:${server.port}`,
      hostdToken: 'secret',
      ackTimeoutMs: TEST_ACK_TIMEOUT_MS,
      agentDir,
      originatingSessionId: 'ses-no-origin',
      originatingSessionFile: '/tmp/sessions/ses-no-origin.jsonl',
      restartedAt: '2026-01-02T03:04:05.000Z',
    })
    expect(existsSync(restartHandoffPath(agentDir))).toBe(false)

    const result = await requestContainerRestart({
      containerName: 'coder',
      hostdUrl: `http://127.0.0.1:${server.port}`,
      hostdToken: 'secret',
      ackTimeoutMs: TEST_ACK_TIMEOUT_MS,
      agentDir,
      originatingSessionId: 'ses-origin',
      originatingSessionFile: '/tmp/sessions/ses-origin.jsonl',
      handoffOrigin: { kind: 'tui' },
      restartedAt: '2026-01-02T03:04:05.000Z',
    })

    // then
    expect(result).toEqual({ ok: true, containerName: 'coder', restartedAt: '2026-01-02T03:04:05.000Z' })
    expect(JSON.parse(await readFile(restartHandoffPath(agentDir), 'utf8'))).toEqual({
      schemaVersion: 2,
      restartedAt: '2026-01-02T03:04:05.000Z',
      originatingSessionId: 'ses-origin',
      originatingSessionFile: 'ses-origin.jsonl',
      origin: { kind: 'tui' },
    })
  })

  test('holds the handoff lock across the ACK so a concurrent handoff producer waits for the commit', async () => {
    // given: a hostd whose ACK is withheld until we release it — the window where
    //   SIGTERM (docker stop) can fire before requestContainerRestart's write lands
    let releaseAck!: () => void
    const ackGate = new Promise<void>((resolve) => {
      releaseAck = resolve
    })
    server = Bun.serve({
      port: 0,
      async fetch() {
        await ackGate
        return Response.json({ ok: true, result: { containerName: 'coder', scheduled: true } })
      },
    })

    const restartDone = requestContainerRestart({
      containerName: 'coder',
      hostdUrl: `http://127.0.0.1:${server.port}`,
      hostdToken: 'secret',
      ackTimeoutMs: TEST_ACK_TIMEOUT_MS,
      agentDir,
      originatingSessionId: 'ses-origin',
      originatingSessionFile: '/tmp/sessions/ses-origin.jsonl',
      handoffOrigin: { kind: 'channel', key: { adapter: 'discord-bot', workspace: 'g', chat: 'c', thread: null } },
      triggeringAuthorId: 'U_OWNER',
      restartedAt: '2026-01-02T03:04:05.000Z',
    })

    // when: a second producer tries to take the handoff lock while the ACK is withheld
    let secondAcquired = false
    const second = acquireRestartHandoffLock(agentDir).then((r) => {
      secondAcquired = true
      return r
    })
    await new Promise((r) => setTimeout(r, 20))

    // then: it is blocked — requestContainerRestart holds the lock from before the ACK
    expect(secondAcquired).toBe(false)
    expect(existsSync(restartHandoffPath(agentDir))).toBe(false)

    // when: the ACK lands, requestContainerRestart writes and releases the lock
    releaseAck()
    await restartDone
    const release2 = await second

    // then: the second producer only proceeds AFTER the committed handoff exists,
    //   and that handoff carries requestContainerRestart's origin + author
    expect(secondAcquired).toBe(true)
    expect(JSON.parse(await readFile(restartHandoffPath(agentDir), 'utf8'))).toMatchObject({
      originatingSessionId: 'ses-origin',
      triggeringAuthorId: 'U_OWNER',
      origin: { kind: 'channel' },
    })
    release2()
  })

  test('writes triggeringAuthorId into the handoff so the resumed session re-seeds the requester', async () => {
    // given: a hostd that accepts the restart
    server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({ ok: true, result: { containerName: 'coder', scheduled: true } })
      },
    })

    // when: a channel restart carries the invoker's author
    await requestContainerRestart({
      containerName: 'coder',
      hostdUrl: `http://127.0.0.1:${server.port}`,
      hostdToken: 'secret',
      ackTimeoutMs: TEST_ACK_TIMEOUT_MS,
      agentDir,
      originatingSessionId: 'ses-origin',
      originatingSessionFile: '/tmp/sessions/ses-origin.jsonl',
      handoffOrigin: { kind: 'channel', key: { adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: null } },
      triggeringAuthorId: 'U_OWNER',
      restartedAt: '2026-01-02T03:04:05.000Z',
    })

    // then: the written handoff carries the author end-to-end
    expect(JSON.parse(await readFile(restartHandoffPath(agentDir), 'utf8')).triggeringAuthorId).toBe('U_OWNER')
  })

  test('publishes a container-restarting broadcast before writing the handoff on a successful ACK', async () => {
    // given: a stream whose subscriber records broadcasts, and a hostd that
    // accepts. The broadcast must carry the originating session id so the
    // matching session's subscribeRestartNotice can append restart-self.
    server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({ ok: true, result: { containerName: 'coder', scheduled: true } })
      },
    })
    const stream = createStream()
    const received: StreamMessage[] = []
    stream.subscribe({ target: { kind: 'broadcast' } }, (msg) => received.push(msg))

    // when
    await requestContainerRestart({
      containerName: 'coder',
      hostdUrl: `http://127.0.0.1:${server.port}`,
      hostdToken: 'secret',
      ackTimeoutMs: TEST_ACK_TIMEOUT_MS,
      stream,
      agentDir,
      originatingSessionId: 'ses-origin',
      originatingSessionFile: '/tmp/sessions/ses-origin.jsonl',
      restartedAt: '2026-01-02T03:04:05.000Z',
    })

    // then
    expect(received).toHaveLength(1)
    expect(received[0]?.payload).toEqual({
      kind: 'container-restarting',
      restartedAt: '2026-01-02T03:04:05.000Z',
      originatingSessionId: 'ses-origin',
    })
  })

  test('does not publish a broadcast when hostd rejects the restart', async () => {
    // given
    server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({ ok: false, reason: 'not registered: coder' })
      },
    })
    const stream = createStream()
    const received: StreamMessage[] = []
    stream.subscribe({ target: { kind: 'broadcast' } }, (msg) => received.push(msg))

    // when
    const result = await requestContainerRestart({
      containerName: 'coder',
      hostdUrl: `http://127.0.0.1:${server.port}`,
      hostdToken: 'secret',
      ackTimeoutMs: TEST_ACK_TIMEOUT_MS,
      stream,
      originatingSessionId: 'ses-origin',
    })

    // then
    expect(result.ok).toBe(false)
    expect(received).toHaveLength(0)
  })

  test('still succeeds when the handoff write fails after hostd accepts', async () => {
    // given: hostd has accepted, but the handoff target is unwritable because a
    // regular file occupies the agent dir, so mkdir of `.typeclaw` will throw
    server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({ ok: true, result: { containerName: 'coder', scheduled: true } })
      },
    })
    const fileAsAgentDir = join(agentDir, 'not-a-dir')
    await writeFile(fileAsAgentDir, 'x', 'utf8')

    // when
    const result = await requestContainerRestart({
      containerName: 'coder',
      hostdUrl: `http://127.0.0.1:${server.port}`,
      hostdToken: 'secret',
      ackTimeoutMs: TEST_ACK_TIMEOUT_MS,
      agentDir: fileAsAgentDir,
      originatingSessionId: 'ses-origin',
      originatingSessionFile: '/tmp/sessions/ses-origin.jsonl',
      restartedAt: '2026-01-02T03:04:05.000Z',
    })

    // then: the already-committed restart is not demoted to a failure
    expect(result).toEqual({ ok: true, containerName: 'coder', restartedAt: '2026-01-02T03:04:05.000Z' })
  })

  test('fails explicitly without a hostd HTTP endpoint instead of dialing a dead socket', async () => {
    // given: no hostdUrl/token and no TYPECLAW_HOSTD_URL/TOKEN in the env
    const prevUrl = process.env.TYPECLAW_HOSTD_URL
    const prevToken = process.env.TYPECLAW_HOSTD_TOKEN
    delete process.env.TYPECLAW_HOSTD_URL
    delete process.env.TYPECLAW_HOSTD_TOKEN

    try {
      // when
      const result = await requestContainerRestart({
        containerName: 'coder',
        ackTimeoutMs: TEST_ACK_TIMEOUT_MS,
      })

      // then
      expect(result.ok).toBe(false)
      expect(result).toMatchObject({ ok: false, containerName: 'coder' })
      if (!result.ok) expect(result.reason).toContain('host daemon control endpoint unavailable')
    } finally {
      if (prevUrl !== undefined) process.env.TYPECLAW_HOSTD_URL = prevUrl
      if (prevToken !== undefined) process.env.TYPECLAW_HOSTD_TOKEN = prevToken
    }
  })

  test('forwards build:true in the RPC body', async () => {
    // given
    const requests: unknown[] = []
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        requests.push(await req.json())
        return Response.json({ ok: true, result: { containerName: 'coder', scheduled: true } })
      },
    })

    // when
    await requestContainerRestart({
      containerName: 'coder',
      build: true,
      hostdUrl: `http://127.0.0.1:${server.port}`,
      hostdToken: 'secret',
      ackTimeoutMs: TEST_ACK_TIMEOUT_MS,
    })

    // then
    expect(requests).toEqual([{ kind: 'restart', containerName: 'coder', build: true }])
  })
})
