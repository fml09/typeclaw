import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { KakaoOAuthRefreshError } from 'agent-messenger/kakaotalk'

import { encrypt, generateKey } from './encryption'
import {
  type AttemptLoginFn,
  decideRenewal,
  type RefreshOAuthTokenFn,
  RENEWAL_THRESHOLD_MS,
  renewCurrentAccount,
} from './kakao-renewal'
import { KeyStoreError, type KeyStore } from './keys'
import { type KakaoChannelBlock, type KakaoEncryptedPassword } from './schema'

function fakeKeyStore(opts: { containerName: string; key: Buffer | null }): KeyStore {
  return {
    keyPath: (name: string) => `/fake/${name}.key`,
    exists: (name: string) => opts.key !== null && name === opts.containerName,
    async read(name: string) {
      if (opts.key === null || name !== opts.containerName) {
        throw new KeyStoreError(`key file missing: ${name}`, 'missing')
      }
      return opts.key
    },
    async ensure(name: string) {
      if (opts.key === null || name !== opts.containerName) {
        throw new KeyStoreError(`key file missing: ${name}`, 'missing')
      }
      return opts.key
    },
    fingerprint: () => 'sha256:test',
  }
}

function buildBlock(opts: {
  accountId: string
  ageDays: number
  email?: string
  encryptedPassword?: KakaoEncryptedPassword
  refreshToken?: string
}): KakaoChannelBlock {
  const updatedAt = new Date(Date.now() - opts.ageDays * 24 * 60 * 60 * 1000).toISOString()
  return {
    currentAccount: opts.accountId,
    accounts: {
      [opts.accountId]: {
        account_id: opts.accountId,
        oauth_token: 'stale-oauth',
        user_id: opts.accountId,
        ...(opts.refreshToken !== undefined ? { refresh_token: opts.refreshToken } : {}),
        device_uuid: 'device-uuid',
        device_type: 'tablet',
        auth_method: 'login',
        created_at: updatedAt,
        updated_at: updatedAt,
        ...(opts.email !== undefined ? { email: opts.email } : {}),
        ...(opts.encryptedPassword !== undefined ? { encryptedPassword: opts.encryptedPassword } : {}),
      },
    },
  }
}

