import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import {
  type AuthStorage,
  type AuthStorageBackend,
  AuthStorage as AuthStorageImpl,
} from '@mariozechner/pi-coding-agent'
import lockfile from 'proper-lockfile'

import { providerKeyDefaultEnv } from './defaults'
import { registerXaiOAuthProvider } from './oauth-xai'
import { resolveSecret, type Secret } from './resolve'
import {
  type Channels,
  type GithubCliSecrets,
  type McpCredential,
  type McpSlice,
  type ProviderCredential,
  type Providers,
  type SecretsFile,
  SECRETS_FILE_VERSION,
  parseSecretsFile,
} from './schema'

const SCHEMA_REL = './node_modules/typeclaw/secrets.schema.json'
const FILE_MODE = 0o600
const DIR_MODE = 0o700

const SYNC_LOCK_RETRIES = 10
const SYNC_LOCK_DELAY_MS = 20

const ASYNC_LOCK_OPTIONS = {
  retries: { retries: 10, factor: 2, minTimeout: 100, maxTimeout: 10000, randomize: true },
  stale: 30000,
} as const

// SecretsBackend bridges TypeClaw's on-disk envelope (v2: providers with
// Secret-typed keys, channels with per-adapter field shapes) to upstream
// `AuthStorage`'s flat `Record<provider, AuthCredential>` contract.
//
// READ (withLock's `current` parameter):
//   - Parse the envelope, walk `providers`, resolve each api-key `Secret` to
//     a flat string via env-wins (process.env wins over file value).
//   - OAuth credentials pass through untouched.
//   - Capture the resolved string for each provider into `readSnapshot` so
//     the write path can detect "unchanged" without re-resolving (the env
//     can change between read and write, and re-resolving would misclassify
//     env mutations as credential mutations).
//   - Hand AuthStorage a flat-shape JSON string. Upstream is none the wiser.
//
// WRITE (the `next` field):
//   - AuthStorage hands back the full flat slice as JSON. We do NOT
//     wholesale-replace the on-disk `providers` slice with this.
//   - Instead, we DIFF at credential level against the prior envelope using
//     the read-time `readSnapshot`:
//       * Provider unchanged (flatKey === readSnapshot[providerId]) → preserve
//         on-disk Secret bytes verbatim (no flatten, no rewrap). This is the
//         idempotency rule that prevents OAuth-refresh from accidentally
//         persisting env-resolved api-key values into the file.
//       * Provider changed → rewrap as Secret, preserving any prior `env`
//         field the user authored.
//       * Provider added → write as string shorthand (no env binding).
//       * Provider removed → actually remove (do NOT resurrect).
//   - OAuth credentials stay flat strings in the envelope (no Secret
//     wrapping) — they're not env-injectable.
//   - Unknown credential `type` values pass through verbatim, in case
//     upstream adds a third type in a future release.
//   - Empty/missing `key` from AuthStorage on api-key is treated as no-op
//     (preserve prior on-disk Secret if any). The schema requires non-empty
//     `value`, so writing an empty key would corrupt the file at next read.
//
// Locking and durability mirror upstream's FileAuthStorageBackend: sync
// busy-loop retry on ELOCKED to keep callers synchronous, 0o600 file, 0o700
// parent, atomic temp+rename.
export class SecretsBackend implements AuthStorageBackend {
  constructor(private readonly secretsPath: string) {}

  withLock<T>(fn: (current: string | undefined) => { result: T; next?: string }): T {
    this.ensureParentDir()
    this.ensureFileExists()
    let release: (() => void) | undefined
    try {
      release = this.acquireSyncLockWithRetry()
      const envelope = this.readEnvelope()
      const { flatJson, readSnapshot } = flattenProvidersForAuthStorage(envelope.providers, process.env)

      const { result, next } = fn(flatJson)
      if (next !== undefined) {
        const merged = mergeProvidersIntoEnvelope(envelope, next, readSnapshot)
        this.writeEnvelopeAtomic(merged)
      }
      return result
    } finally {
      release?.()
    }
  }

