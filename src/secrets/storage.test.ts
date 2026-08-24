import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AuthStorage } from '@mariozechner/pi-coding-agent'

import { isWindows } from '@/shared'

import { parseSecretsFile } from './schema'
import { createSecretsStoreForAgent, SecretsBackend } from './storage'

const onWindows = isWindows()

describe('SecretsBackend', () => {
  let dir: string
  let secretsPath: string
  let prevFireworks: string | undefined

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'typeclaw-secrets-store-'))
    secretsPath = join(dir, 'secrets.json')
    // These tests exercise on-disk persistence via AuthStorage.get, which
    // resolves api-keys with env-wins. CI sets FIREWORKS_API_KEY=dummy
    // workflow-wide; scrub it so the disk value is what comes back.
    prevFireworks = process.env.FIREWORKS_API_KEY
    delete process.env.FIREWORKS_API_KEY
  })

  afterEach(async () => {
    if (prevFireworks === undefined) delete process.env.FIREWORKS_API_KEY
    else process.env.FIREWORKS_API_KEY = prevFireworks
    await rm(dir, { recursive: true, force: true })
  })

  test('first write produces a v2 envelope with Secret-wrapped api-key', async () => {
    const store = createSecretsStoreForAgent(secretsPath)
    store.set('openai', { type: 'api_key', key: 'sk-test' })

    const raw = await readFile(secretsPath, 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    expect(parsed['version']).toBe(2)
    expect(parsed['providers']).toEqual({ openai: { type: 'api_key', key: { value: 'sk-test' } } })
    expect(parsed['channels']).toEqual({})
    expect(parsed['mcp']).toEqual({})
    expect(parsed['$schema']).toBe('./node_modules/typeclaw/secrets.schema.json')
  })

  test('round-trip: set + reload + get returns the same value', () => {
    const a = createSecretsStoreForAgent(secretsPath)
    a.set('openai', { type: 'api_key', key: 'sk-roundtrip' })

    const b = createSecretsStoreForAgent(secretsPath)
    expect(b.get('openai')).toEqual({ type: 'api_key', key: 'sk-roundtrip' })

    b.set('openai', { type: 'api_key', key: 'sk-updated' })

    const c = AuthStorage.fromStorage(new SecretsBackend(secretsPath))
    expect(c.get('openai')).toEqual({ type: 'api_key', key: 'sk-updated' })
  })

  test('preserves channels and unknown top-level keys across writes', async () => {
    await writeFile(
      secretsPath,
      JSON.stringify({
        version: 2,
        providers: { openai: { type: 'api_key', key: { value: 'sk-existing' } } },
        channels: { 'discord-bot': { token: { value: 'd-keep' } } },
        githubCli: { hosts: 'generated-store' },
        futureSlice: { keep: true },
      }),
    )

    const store = createSecretsStoreForAgent(secretsPath)
    store.set('fireworks', { type: 'api_key', key: 'fw-added' })

    const raw = await readFile(secretsPath, 'utf8')
    const obj = JSON.parse(raw) as {
      version: number
      providers: Record<string, unknown>
      channels: Record<string, unknown>
      githubCli: unknown
      futureSlice: unknown
    }
    expect(obj.version).toBe(2)
    expect(obj.providers['openai']).toEqual({ type: 'api_key', key: { value: 'sk-existing' } })
    expect(obj.providers['fireworks']).toEqual({ type: 'api_key', key: { value: 'fw-added' } })
    expect(obj.channels['discord-bot']).toEqual({ token: { value: 'd-keep' } })
    expect(obj.githubCli).toEqual({ hosts: 'generated-store' })
    expect(obj.futureSlice).toEqual({ keep: true })
  })

  test('locked GitHub CLI reads and writes preserve every sibling and unknown slice', async () => {
    await writeFile(
      secretsPath,
      JSON.stringify({
        version: 2,
        providers: { openai: { type: 'api_key', key: { value: 'provider-test' } } },
        channels: { 'discord-bot': { token: { value: 'channel-test' } } },
        mcp: { example: { tokens: { access_token: 'mcp-test' } } },
        futureSlice: { keep: true },
      }),
    )
    const backend = new SecretsBackend(secretsPath)

    expect(backend.tryReadGithubCliSync()).toBeUndefined()
    backend.writeGithubCliSync({ hosts: 'first-store' })
    backend.writeGithubCliSync({ hosts: 'refreshed-store' })

    expect(backend.tryReadGithubCliSync()).toEqual({ hosts: 'refreshed-store' })
    const raw = JSON.parse(await readFile(secretsPath, 'utf8')) as Record<string, unknown>
    expect(raw['providers']).toEqual({ openai: { type: 'api_key', key: { value: 'provider-test' } } })
    expect(raw['channels']).toEqual({ 'discord-bot': { token: { value: 'channel-test' } } })
    expect(raw['mcp']).toEqual({ example: { tokens: { access_token: 'mcp-test' } } })
    expect(raw['futureSlice']).toEqual({ keep: true })
  })

  test('file mode is 0o600 after first write', async () => {
    const store = createSecretsStoreForAgent(secretsPath)
    store.set('openai', { type: 'api_key', key: 'sk-test' })

    const stats = await stat(secretsPath)
    const perms = stats.mode & 0o777
    // NTFS mode bits are not meaningful on Windows; see #899.
    if (!onWindows) expect(perms).toBe(0o600)
  })

  test('seed file is parseable as v2 envelope before any credential is written', async () => {
    createSecretsStoreForAgent(secretsPath)

    const raw = await readFile(secretsPath, 'utf8')
    const result = parseSecretsFile(JSON.parse(raw))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.file.version).toBe(2)
    expect(result.file.providers).toEqual({})
    expect(result.file.channels).toEqual({})
    expect(result.file.mcp).toEqual({})
  })

  test('surfaces a parse error via drainErrors when the file is unparseable', async () => {
    await writeFile(secretsPath, JSON.stringify({ random: 'garbage', notACredential: 42 }))

    const store = createSecretsStoreForAgent(secretsPath)
    const errors = store.drainErrors()
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0]?.message).toMatch(/secrets file is not a valid TypeClaw secrets file/)
  })

  test('surfaces a parse error via drainErrors when the file is not valid JSON', async () => {
    await writeFile(secretsPath, '{ not json')

    const store = createSecretsStoreForAgent(secretsPath)
    const errors = store.drainErrors()
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0]?.message).toMatch(/secrets file is not valid JSON/)
  })

  test('two store instances writing concurrently both land their changes', async () => {
    const a = createSecretsStoreForAgent(secretsPath)
    const b = createSecretsStoreForAgent(secretsPath)

    a.set('openai', { type: 'api_key', key: 'sk-a' })
    b.set('fireworks', { type: 'api_key', key: 'fw-b' })

    const fresh = createSecretsStoreForAgent(secretsPath)
    expect(fresh.get('openai')).toEqual({ type: 'api_key', key: 'sk-a' })
    expect(fresh.get('fireworks')).toEqual({ type: 'api_key', key: 'fw-b' })
  })

  test('mutation check: bypassing the wrap (AuthStorage.create directly) breaks the envelope shape', async () => {
    const store = createSecretsStoreForAgent(secretsPath)
    store.set('openai', { type: 'api_key', key: 'sk-mutation' })

    const raw = await readFile(secretsPath, 'utf8')
    const obj = JSON.parse(raw) as Record<string, unknown>

    expect(obj['version']).toBe(2)
    expect(obj['providers']).toBeDefined()
    expect(obj['channels']).toBeDefined()
    expect(obj['openai']).toBeUndefined()
  })

  describe('mcp credentials', () => {
    async function readEnvelope(): Promise<{
      providers: Record<string, unknown>
      channels: Record<string, unknown>
      mcp: Record<string, unknown>
    }> {
      return JSON.parse(await readFile(secretsPath, 'utf8')) as {
        providers: Record<string, unknown>
        channels: Record<string, unknown>
        mcp: Record<string, unknown>
      }
    }

    test('read/write/update/remove preserves sibling MCP servers and other slices', async () => {
      await writeFile(
        secretsPath,
        JSON.stringify({
          version: 2,
          providers: { openai: { type: 'api_key', key: { value: 'sk-existing' } } },
          channels: { 'discord-bot': { token: { value: 'discord-test' } } },
          mcp: { existing: { client: { client_id: 'existing-client' } } },
        }),
      )
      const backend = new SecretsBackend(secretsPath)

      backend.writeMcpCredentialSync('linear', {
        client: { client_id: 'test-client' },
        tokens: { access_token: 'access-test', refresh_token: 'refresh-test' },
      })
      await backend.updateMcpAsync(async (mcp) => ({
        result: undefined,
        next: {
          ...mcp,
          linear: {
            ...mcp.linear,
            tokens: { access_token: 'access-rotated', refresh_token: 'refresh-rotated' },
          },
        },
      }))

      expect(backend.tryReadMcpSync().existing).toEqual({ client: { client_id: 'existing-client' } })
      expect(backend.readMcpCredentialSync('linear')).toEqual({
        client: { client_id: 'test-client' },
        tokens: { access_token: 'access-rotated', refresh_token: 'refresh-rotated' },
      })
      const envelope = await readEnvelope()
      expect(envelope.providers.openai).toEqual({ type: 'api_key', key: { value: 'sk-existing' } })
      expect(envelope.channels['discord-bot']).toEqual({ token: { value: 'discord-test' } })
      expect(envelope.mcp.existing).toEqual({ client: { client_id: 'existing-client' } })
      expect(envelope.mcp.linear).toEqual({
        client: { client_id: 'test-client' },
        tokens: { access_token: 'access-rotated', refresh_token: 'refresh-rotated' },
      })

      expect(backend.removeMcpCredentialSync('linear')).toBe(true)
      expect(backend.removeMcpCredentialSync('missing')).toBe(false)
      expect(backend.tryReadMcpSync()).toEqual({ existing: { client: { client_id: 'existing-client' } } })
    })
  })
})

