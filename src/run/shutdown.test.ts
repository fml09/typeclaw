import { describe, expect, test } from 'bun:test'

import { createRuntimeShutdownHandler } from './shutdown'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('createRuntimeShutdownHandler', () => {
  test('lowers readiness synchronously and waits for handoff before teardown and exit', async () => {
    const handoff = deferred()
    const events: string[] = []
    const handler = createRuntimeShutdownHandler({
      markStopping: () => events.push('not-ready'),
      prepareHandoff: async () => {
        events.push('handoff:start')
        await handoff.promise
        events.push('handoff:done')
      },
      stop: async () => {
        events.push('stop')
      },
      exit: (code) => events.push(`exit:${code}`),
      setDeadline: () => ({ unref: () => {} }),
      clearDeadline: () => events.push('deadline:clear'),
    })

    handler()
    expect(events).toEqual(['not-ready', 'handoff:start'])

    handoff.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(events).toEqual(['not-ready', 'handoff:start', 'handoff:done', 'stop', 'deadline:clear', 'exit:0'])
  })

  test('coalesces duplicate SIGTERM delivery and exits after best-effort failures', async () => {
    const events: string[] = []
    const handler = createRuntimeShutdownHandler({
      markStopping: () => events.push('not-ready'),
      prepareHandoff: async () => {
        events.push('handoff')
        throw new Error('handoff failed')
      },
      stop: async () => {
        events.push('stop')
        throw new Error('stop failed')
      },
      exit: (code) => events.push(`exit:${code}`),
      setDeadline: () => ({ unref: () => {} }),
      clearDeadline: () => events.push('deadline:clear'),
    })

    handler()
    handler()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(events).toEqual(['not-ready', 'handoff', 'stop', 'deadline:clear', 'exit:0'])
  })
})