  async withLockAsync<T>(fn: (current: string | undefined) => Promise<{ result: T; next?: string }>): Promise<T> {
    this.ensureParentDir()
    this.ensureFileExists()
    let release: (() => Promise<void>) | undefined
    let lockCompromised = false
    let lockCompromisedError: Error | undefined
    const throwIfCompromised = (): void => {
      if (lockCompromised) {
        throw lockCompromisedError ?? new Error('Secrets store lock was compromised')
      }
    }
    try {
      release = await lockfile.lock(this.secretsPath, {
        ...ASYNC_LOCK_OPTIONS,
        onCompromised: (err: Error) => {
          lockCompromised = true
          lockCompromisedError = err
        },
      })
      throwIfCompromised()
      const envelope = this.readEnvelope()
      const { flatJson, readSnapshot } = flattenProvidersForAuthStorage(envelope.providers, process.env)

      const { result, next } = await fn(flatJson)
      throwIfCompromised()
      if (next !== undefined) {
        const merged = mergeProvidersIntoEnvelope(envelope, next, readSnapshot)
        this.writeEnvelopeAtomic(merged)
      }
      throwIfCompromised()
      return result
    } finally {
      if (release) {
        try {
          await release()
        } catch {
          // Ignore unlock errors when the lock is compromised — there is
          // nothing useful we can do, and surfacing the secondary error would
          // mask the primary failure (mirrors upstream behaviour).
        }
      }
    }
  }

  readChannelsSync(): Channels {
    this.ensureParentDir()
    this.ensureFileExists()
    let release: (() => void) | undefined
    try {
      release = this.acquireSyncLockWithRetry()
      return this.readEnvelope().channels
    } finally {
      release?.()
    }
  }

  tryReadChannelsSync(): Channels | null {
    if (!existsSync(this.secretsPath)) return null
    let release: (() => void) | undefined
    try {
      release = this.acquireSyncLockWithRetry()
      return this.readEnvelope().channels
    } finally {
      release?.()
    }
  }

  tryReadProviderApiKeySync(providerId: string, env: NodeJS.ProcessEnv = process.env): string | null {
    if (!existsSync(this.secretsPath)) return null
    let release: (() => void) | undefined
    try {
      release = this.acquireSyncLockWithRetry()
      const credential = this.readEnvelope().providers[providerId]
      if (credential?.type !== 'api_key') return null
      const resolved =
        resolveSecret(credential.key, providerKeyDefaultEnv(providerId), env) ?? credential.key.value ?? ''
      return resolved.trim() !== '' ? resolved : null
    } finally {
      release?.()
    }
  }

  // Returns a shallow snapshot of the `providers` slice. Used by post-init CLI
  // commands (`typeclaw provider list/remove`, `typeclaw model list`) that need
  // to inspect what's on disk without forcing AuthStorage's env-wins flatten —
  // we want to show users which providers are file-backed vs env-overridden,
  // and the flatten path collapses that distinction.
  tryReadProvidersSync(): Providers {
    if (!existsSync(this.secretsPath)) return {}
    let release: (() => void) | undefined
    try {
      release = this.acquireSyncLockWithRetry()
      return { ...this.readEnvelope().providers }
    } finally {
      release?.()
    }
  }

  tryReadMcpSync(): McpSlice {
    if (!existsSync(this.secretsPath)) return {}
    let release: (() => void) | undefined
    try {
      release = this.acquireSyncLockWithRetry()
      return { ...this.readEnvelope().mcp }
    } finally {
      release?.()
    }
  }

  tryReadGithubCliSync(): GithubCliSecrets | undefined {
    if (!existsSync(this.secretsPath)) return undefined
    let release: (() => void) | undefined
    try {
      release = this.acquireSyncLockWithRetry()
      return this.readEnvelope().githubCli
    } finally {
      release?.()
    }
  }

