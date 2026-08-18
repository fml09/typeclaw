import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CONTROLLER_UNSUPPORTED_REASON,
  createLocalDockerController,
  createNoopController,
  resolveController,
  resolveDeploymentProfile,
} from './controller'
import { containerNameFromCwd, type DockerExec, type DockerExecResult, imageTagFromCwd } from './shared'

function fakeExec(handler: (args: string[]) => DockerExecResult): DockerExec {
  return async (args) => handler(args)
}

describe('LocalDockerController', () => {
  test('status delegates to the docker inspect path via the injected exec', async () => {
    const root = await mkdtemp(join(tmpdir(), 'typeclaw-controller-'))
    try {
      const exec = fakeExec((args) => {
        if (args[0] === 'inspect') return { exitCode: 1, stdout: '', stderr: 'no such container' }
        return { exitCode: 0, stdout: '', stderr: '' }
      })

      const result = await createLocalDockerController().status({ cwd: root, exec })

      expect(result.kind).toBe('missing')
      expect(result.containerName).toBe(containerNameFromCwd(root))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('stop delegates to the docker stop/rm path via the injected exec', async () => {
    const root = await mkdtemp(join(tmpdir(), 'typeclaw-controller-'))
    try {
      const calls: string[][] = []
      const exec = fakeExec((args) => {
        calls.push(args)
        // First inspect: container is a stopped corpse. The post-rm
        // waitForRemoval poll then sees it gone so stop() returns promptly.
        if (args[0] === 'inspect') {
          const seenInspects = calls.filter((c) => c[0] === 'inspect').length
          return seenInspects === 1
            ? { exitCode: 0, stdout: `${'a'.repeat(64)}|false\n`, stderr: '' }
            : { exitCode: 1, stdout: '', stderr: 'no such container' }
        }
        return { exitCode: 0, stdout: '', stderr: '' }
      })

      const result = await createLocalDockerController().stop({
        cwd: root,
        exec,
        archiveLogs: async () => ({ ok: true, status: 'archived', path: '/archive.log' }),
      })

      expect(result.ok).toBe(true)
      expect(calls.some((c) => c[0] === 'rm')).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('NoopController', () => {
  const cwd = '/agent'

  test('start fails loud with the unsupported reason', async () => {
    const result = await createNoopController().start({ cwd, preferredHostPort: 8973 })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toContain(CONTROLLER_UNSUPPORTED_REASON)
    expect(result.reason).toContain('start')
  })

  test('stop fails loud with the unsupported reason', async () => {
    const result = await createNoopController().stop({ cwd })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toContain(CONTROLLER_UNSUPPORTED_REASON)
  })

  test('logs fails loud with the unsupported reason', async () => {
    const result = await createNoopController().logs({ cwd, follow: false })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toContain(CONTROLLER_UNSUPPORTED_REASON)
  })

  test('shell fails loud with the unsupported reason', async () => {
    const result = await createNoopController().shell({ cwd })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toContain(CONTROLLER_UNSUPPORTED_REASON)
  })

  test('status reports missing since typeclaw does not orchestrate the container', async () => {
    const result = await createNoopController().status({ cwd })
    expect(result.kind).toBe('missing')
    expect(result.containerName).toBe(containerNameFromCwd(cwd))
    expect(result.imageTag).toBe(imageTagFromCwd(cwd))
  })
})

describe('resolveController', () => {
  // Assert on behavior the OTHER controller can't satisfy (the controllers are
  // factory-made object literals with no class identity). The noop's status()
  // also returns { kind: 'missing' } and never touches `exec`, so a status-kind
  // check can't tell them apart — prove the host controller by observing it
  // shell out through the injected exec, and prove the noop by its fail-loud
  // reason, which the host controller never emits.
  test('managed profile resolves to the fail-loud noop (does not shell out)', async () => {
    const calls: string[][] = []
    const controller = resolveController('managed')
    const status = await controller.status({
      cwd: '/agent',
      exec: fakeExec((args) => {
        calls.push(args)
        return { exitCode: 1, stdout: '', stderr: 'no such container' }
      }),
    })
    const stop = await controller.stop({ cwd: '/agent' })

    expect(calls).toHaveLength(0) // noop never invokes exec
    expect(stop.ok).toBe(false)
    if (stop.ok) throw new Error('expected failure')
    expect(stop.reason).toContain(CONTROLLER_UNSUPPORTED_REASON)
  })

  test('host profile resolves to the real controller (shells out via exec, never fail-loud)', async () => {
    const calls: string[][] = []
    const controller = resolveController('host')
    await controller.status({
      cwd: '/agent',
      exec: fakeExec((args) => {
        calls.push(args)
        return { exitCode: 1, stdout: '', stderr: 'no such container' }
      }),
    })

    expect(calls.some((c) => c[0] === 'inspect')).toBe(true) // real controller shells out; noop can't
  })

  test('defaults to the host controller (no managed runtime yet)', async () => {
    const calls: string[][] = []
    await resolveController().status({
      cwd: '/agent',
      exec: fakeExec((args) => {
        calls.push(args)
        return { exitCode: 1, stdout: '', stderr: 'no such container' }
      }),
    })

    expect(calls.some((c) => c[0] === 'inspect')).toBe(true)
  })
})

describe('resolveDeploymentProfile', () => {
  test('defaults to host when the deployment profile is absent', () => {
    expect(resolveDeploymentProfile({})).toBe('host')
  })

  test('resolves the managed profile from the platform-injected environment', () => {
    expect(resolveDeploymentProfile({ TYPECLAW_DEPLOYMENT_PROFILE: 'managed' })).toBe('managed')
  })

  test('fails loud on an unknown deployment profile', () => {
    expect(() => resolveDeploymentProfile({ TYPECLAW_DEPLOYMENT_PROFILE: 'kubernetees' })).toThrow(
      'TYPECLAW_DEPLOYMENT_PROFILE',
    )
  })
})
