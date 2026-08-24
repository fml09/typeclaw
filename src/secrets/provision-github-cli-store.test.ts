import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  provisionGithubCliStore,
  resolveGithubCliExecutable,
  type GithubCliProvisionRunner,
} from './provision-github-cli-store'

const secretToken = 'test-sensitive-token'
const generatedHosts = 'github.com:\n  user: test-user\n  oauth_token: generated-value\n'
const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function agentDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'typeclaw-github-provision-'))
  dirs.push(dir)
  return dir
}

async function hostGh(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'typeclaw-host-gh-'))
  dirs.push(root)
  const executable = join(root, 'bin', process.platform === 'win32' ? 'gh.exe' : 'gh')
  await mkdir(dirname(executable), { recursive: true })
  await writeFile(executable, '#!/bin/sh\nexit 0\n')
  await chmod(executable, 0o755)
  return executable
}

describe('provisionGithubCliStore', () => {
  test('resolves with scrubbed auth env, delegates store generation to gh, and persists only hosts.yml', async () => {
    const cwd = await agentDir()
    const trustedGh = await hostGh()
    const canonicalTrustedGh = realpathSync(trustedGh)
    const calls: Parameters<GithubCliProvisionRunner>[0][] = []
    const runner: GithubCliProvisionRunner = (request) => {
      calls.push(request)
      if (request.args[1] === 'token') return { status: 0, stdout: `${secretToken}\n`, stderr: '' }
      writeFileSync(join(request.env.GH_CONFIG_DIR!, 'hosts.yml'), generatedHosts)
      return { status: 0, stdout: '', stderr: '' }
    }

    const result = provisionGithubCliStore({
      agentDir: cwd,
      env: {
        ...process.env,
        GH_TOKEN: 'ambient-one',
        GITHUB_TOKEN: 'ambient-two',
        GH_ENTERPRISE_TOKEN: 'ambient-three',
        GITHUB_ENTERPRISE_TOKEN: 'ambient-four',
        gh_token: 'ambient-five',
        Gh_Host: 'example.test',
        GH_CONFIG_DIR: '/operator/gh-config',
        PATH: dirname(trustedGh),
      },
      runner,
    })

    expect(result).toEqual({ ok: true })
    expect(calls).toHaveLength(2)
    expect(calls.map(({ command, args }) => [command, ...args])).toEqual([
      [canonicalTrustedGh, 'auth', 'token', '--hostname', 'github.com'],
      [
        canonicalTrustedGh,
        'auth',
        'login',
        '--hostname',
        'github.com',
        '--git-protocol',
        'https',
        '--with-token',
        '--insecure-storage',
      ],
    ])
    expect(calls[0]?.args).toEqual(['auth', 'token', '--hostname', 'github.com'])
    expect(calls[0]?.stdin).toBeUndefined()
    expect(calls[0]?.env).not.toHaveProperty('GH_TOKEN')
    expect(calls[0]?.env).not.toHaveProperty('GITHUB_TOKEN')
    expect(calls[0]?.env).not.toHaveProperty('GH_ENTERPRISE_TOKEN')
    expect(calls[0]?.env).not.toHaveProperty('GITHUB_ENTERPRISE_TOKEN')
    expect(calls[0]?.env).not.toHaveProperty('gh_token')
    expect(calls[0]?.env).not.toHaveProperty('Gh_Host')
    expect(calls[0]?.env.GH_CONFIG_DIR).toBe('/operator/gh-config')
    expect(calls[1]?.args).toEqual([
      'auth',
      'login',
      '--hostname',
      'github.com',
      '--git-protocol',
      'https',
      '--with-token',
      '--insecure-storage',
    ])
    expect(calls[1]?.stdin).toBe(`${secretToken}\n`)
    expect(Object.values(calls[1]?.env ?? {})).not.toContain(secretToken)
    expect(calls[1]?.env.GH_CONFIG_DIR).toContain('typeclaw-gh-provision-')
    expect(existsSync(calls[1]!.env.GH_CONFIG_DIR!)).toBe(false)

    const persisted = JSON.parse(await readFile(join(cwd, 'secrets.json'), 'utf8')) as Record<string, unknown>
    expect(persisted['githubCli']).toEqual({ hosts: generatedHosts })
    expect(JSON.stringify(persisted)).not.toContain(secretToken)
  })

  test('refreshes the active account on every invocation', async () => {
    const cwd = await agentDir()
    const trustedGh = await hostGh()
    let active = 'first'
    const runner: GithubCliProvisionRunner = (request) => {
      if (request.args[1] === 'token') return { status: 0, stdout: `${active}-token\n`, stderr: '' }
      writeFileSync(join(request.env.GH_CONFIG_DIR!, 'hosts.yml'), `github.com:\n  user: ${active}\n`)
      return { status: 0, stdout: '', stderr: '' }
    }

    expect(provisionGithubCliStore({ agentDir: cwd, env: { PATH: dirname(trustedGh) }, runner }).ok).toBe(true)
    active = 'second'
    expect(provisionGithubCliStore({ agentDir: cwd, env: { PATH: dirname(trustedGh) }, runner }).ok).toBe(true)

    const persisted = JSON.parse(await readFile(join(cwd, 'secrets.json'), 'utf8')) as {
      githubCli: { hosts: string }
    }
    expect(persisted.githubCli.hosts).toContain('user: second')
    expect(persisted.githubCli.hosts).not.toContain('user: first')
  })

  test.each([
    ['empty', ''],
    ['multiline', `${secretToken}\nsecond-line\n`],
    ['NUL', `${secretToken}\0\n`],
    ['oversized', `${'x'.repeat(20_000)}\n`],
  ])('rejects %s token output without persistence or disclosure', async (_name, stdout) => {
    const cwd = await agentDir()
    const trustedGh = await hostGh()
    const runner: GithubCliProvisionRunner = () => ({ status: 0, stdout, stderr: secretToken })

    const result = provisionGithubCliStore({ agentDir: cwd, env: { PATH: dirname(trustedGh) }, runner })

    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain(secretToken)
    expect(existsSync(join(cwd, 'secrets.json'))).toBe(false)
  })

  test('login failure cleans the private temp directory and does not disclose or persist the token', async () => {
    const cwd = await agentDir()
    const trustedGh = await hostGh()
    let tempConfig = ''
    const runner: GithubCliProvisionRunner = (request) => {
      if (request.args[1] === 'token') return { status: 0, stdout: `${secretToken}\n`, stderr: '' }
      tempConfig = request.env.GH_CONFIG_DIR!
      return { status: 1, stdout: secretToken, stderr: `failed ${secretToken}` }
    }

    const result = provisionGithubCliStore({ agentDir: cwd, env: { PATH: dirname(trustedGh) }, runner })

    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain(secretToken)
    expect(existsSync(tempConfig)).toBe(false)
    expect(existsSync(join(cwd, 'secrets.json'))).toBe(false)
  })

  test('rejects a symlinked generated hosts.yml instead of copying its target', async () => {
    const cwd = await agentDir()
    const trustedGh = await hostGh()
    const outside = join(cwd, 'outside-hosts.yml')
    await writeFile(outside, generatedHosts)
    const runner: GithubCliProvisionRunner = (request) => {
      if (request.args[1] === 'token') return { status: 0, stdout: `${secretToken}\n`, stderr: '' }
      symlinkSync(outside, join(request.env.GH_CONFIG_DIR!, 'hosts.yml'))
      return { status: 0, stdout: '', stderr: '' }
    }

    const result = provisionGithubCliStore({ agentDir: cwd, env: { PATH: dirname(trustedGh) }, runner })

    expect(result).toEqual({ ok: false, reason: 'GitHub CLI generated an invalid isolated credential store.' })
    expect(existsSync(join(cwd, 'secrets.json'))).toBe(false)
  })
})

