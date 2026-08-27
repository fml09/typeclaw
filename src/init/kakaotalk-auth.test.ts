import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { agentMessengerConfigDir } from '@/agent-messenger/config-dir'
import { createKeyStore } from '@/secrets/keys'

import {
  kakaotalkSecretsPath,
  type LoginFlowFn,
  type LoginFlowOptions,
  type LoginFlowResult,
  runKakaotalkBootstrap,
} from './kakaotalk-auth'

function isolatedKeyStore(agentDir: string): { keyStore: ReturnType<typeof createKeyStore>; containerName: string } {
  return {
    keyStore: createKeyStore({ keysDir: join(agentDir, '.test-keys') }),
    containerName: 'test-agent',
  }
}

const tmp = async (): Promise<string> => mkdtemp(join(tmpdir(), 'typeclaw-kakao-test-'))

const successResult: LoginFlowResult = {
  authenticated: true,
  credentials: {
    access_token: 'oauth-abc',
    refresh_token: 'refresh-xyz',
    user_id: 'user-1',
    device_uuid: 'uuid-1',
    device_type: 'tablet',
  },
}

describe('runKakaotalkBootstrap', () => {
  test('persists credentials when loginFlow returns authenticated', async () => {
    const agentDir = await tmp()
    try {
      const fake: LoginFlowFn = async (opts) => {
        expect(opts.email).toBe('user@example.com')
        expect(opts.password).toBe('secret')
        expect(opts.deviceType).toBe('tablet')
        return successResult
      }
      const result = await runKakaotalkBootstrap({
        email: 'user@example.com',
        password: 'secret',
        agentDir,
        callbacks: { onPasscode: () => {} },
        loginFlow: fake,
        ...isolatedKeyStore(agentDir),
      })
      expect(result).toEqual({ ok: true })
      const stored = JSON.parse(await readFile(kakaotalkSecretsPath(agentDir), 'utf8')) as {
        channels: {
          kakaotalk: {
            currentAccount: string
            accounts: Record<
              string,
              {
                user_id: string
                auth_method: string
                oauth_token: string
                email?: string
                encryptedPassword?: { kid: string; v: number; alg: string }
              }
            >
          }
        }
      }
      expect(stored.channels.kakaotalk.currentAccount).toBe('user-1')
      expect(stored.channels.kakaotalk.accounts['user-1']?.oauth_token).toBe('oauth-abc')
      expect(stored.channels.kakaotalk.accounts['user-1']?.auth_method).toBe('login')
      expect(stored.channels.kakaotalk.accounts['user-1']?.email).toBe('user@example.com')
      expect(stored.channels.kakaotalk.accounts['user-1']?.encryptedPassword?.v).toBe(1)
      expect(stored.channels.kakaotalk.accounts['user-1']?.encryptedPassword?.alg).toBe('AES-256-GCM')
      await expect(
        readFile(join(agentMessengerConfigDir(agentDir), 'kakaotalk-credentials.json'), 'utf8'),
      ).rejects.toThrow()
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('returns failure with the loginFlow message when authentication fails', async () => {
    const agentDir = await tmp()
    try {
      const fake: LoginFlowFn = async () => ({
        authenticated: false,
        error: 'bad_credentials',
        message: 'Login failed: incorrect email or password.',
      })
      const result = await runKakaotalkBootstrap({
        email: 'user@example.com',
        password: 'wrong',
        agentDir,
        callbacks: { onPasscode: () => {} },
        loginFlow: fake,
        ...isolatedKeyStore(agentDir),
      })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.reason).toBe('Login failed: incorrect email or password.')
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('returns failure when loginFlow throws', async () => {
    const agentDir = await tmp()
    try {
      const fake: LoginFlowFn = async () => {
        throw new Error('network unreachable')
      }
      const result = await runKakaotalkBootstrap({
        email: 'u@e.com',
        password: 'x',
        agentDir,
        callbacks: { onPasscode: () => {} },
        loginFlow: fake,
        ...isolatedKeyStore(agentDir),
      })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.reason).toBe('network unreachable')
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('forwards onPasscode through to loginFlow as onPasscodeDisplay', async () => {
    const agentDir = await tmp()
    try {
      const codes: string[] = []
      const fake: LoginFlowFn = async (opts: LoginFlowOptions) => {
        opts.onPasscodeDisplay?.('1234')
        return successResult
      }
      await runKakaotalkBootstrap({
        email: 'u@e.com',
        password: 'x',
        agentDir,
        callbacks: { onPasscode: (code) => codes.push(code) },
        loginFlow: fake,
        ...isolatedKeyStore(agentDir),
      })
      expect(codes).toEqual(['1234'])
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('reuses savedDeviceUuid from prior pending login', async () => {
    const agentDir = await tmp()
    try {
      await mkdir(agentDir, { recursive: true })
      await writeFile(
        kakaotalkSecretsPath(agentDir),
        JSON.stringify({
          version: 2,
          providers: {},
          channels: {
            kakaotalk: {
              currentAccount: null,
              accounts: {},
              pendingLogin: {
                device_uuid: 'previous-uuid',
                device_type: 'tablet',
                email: 'u@e.com',
                created_at: new Date().toISOString(),
              },
            },
          },
        }),
      )
      let received: string | undefined
      const fake: LoginFlowFn = async (opts) => {
        received = opts.savedDeviceUuid
        return successResult
      }
      await runKakaotalkBootstrap({
        email: 'u@e.com',
        password: 'x',
        agentDir,
        callbacks: { onPasscode: () => {} },
        loginFlow: fake,
        ...isolatedKeyStore(agentDir),
      })
      expect(received).toBe('previous-uuid')
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })
  test('uses the experimental android-main profile and ignores saved UUID when requested', async () => {
    const agentDir = await tmp()
    const previousDeviceType = process.env.TYPECLAW_KAKAO_DEVICE_TYPE
    const previousNewDevice = process.env.TYPECLAW_KAKAO_NEW_DEVICE
    try {
      await mkdir(agentDir, { recursive: true })
      await writeFile(
        kakaotalkSecretsPath(agentDir),
        JSON.stringify({
          version: 2,
          providers: {},
          channels: {
            kakaotalk: {
              currentAccount: null,
              accounts: {},
              pendingLogin: {
                device_uuid: 'previous-uuid',
                device_type: 'tablet',
                email: 'u@e.com',
                created_at: new Date().toISOString(),
              },
            },
          },
        }),
      )
      process.env.TYPECLAW_KAKAO_DEVICE_TYPE = 'android-main'
      process.env.TYPECLAW_KAKAO_NEW_DEVICE = 'true'
      let receivedType: string | undefined
      let receivedUuid: string | undefined
      const fake: LoginFlowFn = async (opts) => {
        receivedType = opts.deviceType
        receivedUuid = opts.savedDeviceUuid
        return successResult
      }
      await runKakaotalkBootstrap({
        email: 'u@e.com',
        password: 'x',
        agentDir,
        callbacks: { onPasscode: () => {} },
        loginFlow: fake,
        ...isolatedKeyStore(agentDir),
      })
      expect(receivedType).toBe('android-main')
      expect(receivedUuid).toBeUndefined()
    } finally {
      if (previousDeviceType === undefined) delete process.env.TYPECLAW_KAKAO_DEVICE_TYPE
      else process.env.TYPECLAW_KAKAO_DEVICE_TYPE = previousDeviceType
      if (previousNewDevice === undefined) delete process.env.TYPECLAW_KAKAO_NEW_DEVICE
      else process.env.TYPECLAW_KAKAO_NEW_DEVICE = previousNewDevice
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('uses default account_id when user_id is empty', async () => {
    const agentDir = await tmp()
    try {
      const fake: LoginFlowFn = async () => ({
        authenticated: true,
        credentials: {
          access_token: 'oauth',
          refresh_token: 'refresh',
          user_id: '',
          device_uuid: 'uuid',
          device_type: 'tablet',
        },
      })
      const result = await runKakaotalkBootstrap({
        email: 'u@e.com',
        password: 'x',
        agentDir,
        callbacks: { onPasscode: () => {} },
        loginFlow: fake,
        ...isolatedKeyStore(agentDir),
      })
      expect(result).toEqual({ ok: true })
      const stored = JSON.parse(await readFile(kakaotalkSecretsPath(agentDir), 'utf8')) as {
        channels: { kakaotalk: { currentAccount: string } }
      }
      expect(stored.channels.kakaotalk.currentAccount).toBe('default')
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })
})