  writeGithubCliSync(githubCli: GithubCliSecrets): void {
    this.ensureParentDir()
    this.ensureFileExists()
    let release: (() => void) | undefined
    try {
      release = this.acquireSyncLockWithRetry()
      const envelope = this.readEnvelope()
      this.writeEnvelopeAtomic({
        ...envelope,
        $schema: envelope.$schema ?? SCHEMA_REL,
        version: SECRETS_FILE_VERSION,
        githubCli,
      })
    } finally {
      release?.()
    }
  }

  readMcpCredentialSync(serverName: string): McpCredential | undefined {
    if (!existsSync(this.secretsPath)) return undefined
    let release: (() => void) | undefined
    try {
      release = this.acquireSyncLockWithRetry()
      return this.readEnvelope().mcp[serverName]
    } finally {
      release?.()
    }
  }

  writeMcpCredentialSync(serverName: string, credential: McpCredential): void {
    this.ensureParentDir()
    this.ensureFileExists()
    let release: (() => void) | undefined
    try {
      release = this.acquireSyncLockWithRetry()
      const envelope = this.readEnvelope()
      const next: SecretsFile = {
        ...envelope,
        $schema: envelope.$schema ?? SCHEMA_REL,
        version: SECRETS_FILE_VERSION,
        mcp: { ...envelope.mcp, [serverName]: credential },
      }
      this.writeEnvelopeAtomic(next)
    } finally {
      release?.()
    }
  }

  async updateMcpAsync<T>(fn: (current: McpSlice) => Promise<{ result: T; next?: McpSlice }>): Promise<T> {
    this.ensureParentDir()
    this.ensureFileExists()
    let release: (() => Promise<void>) | undefined
    let lockCompromised = false
    let lockCompromisedError: Error | undefined
    const throwIfCompromised = (): void => {
      if (lockCompromised) {
        throw lockCompromisedError ?? new Error('Secrets store lock was compromised')
      }
    }
    try {
      release = await lockfile.lock(this.secretsPath, {
        ...ASYNC_LOCK_OPTIONS,
        onCompromised: (err: Error) => {
          lockCompromised = true
          lockCompromisedError = err
        },
      })
      throwIfCompromised()
      const envelope = this.readEnvelope()
      const { result, next } = await fn(envelope.mcp)
      throwIfCompromised()
      if (next !== undefined) {
        const merged: SecretsFile = {
          ...envelope,
          $schema: envelope.$schema ?? SCHEMA_REL,
          version: SECRETS_FILE_VERSION,
          mcp: next,
        }
        this.writeEnvelopeAtomic(merged)
      }
      throwIfCompromised()
      return result
    } finally {
      if (release) {
        try {
          await release()
        } catch {}
      }
    }
  }

  removeMcpCredentialSync(serverName: string): boolean {
    if (!existsSync(this.secretsPath)) return false
    let release: (() => void) | undefined
    try {
      release = this.acquireSyncLockWithRetry()
      const envelope = this.readEnvelope()
      if (!(serverName in envelope.mcp)) return false
      const { [serverName]: _removed, ...rest } = envelope.mcp
      const next: SecretsFile = {
        ...envelope,
        $schema: envelope.$schema ?? SCHEMA_REL,
        version: SECRETS_FILE_VERSION,
        mcp: rest,
      }
      this.writeEnvelopeAtomic(next)
      return true
    } finally {
      release?.()
    }
  }

  // Atomic provider credential write. Idempotent at the type level: callers
  // pass the full `ProviderCredential` (api_key or oauth), and the entry is
  // merged into `providers.<id>` verbatim — same shape the schema accepts on
  // read. Used by `typeclaw provider add/set` to write api-key credentials
  // without going through AuthStorage's flatten/unflatten round-trip.
  // OAuth flows MUST continue to go through `AuthStorage.login()` so refresh
  // tokens land in the correct shape; this method is api-key oriented.
  writeProviderCredentialSync(providerId: string, credential: ProviderCredential): void {
    this.ensureParentDir()
    this.ensureFileExists()
    let release: (() => void) | undefined
    try {
      release = this.acquireSyncLockWithRetry()
      const envelope = this.readEnvelope()
      const next: SecretsFile = {
        ...envelope,
        $schema: envelope.$schema ?? SCHEMA_REL,
        version: SECRETS_FILE_VERSION,
        providers: { ...envelope.providers, [providerId]: credential },
      }
      this.writeEnvelopeAtomic(next)
    } finally {
      release?.()
    }
  }