describe('resolveGithubCliExecutable', () => {
  test('accepts an absolute regular gh.exe from Windows PATH', () => {
    const executable = String.raw`C:\Program Files\GitHub CLI\gh.exe`
    expect(
      resolveGithubCliExecutable({
        platform: 'win32',
        env: { PATH: String.raw`.;C:\Program Files\GitHub CLI` },
        isRegularExecutable: (candidate) => candidate === executable,
      })?.canonicalPath,
    ).toBe(executable)
  })

  test('rejects gh.cmd and never probes current-directory or command shims on Windows', () => {
    const probed: string[] = []
    expect(
      resolveGithubCliExecutable({
        platform: 'win32',
        env: { PATH: String.raw`.;C:\Tools` },
        isRegularExecutable: (candidate) => {
          probed.push(candidate)
          return candidate.toLocaleLowerCase().endsWith('gh.cmd')
        },
      }),
    ).toBeNull()
    expect(probed).toEqual([String.raw`C:\Tools\gh.exe`])
  })

  test('returns null when no absolute regular executable exists', () => {
    expect(
      resolveGithubCliExecutable({
        platform: 'linux',
        env: { PATH: 'relative:/missing' },
        isRegularExecutable: () => false,
      }),
    ).toBeNull()
  })

  test('resolves an absolute POSIX gh executable without current-directory lookup', () => {
    expect(
      resolveGithubCliExecutable({
        platform: 'linux',
        env: { PATH: ':/opt/github/bin:relative' },
        isRegularExecutable: (candidate) => candidate === '/opt/github/bin/gh',
      })?.canonicalPath,
    ).toBe('/opt/github/bin/gh')
  })

  test('rejects an executable resolved inside the agent or a writable mount, including through a symlinked PATH parent', async () => {
    const cwd = await agentDir()
    const mount = await agentDir()
    const agentGh = join(cwd, 'tools', 'gh')
    const mountGh = join(mount, 'tools', 'gh')
    await mkdir(dirname(agentGh), { recursive: true })
    await mkdir(dirname(mountGh), { recursive: true })
    await writeFile(agentGh, '#!/bin/sh\n')
    await writeFile(mountGh, '#!/bin/sh\n')
    await chmod(agentGh, 0o755)
    await chmod(mountGh, 0o755)
    const aliasRoot = await agentDir()
    const alias = join(aliasRoot, 'bin')
    await symlink(dirname(mountGh), alias)

    expect(resolveGithubCliExecutable({ env: { PATH: dirname(agentGh) }, deniedRoots: [cwd] })).toBeNull()
    expect(resolveGithubCliExecutable({ env: { PATH: alias }, deniedRoots: [mount] })).toBeNull()
  })

  test('allows a canonical executable under a read-only mount when that root is not denied', async () => {
    const readOnlyMount = await agentDir()
    const executable = join(readOnlyMount, 'bin', process.platform === 'win32' ? 'gh.exe' : 'gh')
    await mkdir(dirname(executable), { recursive: true })
    await writeFile(executable, '#!/bin/sh\n')
    await chmod(executable, 0o755)

    expect(resolveGithubCliExecutable({ env: { PATH: dirname(executable) }, deniedRoots: [] })?.canonicalPath).toBe(
      realpathSync(executable),
    )
  })

  test.skipIf(process.platform === 'win32')(
    'canonicalizes a package-manager gh symlink to its regular target',
    async () => {
      const root = await agentDir()
      const bin = join(root, 'bin')
      const libexec = join(root, 'libexec')
      await mkdir(bin)
      await mkdir(libexec)
      const target = join(libexec, 'gh')
      await writeFile(target, '#!/bin/sh\nexit 0\n')
      await chmod(target, 0o755)
      await symlink(target, join(bin, 'gh'))

      expect(resolveGithubCliExecutable({ env: { PATH: bin } })?.canonicalPath).toBe(realpathSync(target))
    },
  )
})

