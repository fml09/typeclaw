import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createHostdRuntimeRestarter, createManagedFileRestarter } from './runtime-restarter'

describe('createHostdRuntimeRestarter', () => {
  test('preserves the established five-second ACK budget when none is injected', async () => {
    let timeoutMs: number | undefined
    const restarter = createHostdRuntimeRestarter({
      hostdUrl: 'http://host.docker.internal:8974',
      restartToken: 'token',
      containerName: 'agent-a',
      send: async (_request, options) => {
        timeoutMs = options.timeoutMs
        return { ok: true, result: { containerName: 'agent-a', scheduled: true } }
      },
    })

    await expect(restarter.requestRestart({ build: false })).resolves.toEqual({ ok: true })
    expect(timeoutMs).toBe(5_000)
  })
})

describe('createManagedFileRestarter', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  test('atomically publishes one versioned restart request and ACKs only after rename', async () => {
    const root = await mkdtemp(join(tmpdir(), 'typeclaw-managed-restart-'))
    roots.push(root)
    const restarter = createManagedFileRestarter({
      controlDir: root,
      runtimeId: 'agent-a',
      createRequestId: () => '018f47c2-8b1a-7000-8000-000000000001',
      now: () => new Date('2026-08-18T12:34:56.000Z'),
    })

    await expect(restarter.requestRestart({ build: false })).resolves.toEqual({ ok: true })

    const files = await readdir(root)
    expect(files).toEqual(['restart-018f47c2-8b1a-7000-8000-000000000001.json'])
    expect(JSON.parse(await readFile(join(root, files[0]!), 'utf8'))).toEqual({
      schemaVersion: 1,
      kind: 'restart',
      requestId: '018f47c2-8b1a-7000-8000-000000000001',
      runtimeId: 'agent-a',
      requestedAt: '2026-08-18T12:34:56.000Z',
    })
    expect((await stat(root)).mode & 0o777).toBe(0o700)
    expect((await stat(join(root, files[0]!))).mode & 0o777).toBe(0o600)
  })

  test('rejects an existing control directory with platform-unsafe permissions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'typeclaw-managed-restart-'))
    roots.push(root)
    await chmod(root, 0o755)
    const restarter = createManagedFileRestarter({ controlDir: root, runtimeId: 'agent-a' })

    const result = await restarter.requestRestart({ build: false })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected unsafe control directory rejection')
    expect(result.reason).toContain('0700')
    expect(await readdir(root)).toEqual([])
  })

  test('rejects image rebuild requests because managed image rollout is platform-owned', async () => {
    const root = await mkdtemp(join(tmpdir(), 'typeclaw-managed-restart-'))
    roots.push(root)
    const restarter = createManagedFileRestarter({ controlDir: root, runtimeId: 'agent-a' })

    const result = await restarter.requestRestart({ build: true })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected managed rebuild rejection')
    expect(result.reason).toContain('image')
    expect(await readdir(root)).toEqual([])
  })
})
