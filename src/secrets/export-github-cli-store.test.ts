import { describe, expect, test } from 'bun:test'
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isWindows } from '@/shared'

import { exportGithubCliStoreForAgent, exportGithubCliStoreIfApplicable } from './export-github-cli-store'

const onWindows = isWindows()
const hosts = 'github.com:\n  user: test-user\n  oauth_token: test-value\n'

async function withDirs(fn: (agentDir: string, homeDir: string) => void | Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'typeclaw-github-export-'))
  const agentDir = join(root, 'agent')
  const homeDir = join(root, 'home')
  mkdirSync(agentDir)
  mkdirSync(homeDir)
  try {
    await fn(agentDir, homeDir)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('exportGithubCliStoreIfApplicable', () => {
  test('reconstructs an ephemeral runtime store atomically with private permissions', async () => {
    await withDirs((_agentDir, homeDir) => {
      const result = exportGithubCliStoreIfApplicable({ githubCli: { hosts }, homeDir })
      const configDir = join(homeDir, '.config', 'gh')
      const target = join(configDir, 'hosts.yml')

      expect(result).toEqual({ action: 'wrote', path: target })
      expect(readFileSync(target, 'utf8')).toBe(hosts)
      if (!onWindows) {
        expect(statSync(configDir).mode & 0o777).toBe(0o700)
        expect(statSync(target).mode & 0o777).toBe(0o600)
      }

      rmSync(join(homeDir, '.config'), { recursive: true, force: true })
      expect(exportGithubCliStoreIfApplicable({ githubCli: { hosts }, homeDir }).action).toBe('wrote')
      expect(readFileSync(target, 'utf8')).toBe(hosts)
    })
  })

  test('missing stored credential is a non-fatal skip', async () => {
    await withDirs((_agentDir, homeDir) => {
      const configDir = join(homeDir, '.config', 'gh')
      mkdirSync(configDir, { recursive: true })
      writeFileSync(join(configDir, 'hosts.yml'), hosts)
      expect(exportGithubCliStoreIfApplicable({ homeDir })).toEqual({
        action: 'skipped',
        reason: 'no-github-cli-credential',
      })
      expect(existsSync(join(configDir, 'hosts.yml'))).toBe(false)
    })
  })

  test('missing stored credential unlinks a stale target symlink without following it', async () => {
    if (onWindows) return
    await withDirs((_agentDir, homeDir) => {
      const configDir = join(homeDir, '.config', 'gh')
      const outside = join(homeDir, 'outside-hosts.yml')
      mkdirSync(configDir, { recursive: true })
      writeFileSync(outside, hosts)
      symlinkSync(outside, join(configDir, 'hosts.yml'))

      expect(exportGithubCliStoreIfApplicable({ homeDir })).toEqual({
        action: 'skipped',
        reason: 'no-github-cli-credential',
      })
      expect(existsSync(join(configDir, 'hosts.yml'))).toBe(false)
      expect(readFileSync(outside, 'utf8')).toBe(hosts)
    })
  })

  test.each(['config-parent', 'gh-parent', 'target'] as const)(
    'rejects a %s symlink without writing through it',
    async (kind) => {
      if (onWindows) return
      await withDirs((_agentDir, homeDir) => {
        const outside = join(homeDir, 'outside')
        mkdirSync(outside)
        if (kind === 'config-parent') symlinkSync(outside, join(homeDir, '.config'))
        else {
          mkdirSync(join(homeDir, '.config'))
          if (kind === 'gh-parent') symlinkSync(outside, join(homeDir, '.config', 'gh'))
          else {
            mkdirSync(join(homeDir, '.config', 'gh'))
            symlinkSync(join(outside, 'captured'), join(homeDir, '.config', 'gh', 'hosts.yml'))
          }
        }

        const result = exportGithubCliStoreIfApplicable({ githubCli: { hosts }, homeDir })

        expect(result.action).toBe('failed')
        expect(existsSync(join(outside, 'captured'))).toBe(false)
        expect(lstatSync(outside).isDirectory()).toBe(true)
        expect(JSON.stringify(result)).not.toContain(hosts)
      })
    },
  )

  test('agent wrapper reads the durable slice and reports corrupt secrets without leaking contents', async () => {
    await withDirs((agentDir, homeDir) => {
      writeFileSync(join(agentDir, 'secrets.json'), JSON.stringify({ version: 2, githubCli: { hosts } }))
      expect(exportGithubCliStoreForAgent({ agentDir, homeDir }).action).toBe('wrote')

      const corrupt = 'not-json-sensitive-value'
      writeFileSync(join(agentDir, 'secrets.json'), corrupt)
      const result = exportGithubCliStoreForAgent({ agentDir, homeDir })
      expect(result.action).toBe('failed')
      expect(JSON.stringify(result)).not.toContain(corrupt)
      expect(existsSync(join(homeDir, '.config', 'gh', 'hosts.yml'))).toBe(false)
    })
  })
})
