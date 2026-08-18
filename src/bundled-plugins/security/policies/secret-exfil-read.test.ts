import { describe, expect, test } from 'bun:test'

import { GUARD_SECRET_EXFIL_READ, checkSecretExfilReadGuard } from './secret-exfil-read'

describe('secret-exfil-read guard', () => {
  test('blocks read of .env', () => {
    expect(checkSecretExfilReadGuard({ tool: 'read', args: { path: '.env' } })?.block).toBe(true)
    expect(checkSecretExfilReadGuard({ tool: 'read', args: { path: './.env' } })?.block).toBe(true)
    expect(checkSecretExfilReadGuard({ tool: 'read', args: { path: '/agent/.env' } })?.block).toBe(true)
  })

  test('treats secrets.json as a sensitive basename', () => {
    expect(checkSecretExfilReadGuard({ tool: 'read', args: { path: 'secrets.json' } })?.block).toBe(true)
    expect(checkSecretExfilReadGuard({ tool: 'find', args: { path: '.', pattern: 'secrets.json' } })?.block).toBe(true)
  })

  test('blocks read of .env.production / .env.local', () => {
    expect(checkSecretExfilReadGuard({ tool: 'read', args: { path: '.env.production' } })?.block).toBe(true)
    expect(checkSecretExfilReadGuard({ tool: 'read', args: { path: 'config/.env.local' } })?.block).toBe(true)
  })

  test('blocks read of ~/.ssh/id_rsa', () => {
    expect(checkSecretExfilReadGuard({ tool: 'read', args: { path: '~/.ssh/id_rsa' } })?.block).toBe(true)
  })

  test('blocks ls ~/.ssh/', () => {
    expect(checkSecretExfilReadGuard({ tool: 'ls', args: { path: '~/.ssh' } })?.block).toBe(true)
    expect(checkSecretExfilReadGuard({ tool: 'ls', args: { path: '~/.ssh/' } })?.block).toBe(true)
  })

  test('blocks read of ~/.aws/credentials', () => {
    expect(checkSecretExfilReadGuard({ tool: 'read', args: { path: '~/.aws/credentials' } })?.block).toBe(true)
  })

  test('blocks read of ~/.netrc', () => {
    expect(checkSecretExfilReadGuard({ tool: 'read', args: { path: '~/.netrc' } })?.block).toBe(true)
  })

  test('blocks read of ~/.kube/config', () => {
    expect(checkSecretExfilReadGuard({ tool: 'read', args: { path: '~/.kube/config' } })?.block).toBe(true)
  })

  test('blocks read of ~/.docker/config.json', () => {
    expect(checkSecretExfilReadGuard({ tool: 'ls', args: { path: '~/.docker' } })?.block).toBe(true)
  })

  test('blocks read of ~/.gnupg/', () => {
    expect(checkSecretExfilReadGuard({ tool: 'find', args: { path: '~/.gnupg' } })?.block).toBe(true)
  })

  test('blocks read of ~/.hermes/config.yaml (agent credentials file)', () => {
    expect(checkSecretExfilReadGuard({ tool: 'read', args: { path: '~/.hermes/config.yaml' } })?.block).toBe(true)
  })

  test('blocks read of ~/.config/hermes/config.yaml (XDG-style agent credentials)', () => {
    expect(checkSecretExfilReadGuard({ tool: 'read', args: { path: '~/.config/hermes/config.yaml' } })?.block).toBe(
      true,
    )
  })

  test('blocks read of bash history', () => {
    expect(checkSecretExfilReadGuard({ tool: 'read', args: { path: '~/.bash_history' } })?.block).toBe(true)
    expect(checkSecretExfilReadGuard({ tool: 'read', args: { path: '~/.zsh_history' } })?.block).toBe(true)
  })

  test('blocks read of /proc/*/environ', () => {
    expect(checkSecretExfilReadGuard({ tool: 'read', args: { path: '/proc/self/environ' } })?.block).toBe(true)
    expect(checkSecretExfilReadGuard({ tool: 'read', args: { path: '/proc/1234/environ' } })?.block).toBe(true)
  })

  test('blocks find with sensitive path', () => {
    expect(checkSecretExfilReadGuard({ tool: 'find', args: { path: '~/.ssh', pattern: '*' } })?.block).toBe(true)
  })

  test('blocks grep with sensitive path', () => {
    expect(checkSecretExfilReadGuard({ tool: 'grep', args: { pattern: 'foo', path: '~/.ssh' } })?.block).toBe(true)
  })

  test('blocks paths in array form', () => {
    expect(checkSecretExfilReadGuard({ tool: 'read', args: { paths: ['notes.md', '.env'] } })?.block).toBe(true)
  })

  test('does not let a model-authored acknowledgement bypass a secret read', () => {
    const result = checkSecretExfilReadGuard({
      tool: 'read',
      args: { path: '.env', acknowledgeGuards: { secretExfilRead: true } },
    })
    expect(result?.block).toBe(true)
    expect(result?.reason).not.toContain('acknowledgeGuards')
  })

  test('allows reads of regular files', () => {
    expect(checkSecretExfilReadGuard({ tool: 'read', args: { path: 'README.md' } })).toBeUndefined()
    expect(checkSecretExfilReadGuard({ tool: 'read', args: { path: 'src/index.ts' } })).toBeUndefined()
    expect(checkSecretExfilReadGuard({ tool: 'read', args: { path: 'workspace/notes.md' } })).toBeUndefined()
  })

  test('allows ls of regular directories', () => {
    expect(checkSecretExfilReadGuard({ tool: 'ls', args: { path: 'src' } })).toBeUndefined()
    expect(checkSecretExfilReadGuard({ tool: 'ls', args: { path: '/agent/workspace' } })).toBeUndefined()
  })

  test('does not flag a file that just happens to mention "ssh" in a deeper path segment as a normal file', () => {
    expect(checkSecretExfilReadGuard({ tool: 'read', args: { path: 'src/ssh-helper.ts' } })).toBeUndefined()
    expect(checkSecretExfilReadGuard({ tool: 'read', args: { path: 'docs/ssh.md' } })).toBeUndefined()
  })

  test('does not apply to non-read-style tools', () => {
    expect(checkSecretExfilReadGuard({ tool: 'write', args: { path: '.env' } })).toBeUndefined()
    expect(checkSecretExfilReadGuard({ tool: 'bash', args: { path: '.env' } })).toBeUndefined()
  })

  test('handles non-string path gracefully', () => {
    expect(checkSecretExfilReadGuard({ tool: 'read', args: { path: 42 } })).toBeUndefined()
    expect(checkSecretExfilReadGuard({ tool: 'read', args: {} })).toBeUndefined()
  })

  test('exposes guard name constant', () => {
    expect(GUARD_SECRET_EXFIL_READ).toBe('secretExfilRead')
  })
})
