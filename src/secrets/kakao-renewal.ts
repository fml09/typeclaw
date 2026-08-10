import { join } from 'node:path'

import {
  attemptLogin as upstreamAttemptLogin,
  KakaoOAuthRefreshError,
  type KakaoDeviceType,
  refreshKakaoOAuthToken as upstreamRefreshKakaoOAuthToken,
} from 'agent-messenger/kakaotalk'

import { decrypt, EncryptionError } from './encryption'
import { SecretsKakaoCredentialStore } from './kakao-store'
import { type KeyStore, KeyStoreError } from './keys'
import { type KakaoChannelBlock } from './schema'
import { SecretsBackend } from './storage'

export const RENEWAL_THRESHOLD_MS = 5 * 24 * 60 * 60 * 1000

// Hard ~7-day TTL on KakaoTalk sub-device tokens means renewal must happen
// before that wall. We refresh at >5 days old to leave a 2-day safety margin
// for cron skips (host asleep, daemon respawning, etc.) and to absorb any
// downward drift in KakaoTalk's actual TTL.

type ReauthDecision = {
  kind: 'reauth_required'
  reason: 'no_password' | 'no_email' | 'key_missing' | 'decrypt_failed'
  message: string
}

type PasswordRenewalDecision =
  | ReauthDecision
  | { kind: 'should_renew'; method: 'password'; account: AccountSnapshot & { email: string }; password: string }

export type RenewalDecision =
  | { kind: 'skip'; reason: 'no_account' | 'fresh_enough'; ageMs?: number }
  | ReauthDecision
  | { kind: 'should_renew'; method: 'oauth_refresh'; account: AccountSnapshot }
  | PasswordRenewalDecision

export type AccountSnapshot = {
  account_id: string
  oauth_token: string
  user_id: string
  refresh_token?: string
  device_uuid: string
  device_type: KakaoDeviceType
  auth_method?: 'login' | 'extract'
  created_at: string
  updated_at: string
  email?: string
}

export type RenewalMethod = 'oauth_refresh' | 'password'

export type RenewalAttempt =
  | { kind: 'ok'; account_id: string; previousUpdatedAt: string; nextUpdatedAt: string; method: RenewalMethod }
  | { kind: 'reauth_required'; account_id: string; reason: string; message: string }
  | { kind: 'transient_failure'; account_id: string; reason: string }

export type AttemptLoginFn = typeof upstreamAttemptLogin
export type RefreshOAuthTokenFn = typeof upstreamRefreshKakaoOAuthToken

export type RenewalContext = {
  containerName: string
  agentDir: string
  keyStore: KeyStore
  now?: () => number
  attemptLogin?: AttemptLoginFn
  refreshOAuthToken?: RefreshOAuthTokenFn
}

export async function decideRenewal(block: KakaoChannelBlock, ctx: RenewalContext): Promise<RenewalDecision> {
  const accountId = block.currentAccount
  if (!accountId) return { kind: 'skip', reason: 'no_account' }
  const account = block.accounts[accountId]
  if (!account) return { kind: 'skip', reason: 'no_account' }

  const now = (ctx.now ?? Date.now)()
  const ageMs = now - Date.parse(account.updated_at)
  if (Number.isFinite(ageMs) && ageMs < RENEWAL_THRESHOLD_MS) {
    return { kind: 'skip', reason: 'fresh_enough', ageMs }
  }

  const snapshot = snapshotAccount(account)
  if (account.refresh_token !== undefined) {
    return { kind: 'should_renew', method: 'oauth_refresh', account: snapshot }
  }

  return decidePasswordRenewal(snapshot, account.encryptedPassword, ctx)
}

function snapshotAccount(account: KakaoChannelBlock['accounts'][string]): AccountSnapshot {
  return {
    account_id: account.account_id,
    oauth_token: account.oauth_token,
    user_id: account.user_id,
    ...(account.refresh_token !== undefined ? { refresh_token: account.refresh_token } : {}),
    device_uuid: account.device_uuid,
    device_type: account.device_type,
    ...(account.auth_method !== undefined ? { auth_method: account.auth_method } : {}),
    created_at: account.created_at,
    updated_at: account.updated_at,
    ...(account.email !== undefined ? { email: account.email } : {}),
  }
}

async function decidePasswordRenewal(
  account: AccountSnapshot,
  encryptedPassword: KakaoChannelBlock['accounts'][string]['encryptedPassword'],
  ctx: RenewalContext,
): Promise<PasswordRenewalDecision> {
  if (!account.email) {
    return {
      kind: 'reauth_required',
      reason: 'no_email',
      message: `KakaoTalk account ${account.account_id} has no stored email — run \`typeclaw channel reauth kakaotalk\`.`,
    }
  }
  if (!encryptedPassword) {
    return {
      kind: 'reauth_required',
      reason: 'no_password',
      message: `KakaoTalk account ${account.account_id} has no stored password — run \`typeclaw channel reauth kakaotalk\`.`,
    }
  }

  let plaintextPassword: string
  try {
    const key = await ctx.keyStore.read(ctx.containerName)
    plaintextPassword = decrypt(encryptedPassword, key, {
      containerName: ctx.containerName,
      accountId: account.account_id,
    })
  } catch (err) {
    return classifyDecryptFailure(err, account.account_id)
  }

  return {
    kind: 'should_renew',
    method: 'password',
    account: { ...account, email: account.email },
    password: plaintextPassword,
  }
}

