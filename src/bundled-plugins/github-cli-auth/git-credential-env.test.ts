import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildGitCredentialEnv } from './git-credential-env'

const git = Bun.which('git')
const gitExecutable = git ?? 'git'

// Linux-only by design, not convenience: the control case proves the leak by
// having git-remote-ext run `sh -c … > <path>`, and a Windows path through that
// redirection never lands the side-effect file, so the control would assert
// nothing. Brokered git runs only in the Linux container stage anyway.
const unsupportedHost = git === null || process.platform === 'win32'

test.skipIf(unsupportedHost)('blocks local https-to-ext rewrites from inheriting the brokered token', () => {
  const root = mkdtempSync(join(tmpdir(), 'typeclaw-git-protocol-'))
  const repo = join(root, 'repo')
  const pwned = join(root, 'pwned')
  const run = (args: string[], credentialEnv?: Record<string, string>) => {
    const env = { ...process.env, ...credentialEnv }
    if (credentialEnv !== undefined && !('GIT_ALLOW_PROTOCOL' in credentialEnv)) delete env.GIT_ALLOW_PROTOCOL
    return Bun.spawnSync([gitExecutable, ...args], { cwd: repo, env, stderr: 'pipe', stdout: 'pipe' })
  }

  try {
    expect(Bun.spawnSync([gitExecutable, 'init', repo], { stderr: 'pipe', stdout: 'pipe' }).exitCode).toBe(0)
    expect(run(['config', '--local', 'protocol.ext.allow', 'always']).exitCode).toBe(0)
    expect(
      run(['config', '--local', `url.ext::sh -c echo% PWNED% >% ${pwned} ignored-.insteadOf`, 'https://github.com/'])
        .exitCode,
    ).toBe(0)

    const protectedEnv = buildGitCredentialEnv('tok', '/nonexistent-askpass')
    const blocked = run(['ls-remote', 'https://github.com/acme/widgets.git'], protectedEnv)
    expect(blocked.exitCode).not.toBe(0)
    expect(new TextDecoder().decode(blocked.stderr)).toMatch(/transport ['"]ext['"] not allowed/i)
    expect(existsSync(pwned)).toBe(false)

    const controlEnv = buildGitCredentialEnv('tok', '/nonexistent-askpass')
    delete controlEnv.GIT_ALLOW_PROTOCOL
    run(['ls-remote', 'https://github.com/acme/widgets.git'], controlEnv)
    expect(existsSync(pwned)).toBe(true)
  } finally {
    rmSync(root, { force: true, recursive: true })
  }
})
