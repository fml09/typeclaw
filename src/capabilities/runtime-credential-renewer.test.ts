import { describe, expect, test } from 'bun:test'

import type { RenewalAttempt } from '@/secrets/kakao-renewal'
import type { KeyStore } from '@/secrets/keys'
import { waitFor } from '@/test-helpers/wait-for'

import {
  createManagedRuntimeCredentialRenewer,
  type RuntimeCredentialRenewalLogger,
} from './runtime-credential-renewer'

const keyStore: KeyStore = {
  keyPath: (name) => `/keys/${name}.key`,
  exists: () => true,
  read: async () => Buffer.alloc(32),
  ensure: async () => Buffer.alloc(32),
  fingerprint: () => 'sha256:test',
}

const quietLogger: RuntimeCredentialRenewalLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
}

function renewed(accountId = 'account-1'): RenewalAttempt {
  return {
    kind: 'ok',
    account_id: accountId,
    previousUpdatedAt: '2026-08-01T00:00:00.000Z',
    nextUpdatedAt: '2026-08-06T00:00:00.000Z',
    method: 'oauth_refresh',
  }
}

describe('createManagedRuntimeCredentialRenewer', () => {
  test('runs an immediate check with the Agent Folder identity and applies the rotation', async () => {
    const renewalContexts: Array<{ containerName: string; agentDir: string }> = []
    const rotations: string[] = []
    let scheduledInterval = 0
    let timerStopped = false
    const renewer = createManagedRuntimeCredentialRenewer({
      agentDir: '/runtime/agent',
      keyStore,
      tickIntervalMs: 1234,
      logger: quietLogger,
      renew: async (ctx) => {
        renewalContexts.push({ containerName: ctx.containerName, agentDir: ctx.agentDir })
        return renewed()
      },
      schedule: (_fn, intervalMs) => {
        scheduledInterval = intervalMs
        return { stop: () => void (timerStopped = true) }
      },
    })

    await renewer.start({
      shouldRenew: () => true,
      onCredentialRotated: async (rotation) => void rotations.push(`${rotation.adapter}:${rotation.accountId}`),
    })

    expect(renewalContexts).toEqual([{ containerName: 'agent', agentDir: '/runtime/agent' }])
    expect(rotations).toEqual(['kakaotalk:account-1'])
    expect(scheduledInterval).toBe(1234)

    await renewer.stop()
    expect(timerStopped).toBe(true)
  })

  test('does not touch credentials while the KakaoTalk adapter is disabled', async () => {
    let renewalCalls = 0
    const renewer = createManagedRuntimeCredentialRenewer({
      agentDir: '/runtime/agent',
      keyStore,
      logger: quietLogger,
      renew: async () => {
        renewalCalls++
        return renewed()
      },
      schedule: () => ({ stop: () => {} }),
    })

    await renewer.start({
      shouldRenew: () => false,
      onCredentialRotated: async () => {
        throw new Error('disabled adapter must not receive a rotation')
      },
    })

    expect(renewalCalls).toBe(0)
    await renewer.stop()
  })

  test('retries applying a landed credential even when the token is now fresh on disk', async () => {
    let scheduledTick: () => void = () => {
      throw new Error('renewal tick was not scheduled')
    }
    let renewalCalls = 0
    let applyCalls = 0
    const renewer = createManagedRuntimeCredentialRenewer({
      agentDir: '/runtime/agent',
      keyStore,
      logger: quietLogger,
      renew: async () => {
        renewalCalls++
        return renewalCalls === 1 ? renewed() : ({ kind: 'skipped', reason: 'fresh_enough', ageMs: 60_000 } as const)
      },
      schedule: (fn) => {
        scheduledTick = fn
        return { stop: () => {} }
      },
    })

    await renewer.start({
      shouldRenew: () => true,
      onCredentialRotated: async () => {
        applyCalls++
        if (applyCalls === 1) throw new Error('adapter stop raced')
      },
    })
    expect({ renewalCalls, applyCalls }).toEqual({ renewalCalls: 1, applyCalls: 1 })

    scheduledTick()
    await waitFor(() => applyCalls === 2 && renewalCalls === 2, {
      description: 'pending credential application retry',
    })

    await renewer.stop()
  })

  test('drains an in-flight write on stop and suppresses its adapter callback', async () => {
    let resolveRenewal: (result: RenewalAttempt) => void = () => {
      throw new Error('renewal promise resolver was not installed')
    }
    const renewal = new Promise<RenewalAttempt>((resolve) => {
      resolveRenewal = resolve
    })
    let applyCalls = 0
    let timerStopped = false
    const renewer = createManagedRuntimeCredentialRenewer({
      agentDir: '/runtime/agent',
      keyStore,
      logger: quietLogger,
      renew: async () => await renewal,
      schedule: () => ({ stop: () => void (timerStopped = true) }),
    })

    const starting = renewer.start({
      shouldRenew: () => true,
      onCredentialRotated: async () => void applyCalls++,
    })
    const stopping = renewer.stop()
    resolveRenewal(renewed())
    await Promise.all([starting, stopping])

    expect(timerStopped).toBe(true)
    expect(applyCalls).toBe(0)
  })
})
