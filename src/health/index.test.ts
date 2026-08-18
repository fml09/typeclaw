import { describe, expect, test } from 'bun:test'

import { createRuntimeHealth } from './index'

describe('createRuntimeHealth', () => {
  test('keeps readiness false during startup, replacement, and shutdown', () => {
    const health = createRuntimeHealth()

    expect(health.snapshot()).toEqual({
      schemaVersion: 1,
      status: 'starting',
      ready: false,
      degraded: false,
      degradedComponents: [],
    })

    health.markReady()
    expect(health.snapshot()).toMatchObject({ status: 'ready', ready: true })

    health.markReplacementPending()
    expect(health.snapshot()).toMatchObject({ status: 'replacing', ready: false })

    health.markStopping()
    expect(health.snapshot()).toMatchObject({ status: 'stopping', ready: false })
  })

  test('remembers startup degradation when the runtime becomes ready', () => {
    const health = createRuntimeHealth()

    health.markDegraded('plugins')
    expect(health.snapshot()).toMatchObject({ status: 'starting', ready: false, degraded: true })

    health.markReady()
    expect(health.snapshot()).toEqual({
      schemaVersion: 1,
      status: 'degraded',
      ready: true,
      degraded: true,
      degradedComponents: ['plugins'],
    })
  })
})
