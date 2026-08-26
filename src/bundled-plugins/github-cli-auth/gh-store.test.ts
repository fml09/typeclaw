import { describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  canonicalGithubRepoFromGitUrl,
  resolveGithubCliStoreToken,
  runBoundedGitCommand,
  type GhTokenCommandRunner,
} from './gh-store'

describe('canonicalGithubRepoFromGitUrl', () => {
  test.each([
    ['https://github.com/Acme/Widgets.git', 'acme/widgets'],
    ['git@github.com:Acme/Widgets.git', 'acme/widgets'],
    ['ssh://git@github.com/Acme/Widgets.git', 'acme/widgets'],
  ])('canonicalizes %s', (url, expected) => {
    expect(canonicalGithubRepoFromGitUrl(url)).toBe(expected)
  })

  test.each([
    'https://example.com/acme/widgets.git',
    'https://github.com/acme/widgets/extra',
    'https://github.com/-acme/widgets.git',
    'https://github.com/acme/..git',
  ])('rejects %s', (url) => {
    expect(canonicalGithubRepoFromGitUrl(url)).toBeNull()
  })
})

describe('resolveGithubCliStoreToken', () => {
  test('uses the active github.com gh account with a fixed trusted config dir and strips ambient auth', async () => {
    const root = await mkdtemp(join(tmpdir(), 'typeclaw-gh-store-token-'))
    const configDir = join(root, '.config', 'gh')
    await mkdir(configDir, { recursive: true })
    await writeFile(join(configDir, 'hosts.yml'), 'github.com:\n')
    let observed: Parameters<GhTokenCommandRunner>[0] | undefined
    const runner: GhTokenCommandRunner = async (options) => {
      observed = options
      return { exitCode: 0, stdout: 'gho_active_account\n' }
    }

    try {
      const token = await resolveGithubCliStoreToken(
        runner,
        {
          ...process.env,
          GH_TOKEN: 'ambient',
          GITHUB_TOKEN: 'ambient-alias',
          GH_ENTERPRISE_TOKEN: 'enterprise',
          GITHUB_ENTERPRISE_TOKEN: 'enterprise-alias',
          GH_HOST: 'example.test',
        },
        configDir,
      )

      expect(token).toBe('gho_active_account')
      expect(observed?.cmd).toEqual(['/usr/bin/gh', 'auth', 'token', '--hostname', 'github.com'])
      expect(observed?.env.GH_CONFIG_DIR).toBe(configDir)
      for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_HOST']) {
        expect(observed?.env[key]).toBeUndefined()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('rejects missing, error, multiline, NUL, and oversized output without exposing output', async () => {
    for (const result of [
      { exitCode: 1, stdout: 'secret-error' },
      { exitCode: 0, stdout: '' },
      { exitCode: 0, stdout: 'one\ntwo\n' },
      { exitCode: 0, stdout: 'one\0two' },
      { exitCode: 0, stdout: 'x'.repeat(20_000) },
    ]) {
      const runner: GhTokenCommandRunner = async () => result
      const root = await mkdtemp(join(tmpdir(), 'typeclaw-gh-store-output-'))
      const configDir = join(root, '.config', 'gh')
      await mkdir(configDir, { recursive: true })
      await writeFile(join(configDir, 'hosts.yml'), 'github.com:\n')
      try {
        expect(await resolveGithubCliStoreToken(runner, process.env, configDir)).toBeNull()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  })

  test('does not cache the live store result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'typeclaw-gh-store-refresh-'))
    const configDir = join(root, '.config', 'gh')
    await mkdir(configDir, { recursive: true })
    await writeFile(join(configDir, 'hosts.yml'), 'github.com:\n')
    let calls = 0
    const runner: GhTokenCommandRunner = async () => ({ exitCode: 0, stdout: `token-${++calls}\n` })
    try {
      expect(await resolveGithubCliStoreToken(runner, process.env, configDir)).toBe('token-1')
      expect(await resolveGithubCliStoreToken(runner, process.env, configDir)).toBe('token-2')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('rejects symlinked config parents and targets before invoking gh', async () => {
    for (const kind of ['config-parent', 'gh-parent', 'target'] as const) {
      const root = await mkdtemp(join(tmpdir(), 'typeclaw-gh-store-symlink-'))
      const configParent = join(root, '.config')
      const configDir = join(configParent, 'gh')
      const outside = join(root, 'outside')
      await mkdir(outside)
      if (kind === 'config-parent') await symlink(outside, configParent)
      else {
        await mkdir(configParent)
        if (kind === 'gh-parent') await symlink(outside, configDir)
        else {
          await mkdir(configDir)
          const outsideHosts = join(outside, 'hosts.yml')
          await writeFile(outsideHosts, 'github.com:\n')
          await symlink(outsideHosts, join(configDir, 'hosts.yml'))
        }
      }
      let called = false
      try {
        expect(
          await resolveGithubCliStoreToken(
            async () => {
              called = true
              return { exitCode: 0, stdout: 'unreachable\n' }
            },
            process.env,
            configDir,
          ),
        ).toBeNull()
        expect(called).toBe(false)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  })

  test('never resolves the credential-store gh command through PATH', async () => {
    const root = await mkdtemp(join(tmpdir(), 'typeclaw-gh-store-path-'))
    const configDir = join(root, '.config', 'gh')
    const binDir = join(root, 'bin')
    const marker = join(root, 'path-gh-ran')
    await mkdir(configDir, { recursive: true })
    await mkdir(binDir)
    await writeFile(join(configDir, 'hosts.yml'), 'github.com:\n')
    await writeFile(join(binDir, 'gh'), `#!/bin/sh\n: > "${marker}"\n`)
    await chmod(join(binDir, 'gh'), 0o755)

    try {
      await resolveGithubCliStoreToken(undefined, { ...process.env, PATH: binDir }, configDir)
      expect(
        await stat(marker).then(
          () => true,
          () => false,
        ),
      ).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe.skipIf(process.platform === 'win32')('bounded gh-store Git subprocess', () => {
  test('times out and settles without waiting for the child close event', async () => {
    const started = performance.now()
    const result = await runBoundedGitCommand({
      executable: '/bin/sh',
      args: ['-c', 'sleep 5'],
      env: process.env,
      timeoutMs: 30,
      maxStdoutBytes: 1024,
    })

    expect(result.ok).toBe(false)
    expect(performance.now() - started).toBeLessThan(500)
  })

  test('kills and fails closed when stdout exceeds the byte bound', async () => {
    const result = await runBoundedGitCommand({
      executable: '/bin/sh',
      args: ['-c', 'while :; do printf 0123456789; done'],
      env: process.env,
      timeoutMs: 1_000,
      maxStdoutBytes: 64,
    })

    expect(result).toEqual({ ok: false, code: -1, stdout: '' })
  })

  test('kills descendants in the timed-out process group', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-bounded-git-'))
    const marker = join(dir, 'descendant-survived')
    try {
      const result = await runBoundedGitCommand({
        executable: '/bin/sh',
        args: ['-c', '(sleep 0.15; : > "$MARKER") & sleep 5'],
        env: { ...process.env, MARKER: marker },
        timeoutMs: 30,
        maxStdoutBytes: 1024,
      })
      await Bun.sleep(300)

      expect(result.ok).toBe(false)
      expect(
        await stat(marker).then(
          () => true,
          () => false,
        ),
      ).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
