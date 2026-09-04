import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRuntimeCapabilities } from './runtime'

// Managed restart enforcement is POSIX-mode-based; see runtime-restarter.test.ts.
const onWindows = process.platform === 'win32'

describe('createRuntimeCapabilities', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  test('provides a secrets provider when the hostd triple is present', () => {
    const caps = createRuntimeCapabilities({
      TYPECLAW_HOSTD_URL: 'http://host.docker.internal:8974',
      TYPECLAW_HOSTD_TOKEN: 'restart-token',
      TYPECLAW_CONTAINER_NAME: 'agent',
    })
    expect(caps.secrets).not.toBeNull()
    expect(caps.restarter).not.toBeNull()
    expect(caps.credentialRenewer).toBeNull()
  })

  test('degrades secrets to null when the hostd triple is absent', () => {
    const caps = createRuntimeCapabilities({})
    expect(caps.secrets).toBeNull()
    expect(caps.restarter).toBeNull()
    expect(caps.credentialRenewer).toBeNull()
  })

  test('degrades secrets to null when the triple is only partially set', () => {
    const caps = createRuntimeCapabilities({ TYPECLAW_HOSTD_URL: 'http://host.docker.internal:8974' })
    expect(caps.secrets).toBeNull()
    expect(caps.restarter).toBeNull()
  })

  test.skipIf(onWindows)('binds managed secrets and restart capabilities to writable filesystem mounts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'typeclaw-managed-caps-'))
    roots.push(root)
    const secretsPath = join(root, 'secrets.json')
    const controlDir = join(root, 'control')
    const caps = createRuntimeCapabilities(
      {
        TYPECLAW_DEPLOYMENT_PROFILE: 'managed',
        TYPECLAW_MANAGED_CONTROL_DIR: controlDir,
        TYPECLAW_RUNTIME_ID: 'agent-a',
      },
      secretsPath,
    )

    expect(caps.secrets).not.toBeNull()
    expect(caps.restarter).not.toBeNull()
    expect(caps.credentialRenewer).not.toBeNull()
    await caps.secrets?.writeBackChannelBlock({ discord: { currentAccount: 'd1', accounts: {} } })
    expect(caps.secrets?.readChannels()?.discord?.currentAccount).toBe('d1')

    const accepted = await caps.restarter?.requestRestart({ build: false })
    expect(accepted).toEqual({ ok: true })
    expect((await readdir(controlDir)).filter((name) => name.endsWith('.json'))).toHaveLength(1)
  })

  test('keeps managed restart fail-closed when the control mount is absent', async () => {
    const caps = createRuntimeCapabilities({
      TYPECLAW_DEPLOYMENT_PROFILE: 'managed',
      TYPECLAW_RUNTIME_ID: 'agent-a',
      TYPECLAW_HOSTD_URL: 'http://stale-hostd.invalid',
      TYPECLAW_HOSTD_TOKEN: 'stale-token',
      TYPECLAW_CONTAINER_NAME: 'stale-host-container',
    })

    expect(caps.secrets).not.toBeNull()
    expect(caps.restarter).not.toBeNull()
    const result = await caps.restarter?.requestRestart({ build: false })
    expect(result?.ok).toBe(false)
    if (result?.ok !== false) throw new Error('expected unavailable managed restarter')
    expect(result.reason).toContain('TYPECLAW_MANAGED_CONTROL_DIR')
  })

  test('managed MCP OAuth remains file-backed even when residual hostd variables exist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'typeclaw-managed-caps-'))
    roots.push(root)
    const secretsPath = join(root, 'secrets.json')
    const caps = createRuntimeCapabilities(
      {
        TYPECLAW_DEPLOYMENT_PROFILE: 'managed',
        TYPECLAW_RUNTIME_ID: 'agent-a',
        TYPECLAW_MANAGED_CONTROL_DIR: join(root, 'control'),
        TYPECLAW_HOSTD_URL: 'http://stale-hostd.invalid',
        TYPECLAW_HOSTD_TOKEN: 'stale-token',
        TYPECLAW_CONTAINER_NAME: 'stale-host-container',
      },
      secretsPath,
    )

    await caps.mcpOAuthStore.saveTokens('linear', { access_token: 'local-token', token_type: 'bearer' })

    const envelope = JSON.parse(await readFile(secretsPath, 'utf8')) as {
      mcp?: { linear?: { tokens?: { access_token?: string } } }
    }
    expect(envelope.mcp?.linear?.tokens?.access_token).toBe('local-token')
  })
})