describe('decideRenewal', () => {
  test('skips when there is no current account', async () => {
    const block: KakaoChannelBlock = { currentAccount: null, accounts: {} }
    const decision = await decideRenewal(block, {
      containerName: 'kakao',
      agentDir: '/tmp/x',
      keyStore: fakeKeyStore({ containerName: 'kakao', key: null }),
    })
    expect(decision.kind).toBe('skip')
    if (decision.kind === 'skip') expect(decision.reason).toBe('no_account')
  })

  test('skips when the token is fresh (<5 days old)', async () => {
    const block = buildBlock({ accountId: 'u-1', ageDays: 2 })
    const decision = await decideRenewal(block, {
      containerName: 'kakao',
      agentDir: '/tmp/x',
      keyStore: fakeKeyStore({ containerName: 'kakao', key: null }),
    })
    expect(decision.kind).toBe('skip')
    if (decision.kind === 'skip') expect(decision.reason).toBe('fresh_enough')
  })

  test('requires reauth when email is absent (>5 days old)', async () => {
    const block = buildBlock({ accountId: 'u-1', ageDays: 6 })
    const decision = await decideRenewal(block, {
      containerName: 'kakao',
      agentDir: '/tmp/x',
      keyStore: fakeKeyStore({ containerName: 'kakao', key: null }),
    })
    expect(decision.kind).toBe('reauth_required')
    if (decision.kind === 'reauth_required') expect(decision.reason).toBe('no_email')
  })

  test('requires reauth when encryptedPassword is absent', async () => {
    const block = buildBlock({ accountId: 'u-1', ageDays: 6, email: 'u@e.com' })
    const decision = await decideRenewal(block, {
      containerName: 'kakao',
      agentDir: '/tmp/x',
      keyStore: fakeKeyStore({ containerName: 'kakao', key: null }),
    })
    expect(decision.kind).toBe('reauth_required')
    if (decision.kind === 'reauth_required') expect(decision.reason).toBe('no_password')
  })

  test('requires reauth when the key file is missing', async () => {
    const key = generateKey()
    const encryptedPassword = encrypt('pw', key, { containerName: 'kakao', accountId: 'u-1' })
    const block = buildBlock({ accountId: 'u-1', ageDays: 6, email: 'u@e.com', encryptedPassword })
    const decision = await decideRenewal(block, {
      containerName: 'kakao',
      agentDir: '/tmp/x',
      keyStore: fakeKeyStore({ containerName: 'kakao', key: null }),
    })
    expect(decision.kind).toBe('reauth_required')
    if (decision.kind === 'reauth_required') expect(decision.reason).toBe('key_missing')
  })

  test('requires reauth when the key does not match the ciphertext (wrong key)', async () => {
    const realKey = generateKey()
    const otherKey = generateKey()
    const encryptedPassword = encrypt('pw', realKey, { containerName: 'kakao', accountId: 'u-1' })
    const block = buildBlock({ accountId: 'u-1', ageDays: 6, email: 'u@e.com', encryptedPassword })
    const decision = await decideRenewal(block, {
      containerName: 'kakao',
      agentDir: '/tmp/x',
      keyStore: fakeKeyStore({ containerName: 'kakao', key: otherKey }),
    })
    expect(decision.kind).toBe('reauth_required')
    if (decision.kind === 'reauth_required') expect(decision.reason).toBe('decrypt_failed')
  })

  test('returns should_renew with decrypted password when everything aligns', async () => {
    const key = generateKey()
    const encryptedPassword = encrypt('hunter2', key, { containerName: 'kakao', accountId: 'u-1' })
    const block = buildBlock({ accountId: 'u-1', ageDays: 6, email: 'u@e.com', encryptedPassword })
    const decision = await decideRenewal(block, {
      containerName: 'kakao',
      agentDir: '/tmp/x',
      keyStore: fakeKeyStore({ containerName: 'kakao', key }),
    })
    expect(decision.kind).toBe('should_renew')
    if (decision.kind === 'should_renew' && decision.method === 'password') {
      expect(decision.account.account_id).toBe('u-1')
      expect(decision.account.email).toBe('u@e.com')
      expect(decision.password).toBe('hunter2')
    }
  })

  test('respects the RENEWAL_THRESHOLD_MS boundary exactly', async () => {
    const exactly5Days = new Date(Date.now() - RENEWAL_THRESHOLD_MS - 1000).toISOString()
    const block: KakaoChannelBlock = {
      currentAccount: 'u-1',
      accounts: {
        'u-1': {
          account_id: 'u-1',
          oauth_token: 'o',
          user_id: 'u-1',
          device_uuid: 'd',
          device_type: 'tablet',
          auth_method: 'login',
          created_at: exactly5Days,
          updated_at: exactly5Days,
        },
      },
    }
    const decision = await decideRenewal(block, {
      containerName: 'kakao',
      agentDir: '/tmp/x',
      keyStore: fakeKeyStore({ containerName: 'kakao', key: null }),
    })
    // Account is older than threshold and lacks email → reauth_required (NOT skip)
    expect(decision.kind).toBe('reauth_required')
  })
})

