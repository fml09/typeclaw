import { join, resolve } from 'node:path'

import { loginFlow as upstreamLoginFlow, type KakaoDeviceType } from 'agent-messenger/kakaotalk'

import { containerNameFromCwd } from '@/container'
import { keysDir } from '@/hostd/paths'
import { encrypt } from '@/secrets/encryption'
import { SecretsKakaoCredentialStore } from '@/secrets/kakao-store'
import { createKeyStore, type KeyStore } from '@/secrets/keys'

export type KakaotalkBootstrapStatus = { ok: true } | { ok: false; reason: string }

export type KakaotalkLoginCallbacks = {
  onPasscode: (passcode: string) => void
}

export type KakaotalkLoginInput = {
  email: string
  password: string
  agentDir: string
  callbacks: KakaotalkLoginCallbacks
  loginFlow?: LoginFlowFn
  // Test seam: inject a custom keystore (typically pointing at a tmpdir).
  // Production uses ~/.typeclaw/keys/<containerName>.key.
  keyStore?: KeyStore
  // Test seam: override the containerName used to bind the encrypted
  // password's AAD. Production derives it from basename(agentDir) via
  // containerNameFromCwd to match what `typeclaw start` registers with hostd.
  containerName?: string
}

function requestedKakaoDeviceType(): KakaoDeviceType {
  const raw = process.env.TYPECLAW_KAKAO_DEVICE_TYPE
  if (raw === undefined || raw === '') return 'tablet'
  if (raw === 'pc' || raw === 'tablet' || raw === 'android-main') return raw
  throw new Error(`TYPECLAW_KAKAO_DEVICE_TYPE must be pc, tablet, or android-main; received ${JSON.stringify(raw)}`)
}

export type LoginFlowFn = typeof upstreamLoginFlow
export type LoginFlowOptions = Parameters<LoginFlowFn>[0]
export type LoginFlowResult = Awaited<ReturnType<LoginFlowFn>>

export function kakaotalkSecretsPath(agentDir: string): string {
  return join(agentDir, 'secrets.json')
}

export async function runKakaotalkBootstrap(input: KakaotalkLoginInput): Promise<KakaotalkBootstrapStatus> {
  try {
    const loginFlow = input.loginFlow ?? upstreamLoginFlow
    const credManager = new SecretsKakaoCredentialStore({
      mode: 'host',
      secretsPath: kakaotalkSecretsPath(input.agentDir),
    })
    const pending = await credManager.loadPendingLogin()
    const existing = await credManager.getAccount()
    const deviceType = requestedKakaoDeviceType()
    const forceNewDevice =
      process.env.TYPECLAW_KAKAO_NEW_DEVICE === '1' || process.env.TYPECLAW_KAKAO_NEW_DEVICE === 'true'
    const savedDeviceUuid = forceNewDevice
      ? undefined
      : (pending?.device_uuid ?? (existing?.auth_method === 'login' ? existing.device_uuid : undefined))

    const result = await loginFlow({
      email: input.email,
      password: input.password,
      deviceType,
      force: false,
      ...(savedDeviceUuid !== undefined ? { savedDeviceUuid } : {}),
      onPasscodeDisplay: input.callbacks.onPasscode,
    })

    if (!result.authenticated || !result.credentials) {
      const reason = result.message ?? result.error ?? 'agent-kakaotalk did not authenticate (check email/password)'
      return { ok: false, reason }
    }

    const now = new Date().toISOString()
    const accountId = result.credentials.user_id || 'default'
    const containerName = input.containerName ?? containerNameFromCwd(resolve(input.agentDir))
    const keyStore = input.keyStore ?? createKeyStore({ keysDir: keysDir() })
    const key = await keyStore.ensure(containerName)
    const encryptedPassword = encrypt(input.password, key, { containerName, accountId })
    await credManager.setAccount({
      account_id: accountId,
      oauth_token: result.credentials.access_token,
      user_id: result.credentials.user_id,
      refresh_token: result.credentials.refresh_token,
      device_uuid: result.credentials.device_uuid,
      device_type: result.credentials.device_type,
      auth_method: 'login',
      created_at: now,
      updated_at: now,
      email: input.email,
      encryptedPassword,
    })
    await credManager.setCurrentAccount(accountId)
    await credManager.clearPendingLogin()

    return { ok: true }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}