  // Removes `providers.<id>` from the envelope. Returns `true` when the
  // provider was present and removed, `false` when nothing changed (idempotent
  // on the CLI side — `provider remove fireworks` twice should not error on
  // the second call). The file is rewritten only when something changed so
  // canonical-shape reads pay zero cost.
  removeProviderCredentialSync(providerId: string): boolean {
    if (!existsSync(this.secretsPath)) return false
    let release: (() => void) | undefined
    try {
      release = this.acquireSyncLockWithRetry()
      const envelope = this.readEnvelope()
      if (!(providerId in envelope.providers)) return false
      const { [providerId]: _removed, ...rest } = envelope.providers
      const next: SecretsFile = {
        ...envelope,
        $schema: envelope.$schema ?? SCHEMA_REL,
        version: SECRETS_FILE_VERSION,
        providers: rest,
      }
      this.writeEnvelopeAtomic(next)
      return true
    } finally {
      release?.()
    }
  }

  // Removes `channels.<kind>` from the envelope. Returns `true` when the
  // adapter slot was present and removed, `false` when nothing changed
  // (idempotent on the CLI side — `channel remove discord-bot` twice should
  // not error on the second call). Mirrors `removeProviderCredentialSync`:
  // rewrites the file only when something changed so canonical-shape reads
  // pay zero cost.
  removeChannelSync(kind: string): boolean {
    if (!existsSync(this.secretsPath)) return false
    let release: (() => void) | undefined
    try {
      release = this.acquireSyncLockWithRetry()
      const envelope = this.readEnvelope()
      if (!(kind in envelope.channels)) return false
      const { [kind]: _removed, ...rest } = envelope.channels
      const next: SecretsFile = {
        ...envelope,
        $schema: envelope.$schema ?? SCHEMA_REL,
        version: SECRETS_FILE_VERSION,
        channels: rest,
      }
      this.writeEnvelopeAtomic(next)
      return true
    } finally {
      release?.()
    }
  }

  writeChannelsSync(next: Channels): void {
    this.ensureParentDir()
    this.ensureFileExists()
    let release: (() => void) | undefined
    try {
      release = this.acquireSyncLockWithRetry()
      const envelope = this.readEnvelope()
      const merged: SecretsFile = {
        ...envelope,
        $schema: envelope.$schema ?? SCHEMA_REL,
        version: SECRETS_FILE_VERSION,
        channels: next,
      }
      this.writeEnvelopeAtomic(merged)
    } finally {
      release?.()
    }
  }

  async updateChannelsAsync<T>(
    fn: (current: Record<string, unknown>) => Promise<{ result: T; next?: Record<string, unknown> }>,
  ): Promise<T> {
    this.ensureParentDir()
    this.ensureFileExists()
    let release: (() => Promise<void>) | undefined
    let lockCompromised = false
    let lockCompromisedError: Error | undefined
    const throwIfCompromised = (): void => {
      if (lockCompromised) {
        throw lockCompromisedError ?? new Error('Secrets store lock was compromised')
      }
    }
    try {
      release = await lockfile.lock(this.secretsPath, {
        ...ASYNC_LOCK_OPTIONS,
        onCompromised: (err: Error) => {
          lockCompromised = true
          lockCompromisedError = err
        },
      })
      throwIfCompromised()
      const envelope = this.readEnvelope()
      const { result, next } = await fn(envelope.channels as Record<string, unknown>)
      throwIfCompromised()
      if (next !== undefined) {
        const merged: SecretsFile = {
          ...envelope,
          $schema: envelope.$schema ?? SCHEMA_REL,
          channels: next as SecretsFile['channels'],
        }
        this.writeEnvelopeAtomic(merged)
      }
      throwIfCompromised()
      return result
    } finally {
      if (release) {
        try {
          await release()
        } catch {}
      }
    }
  }