test('replacement between token and login fails before login runs or data persists', async () => {
  const cwd = await agentDir()
  const trustedGh = await hostGh()
  const calls: string[][] = []
  const runner: GithubCliProvisionRunner = (request) => {
    calls.push([request.command, ...request.args])
    const replacement = `${trustedGh}.replacement`
    writeFileSync(replacement, '#!/bin/sh\nexit 1\n')
    renameSync(replacement, trustedGh)
    return { status: 0, stdout: `${secretToken}\n`, stderr: '' }
  }

  const result = provisionGithubCliStore({ agentDir: cwd, env: { PATH: dirname(trustedGh) }, runner })

  expect(result).toEqual({ ok: false, reason: 'The trusted GitHub CLI executable changed before invocation.' })
  expect(calls).toEqual([[realpathSync(trustedGh), 'auth', 'token', '--hostname', 'github.com']])
  expect(existsSync(join(cwd, 'secrets.json'))).toBe(false)
})

test('provisioning fails before spawn when gh is missing', async () => {
  const cwd = await agentDir()
  let invoked = false
  const result = provisionGithubCliStore({
    agentDir: cwd,
    resolveExecutable: () => null,
    runner: () => {
      invoked = true
      return { status: 0, stdout: `${secretToken}\n`, stderr: '' }
    },
  })

  expect(result).toEqual({ ok: false, reason: 'Could not find a trusted GitHub CLI executable on the host PATH.' })
  expect(invoked).toBe(false)
  expect(existsSync(join(cwd, 'secrets.json'))).toBe(false)
})