describe('SecretsBackend idempotency (Oracle bridge rule)', () => {
  let dir: string
  let secretsPath: string
  let prevEnv: Record<string, string | undefined>

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'typeclaw-secrets-idempotent-'))
    secretsPath = join(dir, 'secrets.json')
    prevEnv = {
      FIREWORKS_API_KEY: process.env.FIREWORKS_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    }
    delete process.env.FIREWORKS_API_KEY
    delete process.env.OPENAI_API_KEY
  })

  afterEach(async () => {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await rm(dir, { recursive: true, force: true })
  })

  test('OAuth-only write preserves untouched api-key Secret with env field verbatim', async () => {
    await writeFile(
      secretsPath,
      JSON.stringify({
        version: 2,
        providers: {
          fireworks: { type: 'api_key', key: { value: 'fw_disk', env: 'FIREWORKS_API_KEY' } },
          'openai-codex': { type: 'oauth', access: 'a-old', refresh: 'r', expires: 1 },
        },
      }),
    )
    process.env.FIREWORKS_API_KEY = 'fw_from_env'

    const store = createSecretsStoreForAgent(secretsPath)
    // OAuth-style mutation: AuthStorage rewrites the full slice
    store.set('openai-codex', { type: 'oauth', access: 'a-refreshed', refresh: 'r', expires: 2 })

    const raw = await readFile(secretsPath, 'utf8')
    const obj = JSON.parse(raw) as { providers: Record<string, unknown> }

    expect(obj.providers['fireworks']).toEqual({
      type: 'api_key',
      key: { value: 'fw_disk', env: 'FIREWORKS_API_KEY' },
    })
    expect(obj.providers['openai-codex']).toEqual({
      type: 'oauth',
      access: 'a-refreshed',
      refresh: 'r',
      expires: 2,
    })
  })

  test('api-key value change preserves the env field across the write', async () => {
    await writeFile(
      secretsPath,
      JSON.stringify({
        version: 2,
        providers: {
          fireworks: { type: 'api_key', key: { value: 'fw_old', env: 'CUSTOM_FW' } },
        },
      }),
    )

    const store = createSecretsStoreForAgent(secretsPath)
    store.set('fireworks', { type: 'api_key', key: 'fw_new' })

    const raw = await readFile(secretsPath, 'utf8')
    const obj = JSON.parse(raw) as { providers: Record<string, unknown> }
    expect(obj.providers['fireworks']).toEqual({
      type: 'api_key',
      key: { value: 'fw_new', env: 'CUSTOM_FW' },
    })
  })

  test('env-resolved api-key value is NOT persisted to disk on unrelated OAuth refresh', async () => {
    await writeFile(
      secretsPath,
      JSON.stringify({
        version: 2,
        providers: {
          fireworks: { type: 'api_key', key: { value: 'fw_disk' } },
          'openai-codex': { type: 'oauth', access: 'a', refresh: 'r', expires: 1 },
        },
      }),
    )
    process.env.FIREWORKS_API_KEY = 'fw_env_only'

    const store = createSecretsStoreForAgent(secretsPath)
    store.set('openai-codex', { type: 'oauth', access: 'a-refreshed', refresh: 'r', expires: 2 })

    const raw = await readFile(secretsPath, 'utf8')
    const obj = JSON.parse(raw) as { providers: Record<string, { type: string; key?: unknown }> }
    expect(obj.providers['fireworks']?.key).toEqual({ value: 'fw_disk' })
  })

  test('removed provider is actually removed (not resurrected)', async () => {
    const store = createSecretsStoreForAgent(secretsPath)
    store.set('openai', { type: 'api_key', key: 'sk-1' })
    store.set('fireworks', { type: 'api_key', key: 'fw-1' })
    store.remove('openai')

    const raw = await readFile(secretsPath, 'utf8')
    const obj = JSON.parse(raw) as { providers: Record<string, unknown> }
    expect(obj.providers['openai']).toBeUndefined()
    expect(obj.providers['fireworks']).toBeDefined()
  })

  test('newly added provider gets the string-value Secret shape with no env binding', async () => {
    const store = createSecretsStoreForAgent(secretsPath)
    store.set('openai', { type: 'api_key', key: 'sk-fresh' })

    const raw = await readFile(secretsPath, 'utf8')
    const obj = JSON.parse(raw) as { providers: Record<string, { key: { value?: string; env?: string } }> }
    expect(obj.providers['openai']?.key).toEqual({ value: 'sk-fresh' })
  })

  test('env-wins on read: AuthStorage.get returns env value when api-key env var is set', async () => {
    await writeFile(
      secretsPath,
      JSON.stringify({
        version: 2,
        providers: { fireworks: { type: 'api_key', key: { value: 'fw_disk' } } },
      }),
    )
    process.env.FIREWORKS_API_KEY = 'fw_env'

    const store = createSecretsStoreForAgent(secretsPath)
    expect(store.get('fireworks')).toEqual({ type: 'api_key', key: 'fw_env' })
  })

  test('env-snapshot: env mutation between read and write does NOT clobber on-disk value', async () => {
    // Regression: env var is set at read time (AuthStorage sees fw_from_env
    // for fireworks), removed before an unrelated OAuth-refresh write. The
    // idempotency check must use the read-time snapshot, not re-resolve
    // against current env — otherwise fireworks is misclassified as mutated
    // and fw_disk is overwritten with fw_from_env.
    await writeFile(
      secretsPath,
      JSON.stringify({
        version: 2,
        providers: {
          fireworks: { type: 'api_key', key: { value: 'fw_disk' } },
          'openai-codex': { type: 'oauth', access: 'a-old', refresh: 'r', expires: 1 },
        },
      }),
    )
    process.env.FIREWORKS_API_KEY = 'fw_from_env'

    const store = createSecretsStoreForAgent(secretsPath)
    delete process.env.FIREWORKS_API_KEY
    store.set('openai-codex', { type: 'oauth', access: 'a-refreshed', refresh: 'r', expires: 2 })

    const raw = await readFile(secretsPath, 'utf8')
    const obj = JSON.parse(raw) as { providers: Record<string, { type: string; key?: unknown }> }
    expect(obj.providers['fireworks']?.key).toEqual({ value: 'fw_disk' })
  })

  test('empty key from AuthStorage on api-key preserves prior on-disk Secret', async () => {
    // AuthStorage handing back `{ type: 'api_key', key: '' }` would, if
    // written verbatim, produce `{ value: '' }` on disk — which fails the
    // schema's `min(1)` constraint at next read and locks the user out of
    // their secrets file. The bridge treats empty `key` as a no-op and
    // preserves the prior on-disk Secret if any.
    await writeFile(
      secretsPath,
      JSON.stringify({
        version: 2,
        providers: { fireworks: { type: 'api_key', key: { value: 'fw_disk' } } },
      }),
    )

    const store = createSecretsStoreForAgent(secretsPath)
    store.set('fireworks', { type: 'api_key', key: '' })

    const raw = await readFile(secretsPath, 'utf8')
    const obj = JSON.parse(raw) as { providers: Record<string, { key: { value?: string; env?: string } }> }
    expect(obj.providers['fireworks']?.key).toEqual({ value: 'fw_disk' })

    // Round-trip: re-opening must succeed (file is still parseable).
    const fresh = createSecretsStoreForAgent(secretsPath)
    expect(fresh.get('fireworks')).toEqual({ type: 'api_key', key: 'fw_disk' })
  })

  test('empty key from AuthStorage on a new provider is dropped (not written as { value: "" })', async () => {
    const store = createSecretsStoreForAgent(secretsPath)
    store.set('fireworks', { type: 'api_key', key: '' })

    const raw = await readFile(secretsPath, 'utf8')
    const obj = JSON.parse(raw) as { providers: Record<string, unknown> }
    expect(obj.providers['fireworks']).toBeUndefined()
  })

  describe('removeChannelSync', () => {
    async function seedChannels(channels: Record<string, unknown>): Promise<void> {
      await writeFile(
        secretsPath,
        `${JSON.stringify({ $schema: './node_modules/typeclaw/secrets.schema.json', version: 2, providers: {}, channels }, null, 2)}\n`,
      )
    }

    test('removes a present channel and leaves siblings intact', async () => {
      await seedChannels({ 'discord-bot': { token: { value: 't' } }, 'telegram-bot': { token: { value: 'u' } } })
      const backend = new SecretsBackend(secretsPath)

      expect(backend.removeChannelSync('discord-bot')).toBe(true)
      expect(backend.readChannelsSync()).toEqual({ 'telegram-bot': { token: { value: 'u' } } })
    })

    test('returns false when the channel is absent and does not rewrite', async () => {
      await seedChannels({ 'discord-bot': { token: { value: 't' } } })
      const backend = new SecretsBackend(secretsPath)

      expect(backend.removeChannelSync('slack-bot')).toBe(false)
      expect(backend.readChannelsSync()).toEqual({ 'discord-bot': { token: { value: 't' } } })
    })

    test('returns false when secrets.json does not exist', () => {
      const backend = new SecretsBackend(join(dir, 'missing.json'))
      expect(backend.removeChannelSync('discord-bot')).toBe(false)
    })
  })
})