  private ensureParentDir(): void {
    const dir = dirname(this.secretsPath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: DIR_MODE })
    }
  }

  private ensureFileExists(): void {
    if (existsSync(this.secretsPath)) return
    const seed = newEmptyEnvelope()
    writeFileSync(this.secretsPath, stringifyEnvelope(seed), 'utf8')
    chmodSync(this.secretsPath, FILE_MODE)
  }

  private acquireSyncLockWithRetry(): () => void {
    let lastError: unknown
    for (let attempt = 1; attempt <= SYNC_LOCK_RETRIES; attempt++) {
      try {
        return lockfile.lockSync(this.secretsPath, { realpath: false })
      } catch (error) {
        const code =
          typeof error === 'object' && error !== null && 'code' in error
            ? String((error as { code: unknown }).code)
            : undefined
        if (code !== 'ELOCKED' || attempt === SYNC_LOCK_RETRIES) throw error
        lastError = error
        const start = Date.now()
        while (Date.now() - start < SYNC_LOCK_DELAY_MS) {
          // intentionally empty: synchronous busy-wait to match upstream contract
        }
      }
    }
    throw (lastError as Error | undefined) ?? new Error('Failed to acquire secrets store lock')
  }

  private readEnvelope(): SecretsFile {
    const raw = existsSync(this.secretsPath) ? readFileSync(this.secretsPath, 'utf8') : ''
    if (!raw.trim()) return newEmptyEnvelope()
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      throw new Error(`secrets file is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
    }
    const result = parseSecretsFile(parsed)
    if (!result.ok) {
      throw new Error(`secrets file is not a valid TypeClaw secrets file: ${result.reason}`)
    }
    return result.file
  }

  private writeEnvelopeAtomic(envelope: SecretsFile): void {
    const tmp = `${this.secretsPath}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(tmp, stringifyEnvelope(envelope), { encoding: 'utf8', mode: FILE_MODE })
    try {
      renameSync(tmp, this.secretsPath)
    } catch (err) {
      try {
        unlinkSync(tmp)
      } catch {
        // best-effort cleanup of the temp file when rename fails
      }
      throw err
    }
    chmodSync(this.secretsPath, FILE_MODE)
  }
}

export function createSecretsStoreForAgent(secretsPath: string): AuthStorage {
  registerXaiOAuthProvider()
  return AuthStorageImpl.fromStorage(new SecretsBackend(secretsPath))
}

function newEmptyEnvelope(): SecretsFile {
  return { $schema: SCHEMA_REL, version: SECRETS_FILE_VERSION, providers: {}, channels: {}, mcp: {} }
}

function stringifyEnvelope(envelope: SecretsFile): string {
  return `${JSON.stringify(envelope, null, 2)}\n`
}

type ReadSnapshot = Map<string, string>

// Build the flat shape AuthStorage expects, resolving Secret-typed api-key
// keys to plain strings on the way out. Also capture each resolved api-key
// value into a snapshot keyed by providerId; the write path uses this
// snapshot (NOT a re-resolution against current process.env) to detect
// untouched providers. OAuth and unknown types are passed through verbatim
// and never enter the snapshot — they don't participate in env-wins.
function flattenProvidersForAuthStorage(
  providers: Providers,
  env: NodeJS.ProcessEnv,
): { flatJson: string; readSnapshot: ReadSnapshot } {
  const flat: Record<string, unknown> = {}
  const readSnapshot: ReadSnapshot = new Map()
  for (const [providerId, cred] of Object.entries(providers)) {
    if (cred.type === 'api_key') {
      const defaultEnv = providerKeyDefaultEnv(providerId)
      const resolved = resolveSecret(cred.key, defaultEnv, env) ?? cred.key.value ?? ''
      flat[providerId] = { type: 'api_key', key: resolved }
      readSnapshot.set(providerId, resolved)
    } else {
      flat[providerId] = cred
    }
  }
  return { flatJson: JSON.stringify(flat, null, 2), readSnapshot }
}