describe('renewCurrentAccount', () => {
  async function withAgentDir<T>(fn: (agentDir: string) => Promise<T>): Promise<T> {
    return fn(await mkdtemp(join(tmpdir(), 'typeclaw-kakao-renewal-')))
  }

  async function seedSecrets(agentDir: string, block: KakaoChannelBlock): Promise<void> {
    const envelope = {
      version: 2,
      providers: {},
      channels: { kakaotalk: block },
    }
    await writeFile(join(agentDir, 'secrets.json'), JSON.stringify(envelope))
  }

  test('skips when current account is fresh', async () => {
    await withAgentDir(async (agentDir) => {
      const block = buildBlock({ accountId: 'u-1', ageDays: 2 })
      await seedSecrets(agentDir, block)

      const result = await renewCurrentAccount({
        containerName: 'kakao',
        agentDir,
        keyStore: fakeKeyStore({ containerName: 'kakao', key: null }),
        attemptLogin: async () => {
          throw new Error('attemptLogin must not be called for a fresh account')
        },
      })
      expect(result.kind).toBe('skipped')
    })
  })

  test('refreshes OAuth tokens without touching password renewal fields', async () => {
    await withAgentDir(async (agentDir) => {
      const block = buildBlock({ accountId: 'u-1', ageDays: 6, refreshToken: 'stale-refresh' })
      await seedSecrets(agentDir, block)
      const calls: Parameters<RefreshOAuthTokenFn>[0][] = []

      const result = await renewCurrentAccount({
        containerName: 'kakao',
        agentDir,
        keyStore: fakeKeyStore({ containerName: 'kakao', key: null }),
        refreshOAuthToken: async (input) => {
          calls.push(input)
          return { accessToken: 'fresh-access', refreshToken: 'fresh-refresh' }
        },
        attemptLogin: async () => {
          throw new Error('attemptLogin must not be called after OAuth refresh succeeds')
        },
      })

      expect(result.kind).toBe('ok')
      if (result.kind === 'ok') expect(result.method).toBe('oauth_refresh')
      expect(calls).toEqual([{ accessToken: 'stale-oauth', refreshToken: 'stale-refresh', deviceUuid: 'device-uuid' }])

      const raw = JSON.parse(await readFile(join(agentDir, 'secrets.json'), 'utf8'))
      const persisted = raw.channels.kakaotalk.accounts['u-1']
      expect(persisted.oauth_token).toBe('fresh-access')
      expect(persisted.refresh_token).toBe('fresh-refresh')
      expect(persisted.auth_method).toBe('login')
      expect(persisted.created_at).toBe(block.accounts['u-1']!.created_at)
    })
  })

  for (const code of ['refresh_rejected', 'refresh_credentials_missing'] as const) {
    test(`falls back to password login when OAuth refresh reports ${code}`, async () => {
      await withAgentDir(async (agentDir) => {
        const key = generateKey()
        const encryptedPassword = encrypt('hunter2', key, { containerName: 'kakao', accountId: 'u-1' })
        const block = buildBlock({
          accountId: 'u-1',
          ageDays: 6,
          email: 'u@e.com',
          encryptedPassword,
          refreshToken: 'dead-refresh',
        })
        await seedSecrets(agentDir, block)
        let loginCalls = 0

        const result = await renewCurrentAccount({
          containerName: 'kakao',
          agentDir,
          keyStore: fakeKeyStore({ containerName: 'kakao', key }),
          refreshOAuthToken: async () => {
            throw new KakaoOAuthRefreshError(code)
          },
          attemptLogin: async (_email, _password, deviceUuid, deviceType) => {
            loginCalls++
            return {
              authenticated: true,
              credentials: {
                access_token: 'login-access',
                refresh_token: 'login-refresh',
                user_id: 'u-1',
                device_uuid: deviceUuid,
                device_type: deviceType,
              },
            }
          },
        })

        expect(result.kind).toBe('ok')
        if (result.kind === 'ok') expect(result.method).toBe('password')
        expect(loginCalls).toBe(1)
      })
    })
  }

  for (const code of ['refresh_rejected', 'refresh_credentials_missing'] as const) {
    test(`requires reauth when OAuth refresh reports ${code} and no password fallback exists`, async () => {
      await withAgentDir(async (agentDir) => {
        const block = buildBlock({ accountId: 'u-1', ageDays: 6, refreshToken: 'dead-refresh' })
        await seedSecrets(agentDir, block)

        const result = await renewCurrentAccount({
          containerName: 'kakao',
          agentDir,
          keyStore: fakeKeyStore({ containerName: 'kakao', key: null }),
          refreshOAuthToken: async () => {
            throw new KakaoOAuthRefreshError(code)
          },
          attemptLogin: async () => {
            throw new Error('attemptLogin must not be called without password renewal fields')
          },
        })

        expect(result.kind).toBe('reauth_required')
        if (result.kind === 'reauth_required') expect(result.reason).toBe('no_email')
      })
    })
  }

  for (const code of ['refresh_timeout', 'refresh_http_error'] as const) {
    test(`reports transient_failure on ${code} without attempting password login`, async () => {
      await withAgentDir(async (agentDir) => {
        const key = generateKey()
        const encryptedPassword = encrypt('hunter2', key, { containerName: 'kakao', accountId: 'u-1' })
        const block = buildBlock({
          accountId: 'u-1',
          ageDays: 6,
          email: 'u@e.com',
          encryptedPassword,
          refreshToken: 'stale-refresh',
        })
        await seedSecrets(agentDir, block)

        const result = await renewCurrentAccount({
          containerName: 'kakao',
          agentDir,
          keyStore: fakeKeyStore({ containerName: 'kakao', key }),
          refreshOAuthToken: async () => {
            throw new KakaoOAuthRefreshError(code)
          },
          attemptLogin: async () => {
            throw new Error('attemptLogin must not run after a transient OAuth refresh failure')
          },
        })

        expect(result.kind).toBe('transient_failure')
        if (result.kind === 'transient_failure') expect(result.reason).toContain(code)
      })
    })
  }

  test('writes fresh tokens through the store when attemptLogin succeeds, preserving email + encryptedPassword', async () => {
    await withAgentDir(async (agentDir) => {
      const key = generateKey()
      const encryptedPassword = encrypt('hunter2', key, { containerName: 'kakao', accountId: 'u-1' })
      const block = buildBlock({ accountId: 'u-1', ageDays: 6, email: 'u@e.com', encryptedPassword })
      await seedSecrets(agentDir, block)

      const calls: Array<{ email: string; password: string; deviceUuid: string }> = []
      const fakeLogin: AttemptLoginFn = async (email, password, deviceUuid, deviceType) => {
        calls.push({ email, password, deviceUuid })
        return {
          authenticated: true,
          credentials: {
            access_token: 'fresh-access',
            refresh_token: 'fresh-refresh',
            user_id: 'u-1',
            device_uuid: deviceUuid,
            device_type: deviceType,
          },
        }
      }

      const result = await renewCurrentAccount({
        containerName: 'kakao',
        agentDir,
        keyStore: fakeKeyStore({ containerName: 'kakao', key }),
        attemptLogin: fakeLogin,
      })

      expect(result.kind).toBe('ok')
      if (result.kind === 'ok') expect(result.method).toBe('password')
      expect(calls).toEqual([{ email: 'u@e.com', password: 'hunter2', deviceUuid: 'device-uuid' }])

      const raw = JSON.parse(await readFile(join(agentDir, 'secrets.json'), 'utf8'))
      const persisted = raw.channels.kakaotalk.accounts['u-1']
      expect(persisted.oauth_token).toBe('fresh-access')
      expect(persisted.email).toBe('u@e.com')
      expect(persisted.encryptedPassword?.kid).toBe(encryptedPassword.kid)
      expect(Date.parse(persisted.updated_at)).toBeGreaterThan(Date.parse(block.accounts['u-1']!.updated_at))
    })
  })

  test('preserves created_at across renewals (only updated_at advances)', async () => {
    await withAgentDir(async (agentDir) => {
      const key = generateKey()
      const encryptedPassword = encrypt('hunter2', key, { containerName: 'kakao', accountId: 'u-1' })
      const originalCreatedAt = '2026-01-01T00:00:00.000Z'
      const olderUpdatedAt = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString()
      const block: KakaoChannelBlock = {
        currentAccount: 'u-1',
        accounts: {
          'u-1': {
            account_id: 'u-1',
            oauth_token: 'stale',
            user_id: 'u-1',
            refresh_token: 'stale-refresh',
            device_uuid: 'device-uuid',
            device_type: 'tablet',
            auth_method: 'login',
            created_at: originalCreatedAt,
            updated_at: olderUpdatedAt,
            email: 'u@e.com',
            encryptedPassword,
          },
        },
      }
      await seedSecrets(agentDir, block)

      const result = await renewCurrentAccount({
        containerName: 'kakao',
        agentDir,
        keyStore: fakeKeyStore({ containerName: 'kakao', key }),
        // The account carries a refresh_token, so renewal tries OAuth refresh
        // first — stub it to fall back, otherwise this test would hit the
        // real agent-messenger/kakaotalk endpoint over the network.
        refreshOAuthToken: async () => {
          throw new KakaoOAuthRefreshError('refresh_rejected')
        },
        attemptLogin: async (_email, _password, deviceUuid, deviceType) => ({
          authenticated: true,
          credentials: {
            access_token: 'fresh',
            refresh_token: 'fresh-refresh',
            user_id: 'u-1',
            device_uuid: deviceUuid,
            device_type: deviceType,
          },
        }),
      })

      expect(result.kind).toBe('ok')
      if (result.kind === 'ok') expect(result.method).toBe('password')
      const raw = JSON.parse(await readFile(join(agentDir, 'secrets.json'), 'utf8'))
      const persisted = raw.channels.kakaotalk.accounts['u-1']
      expect(persisted.created_at).toBe(originalCreatedAt)
      expect(Date.parse(persisted.updated_at)).toBeGreaterThan(Date.parse(olderUpdatedAt))
    })
  })

  test('reports reauth_required (not transient) on bad_credentials', async () => {
    await withAgentDir(async (agentDir) => {
      const key = generateKey()
      const encryptedPassword = encrypt('hunter2', key, { containerName: 'kakao', accountId: 'u-1' })
      const block = buildBlock({ accountId: 'u-1', ageDays: 6, email: 'u@e.com', encryptedPassword })
      await seedSecrets(agentDir, block)

      const result = await renewCurrentAccount({
        containerName: 'kakao',
        agentDir,
        keyStore: fakeKeyStore({ containerName: 'kakao', key }),
        attemptLogin: async () => ({
          authenticated: false,
          error: 'bad_credentials',
          message: 'wrong password',
        }),
      })

      expect(result.kind).toBe('reauth_required')
    })
  })

  test('reports transient_failure when login fails for a non-credential reason', async () => {
    await withAgentDir(async (agentDir) => {
      const key = generateKey()
      const encryptedPassword = encrypt('hunter2', key, { containerName: 'kakao', accountId: 'u-1' })
      const block = buildBlock({ accountId: 'u-1', ageDays: 6, email: 'u@e.com', encryptedPassword })
      await seedSecrets(agentDir, block)

      const result = await renewCurrentAccount({
        containerName: 'kakao',
        agentDir,
        keyStore: fakeKeyStore({ containerName: 'kakao', key }),
        attemptLogin: async () => ({
          authenticated: false,
          error: 'login_http_error',
          message: 'HTTP 503 from login endpoint',
        }),
      })

      expect(result.kind).toBe('transient_failure')
    })
  })

  test('returns reauth_required when email is missing, without calling attemptLogin', async () => {
    await withAgentDir(async (agentDir) => {
      const block = buildBlock({ accountId: 'u-1', ageDays: 6 })
      await seedSecrets(agentDir, block)

      const result = await renewCurrentAccount({
        containerName: 'kakao',
        agentDir,
        keyStore: fakeKeyStore({ containerName: 'kakao', key: null }),
        attemptLogin: async () => {
          throw new Error('attemptLogin must not be called when reauth is required')
        },
      })

      expect(result.kind).toBe('reauth_required')
      if (result.kind === 'reauth_required') expect(result.reason).toBe('no_email')
    })
  })
})