export async function renewCurrentAccount(
  ctx: RenewalContext,
): Promise<RenewalAttempt | { kind: 'skipped'; reason: string; ageMs?: number }> {
  const secretsPath = join(ctx.agentDir, 'secrets.json')
  const backend = new SecretsBackend(secretsPath)
  const block = backend.readChannelsSync()?.kakaotalk
  const parsed = parseBlockOrEmpty(block)
  let decision = await decideRenewal(parsed, ctx)

  if (decision.kind === 'skip') {
    return {
      kind: 'skipped',
      reason: decision.reason,
      ...(decision.ageMs !== undefined ? { ageMs: decision.ageMs } : {}),
    }
  }
  if (decision.kind === 'reauth_required') {
    return {
      kind: 'reauth_required',
      account_id: parsed.currentAccount ?? '',
      reason: decision.reason,
      message: decision.message,
    }
  }

  if (decision.method === 'oauth_refresh') {
    const refreshOAuthToken = ctx.refreshOAuthToken ?? upstreamRefreshKakaoOAuthToken
    try {
      const refreshed = await refreshOAuthToken({
        accessToken: decision.account.oauth_token,
        refreshToken: decision.account.refresh_token ?? '',
        deviceUuid: decision.account.device_uuid,
      })
      const store = new SecretsKakaoCredentialStore({ mode: 'host', secretsPath })
      const nowIso = new Date().toISOString()
      await store.setAccount({
        account_id: decision.account.account_id,
        oauth_token: refreshed.accessToken,
        user_id: decision.account.user_id,
        refresh_token: refreshed.refreshToken,
        device_uuid: decision.account.device_uuid,
        device_type: decision.account.device_type,
        ...(decision.account.auth_method !== undefined ? { auth_method: decision.account.auth_method } : {}),
        created_at: decision.account.created_at,
        updated_at: nowIso,
      })
      return {
        kind: 'ok',
        account_id: decision.account.account_id,
        previousUpdatedAt: decision.account.updated_at,
        nextUpdatedAt: nowIso,
        method: 'oauth_refresh',
      }
    } catch (err) {
      // Only a rejected or incomplete refresh credential justifies the heavier
      // password login. Transport/server failures keep the refresh token in
      // place and retry next tick rather than risk a passcode or captcha prompt.
      if (
        !(err instanceof KakaoOAuthRefreshError) ||
        (err.code !== 'refresh_rejected' && err.code !== 'refresh_credentials_missing')
      ) {
        return {
          kind: 'transient_failure',
          account_id: decision.account.account_id,
          reason: err instanceof Error ? err.message : String(err),
        }
      }

      const account = parsed.accounts[decision.account.account_id]
      decision = await decidePasswordRenewal(decision.account, account?.encryptedPassword, ctx)
      if (decision.kind === 'reauth_required') {
        return {
          kind: 'reauth_required',
          account_id: parsed.currentAccount ?? '',
          reason: decision.reason,
          message: decision.message,
        }
      }
    }
  }

  const attemptLogin = ctx.attemptLogin ?? upstreamAttemptLogin
  const result = await attemptLogin(
    decision.account.email,
    decision.password,
    decision.account.device_uuid,
    decision.account.device_type,
    false,
  )

  if (!result.authenticated || !result.credentials) {
    const message = result.message ?? result.error ?? 'login did not authenticate'
    if (result.error === 'bad_credentials' || result.next_action === 'provide_passcode') {
      return {
        kind: 'reauth_required',
        account_id: decision.account.account_id,
        reason: result.error ?? result.next_action ?? 'login_failed',
        message,
      }
    }
    return {
      kind: 'transient_failure',
      account_id: decision.account.account_id,
      reason: message,
    }
  }

  const store = new SecretsKakaoCredentialStore({ mode: 'host', secretsPath })
  const nowIso = new Date().toISOString()
  await store.setAccount({
    account_id: decision.account.account_id,
    oauth_token: result.credentials.access_token,
    user_id: result.credentials.user_id,
    refresh_token: result.credentials.refresh_token,
    device_uuid: result.credentials.device_uuid,
    device_type: result.credentials.device_type,
    auth_method: 'login',
    created_at: decision.account.created_at,
    updated_at: nowIso,
  })

  return {
    kind: 'ok',
    account_id: decision.account.account_id,
    previousUpdatedAt: decision.account.updated_at,
    nextUpdatedAt: nowIso,
    method: 'password',
  }
}

function parseBlockOrEmpty(value: unknown): KakaoChannelBlock {
  if (value === undefined) return { currentAccount: null, accounts: {} }
  return value as KakaoChannelBlock
}

function classifyDecryptFailure(err: unknown, accountId: string): ReauthDecision {
  if (err instanceof KeyStoreError) {
    if (err.code === 'missing') {
      return {
        kind: 'reauth_required',
        reason: 'key_missing',
        message: `Encryption key missing for KakaoTalk account ${accountId} — run \`typeclaw channel reauth kakaotalk\` to mint a fresh one.`,
      }
    }
    return {
      kind: 'reauth_required',
      reason: 'key_missing',
      message: `Encryption key for KakaoTalk account ${accountId} is unusable (${err.code}: ${err.message}). Move it aside and run \`typeclaw channel reauth kakaotalk\` to mint a fresh one.`,
    }
  }
  if (err instanceof EncryptionError) {
    return {
      kind: 'reauth_required',
      reason: 'decrypt_failed',
      message: `Could not decrypt stored KakaoTalk password (${err.code}) — run \`typeclaw channel reauth kakaotalk\`.`,
    }
  }
  return {
    kind: 'reauth_required',
    reason: 'decrypt_failed',
    message: `Could not decrypt stored KakaoTalk password (${err instanceof Error ? err.message : String(err)}).`,
  }
}