// Diff-and-preserve merge per the bridge idempotency rule. AuthStorage hands
// back the full flat provider slice; we walk it credential-by-credential and
// decide for each provider whether to:
//   - preserve the prior on-disk Secret bytes verbatim (untouched provider,
//     detected by comparing AuthStorage's flat value to the read-time
//     snapshot, NOT a re-resolution against current env),
//   - reconstruct as Secret with prior `env` preserved (api-key value changed),
//   - write as new shape (provider added),
// and we drop providers that disappeared from the flat slice (real removal).
function mergeProvidersIntoEnvelope(
  envelope: SecretsFile,
  nextProvidersJson: string,
  readSnapshot: ReadSnapshot,
): SecretsFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(nextProvidersJson)
  } catch (err) {
    throw new Error(
      `AuthStorage produced invalid JSON for the providers slice: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  if (!isPlainObject(parsed)) {
    throw new Error('AuthStorage produced a non-object providers slice')
  }

  const nextProviders: Providers = {}
  for (const [providerId, raw] of Object.entries(parsed)) {
    const reconstructed = reconstructProviderCredential(
      raw,
      envelope.providers[providerId],
      readSnapshot.get(providerId),
    )
    if (reconstructed !== undefined) {
      nextProviders[providerId] = reconstructed
    }
  }

  return {
    ...envelope,
    $schema: envelope.$schema ?? SCHEMA_REL,
    version: SECRETS_FILE_VERSION,
    providers: nextProviders,
  }
}

function reconstructProviderCredential(
  raw: unknown,
  priorOnDisk: ProviderCredential | undefined,
  resolvedAtRead: string | undefined,
): ProviderCredential | undefined {
  if (!isPlainObject(raw)) return undefined
  const type = raw['type']

  if (type === 'api_key') {
    const flatKey = typeof raw['key'] === 'string' ? raw['key'] : ''

    // Empty/missing key from AuthStorage on an api-key credential cannot
    // round-trip: the schema requires `value` to be non-empty, so writing
    // `{ value: '' }` would make the file unparseable on next read. Treat
    // it as "no-op" and preserve the prior on-disk Secret if any. A real
    // deletion comes through as the provider being absent from `next`,
    // which is handled by the caller dropping it.
    if (flatKey === '') {
      if (priorOnDisk !== undefined) return priorOnDisk
      return undefined
    }

    // Idempotency: if AuthStorage's flat key matches the resolved value
    // captured at read time, the credential is untouched. Preserve the
    // on-disk Secret verbatim — including any `env` binding and any string
    // shorthand the user authored. Comparing against the read-time snapshot
    // (not a re-resolution against current process.env) is what makes this
    // safe against env mutations between read and write.
    if (priorOnDisk && priorOnDisk.type === 'api_key' && resolvedAtRead === flatKey) {
      return priorOnDisk
    }

    // Mutation path: rewrap as Secret, preserving the user's `env` binding
    // when prior was also an api-key so the next boot's env-wins still
    // consults the right variable.
    if (priorOnDisk && priorOnDisk.type === 'api_key' && priorOnDisk.key.env !== undefined) {
      return { type: 'api_key', key: { value: flatKey, env: priorOnDisk.key.env } satisfies Secret }
    }

    return { type: 'api_key', key: { value: flatKey } }
  }

  if (type === 'oauth') {
    // OAuth credentials are not env-injectable. Pass through verbatim,
    // preserving every upstream-controlled field (access, refresh, expires,
    // and any future additions covered by the catchall).
    return raw as ProviderCredential
  }

  // Unknown credential type. Pass through verbatim as a defensive measure
  // against upstream adding a third type in a future release. Better to
  // round-trip user data than drop it.
  return raw as ProviderCredential
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
