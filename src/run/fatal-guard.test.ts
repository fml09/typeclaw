import { afterEach, describe, expect, test } from 'bun:test'

import { classifyFatalError, installFatalGuard } from './fatal-guard'

const silentLogger = { warn: () => {}, error: () => {} }

let dispose: (() => void) | null = null

afterEach(() => {
  dispose?.()
  dispose = null
})

function install(options: Parameters<typeof installFatalGuard>[0] = {}) {
  const handle = installFatalGuard({ logger: silentLogger, ...options })
  dispose = handle.dispose
  return handle
}

describe('classifyFatalError', () => {
  test('uncaughtException always restarts', () => {
    expect(classifyFatalError('uncaughtException', new Error('boom'))).toEqual({
      action: 'restart',
      reason: 'uncaught exception',
    })
  })

  test('webex KMS code is recoverable and scoped to webex', () => {
    const err = Object.assign(new Error('KMS request timed out'), { code: 'KMS_ERROR' })
    expect(classifyFatalError('unhandledRejection', err)).toEqual({
      action: 'continue',
      scope: 'webex',
      reason: 'webex async dependency rejection',
    })
  })

  test('webex-message-handler stack provenance is recoverable', () => {
    const err = new Error('timed out')
    err.stack = 'Error: timed out\n    at <anonymous> (/agent/node_modules/webex-message-handler/dist/index.mjs:783:16)'
    expect(classifyFatalError('unhandledRejection', err)).toMatchObject({ action: 'continue', scope: 'webex' })
  })

  test('generic agent-messenger provenance degrades the channel scope', () => {
    const err = new Error('socket hung up')
    err.stack = 'Error\n    at (/agent/node_modules/agent-messenger/slack/index.mjs:10:1)'
    expect(classifyFatalError('unhandledRejection', err)).toMatchObject({ action: 'continue', scope: 'channel' })
  })

  test('unknown rejection escalates to restart', () => {
    expect(classifyFatalError('unhandledRejection', new Error('something unrelated'))).toEqual({
      action: 'restart',
      reason: 'unknown unhandled rejection',
    })
  })

  test('non-Error rejection values do not throw and escalate to restart', () => {
    expect(classifyFatalError('unhandledRejection', 'plain string reason')).toMatchObject({ action: 'restart' })
    expect(classifyFatalError('unhandledRejection', undefined)).toMatchObject({ action: 'restart' })
  })
})

describe('installFatalGuard', () => {
  test('a known channel rejection degrades and does NOT request restart', () => {
    const degraded: Array<{ scope: string; reason: string }> = []
    let restartCalls = 0
    const { guard } = install({
      onDegrade: (scope, reason) => degraded.push({ scope, reason }),
      requestRestart: async () => {
        restartCalls++
        return { ok: true }
      },
    })

    guard.handle('unhandledRejection', Object.assign(new Error('kms'), { code: 'KMS_ERROR' }))

    expect(degraded).toEqual([{ scope: 'webex', reason: 'webex async dependency rejection' }])
    expect(restartCalls).toBe(0)
  })

  test('an uncaughtException requests a restart', async () => {
    const reasons: string[] = []
    let replacementPending = 0
    const { guard } = install({
      onReplacementPending: () => replacementPending++,
      requestRestart: async (reason) => {
        reasons.push(reason)
        return { ok: true }
      },
    })

    guard.handle('uncaughtException', new Error('corrupt'))
    await Promise.resolve()

    expect(reasons).toEqual(['uncaught exception'])
    expect(replacementPending).toBe(1)
  })

  test('marks replacement pending before waiting for managed control acknowledgement', async () => {
    const events: string[] = []
    let acknowledge: ((result: { ok: boolean }) => void) | undefined
    const { guard } = install({
      onReplacementPending: () => events.push('not-ready'),
      requestRestart: () =>
        new Promise((resolve) => {
          events.push('request-started')
          acknowledge = resolve
        }),
    })

    guard.handle('uncaughtException', new Error('corrupt'))
    expect(events).toEqual(['not-ready', 'request-started'])

    acknowledge?.({ ok: true })
    await Promise.resolve()
  })

  test('restart requests are rate-limited within the min interval', () => {
    let clock = 0
    let restartCalls = 0
    const { guard } = install({
      now: () => clock,
      restartMinIntervalMs: 1000,
      requestRestart: async () => {
        restartCalls++
        return { ok: true }
      },
    })

    guard.handle('uncaughtException', new Error('a'))
    clock = 500
    guard.handle('uncaughtException', new Error('b'))
    expect(restartCalls).toBe(1)

    clock = 1500
    guard.handle('uncaughtException', new Error('c'))
    expect(restartCalls).toBe(2)
  })

  test('missing requestRestart marks the whole runtime degraded instead of throwing', () => {
    const degraded: Array<{ scope: string; reason: string }> = []
    const { guard } = install({ onDegrade: (scope, reason) => degraded.push({ scope, reason }) })
    expect(() => guard.handle('uncaughtException', new Error('no host daemon'))).not.toThrow()
    expect(degraded).toEqual([{ scope: 'runtime', reason: 'uncaught exception; replacement control is unavailable' }])
  })

  test('a rejected restart marks the whole runtime degraded', async () => {
    const degraded: Array<{ scope: string; reason: string }> = []
    const { guard } = install({
      onDegrade: (scope, reason) => degraded.push({ scope, reason }),
      requestRestart: async () => ({ ok: false, reason: 'relay unavailable' }),
    })

    guard.handle('uncaughtException', new Error('corrupt'))
    await Promise.resolve()
    await Promise.resolve()

    expect(degraded).toEqual([
      { scope: 'runtime', reason: 'uncaught exception; replacement unavailable: relay unavailable' },
    ])
  })

  test('a throwing onDegrade is contained', () => {
    const { guard } = install({
      onDegrade: () => {
        throw new Error('degrade exploded')
      },
    })
    expect(() =>
      guard.handle('unhandledRejection', Object.assign(new Error('kms'), { code: 'KMS_ERROR' })),
    ).not.toThrow()
  })

  test('a rejecting requestRestart is contained and marks runtime degraded', async () => {
    const degraded: Array<{ scope: string; reason: string }> = []
    const { guard } = install({
      onDegrade: (scope, reason) => degraded.push({ scope, reason }),
      requestRestart: async () => {
        throw new Error('hostd unreachable')
      },
    })
    guard.handle('uncaughtException', new Error('boom'))
    await Promise.resolve()
    await Promise.resolve()
    expect(degraded).toEqual([
      { scope: 'runtime', reason: 'uncaught exception; replacement request threw: Error: hostd unreachable' },
    ])
  })

  test('installed handlers fire on real process events and never exit', () => {
    const seen: string[] = []
    install({ onDegrade: (scope) => seen.push(scope), requestRestart: async () => ({ ok: true }) })

    const err = Object.assign(new Error('kms'), { code: 'KMS_ERROR' })
    process.emit('unhandledRejection', err, Promise.resolve())

    expect(seen).toEqual(['webex'])
  })

  test('dispose removes the process listeners', () => {
    const before = process.listenerCount('unhandledRejection')
    const { dispose: disposeGuard } = install({})
    expect(process.listenerCount('unhandledRejection')).toBe(before + 1)
    disposeGuard()
    dispose = null
    expect(process.listenerCount('unhandledRejection')).toBe(before)
  })
})
