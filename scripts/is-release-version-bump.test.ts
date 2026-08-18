import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratchDirs: string[] = []
const validator = join(import.meta.dir, 'is-release-version-bump.sh')

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

function createRepository(): { dir: string; parent: string } {
  const dir = mkdtempSync(join(tmpdir(), 'typeclaw-release-bump-'))
  scratchDirs.push(dir)
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.name', 'TypeClaw Test')
  git(dir, 'config', 'user.email', 'test@typeclaw.dev')
  writeFileSync(
    dir + '/package.json',
    JSON.stringify({ name: 'typeclaw', version: '1.0.0', scripts: { test: 'bun test' } }),
  )
  git(dir, 'add', 'package.json')
  git(dir, 'commit', '-qm', 'initial')
  return { dir, parent: git(dir, 'rev-parse', 'HEAD') }
}

function validate(dir: string, parent: string, version: string): number {
  return Bun.spawnSync(['bash', validator, parent, 'HEAD', version], {
    cwd: dir,
    stdout: 'pipe',
    stderr: 'pipe',
  }).exitCode
}

describe('is-release-version-bump.sh', () => {
  test('accepts the exact package version-only commit', () => {
    const { dir, parent } = createRepository()
    writeFileSync(
      dir + '/package.json',
      JSON.stringify({ name: 'typeclaw', version: '1.2.3', scripts: { test: 'bun test' } }),
    )
    git(dir, 'add', 'package.json')
    git(dir, 'commit', '-qm', '1.2.3')

    expect(validate(dir, parent, '1.2.3')).toBe(0)
  })

  test('accepts a symbolic parent revision used by release recovery', () => {
    const { dir } = createRepository()
    writeFileSync(
      dir + '/package.json',
      JSON.stringify({ name: 'typeclaw', version: '1.2.3', scripts: { test: 'bun test' } }),
    )
    git(dir, 'add', 'package.json')
    git(dir, 'commit', '-qm', '1.2.3')

    expect(validate(dir, 'HEAD^', '1.2.3')).toBe(0)
  })

  test('rejects a commit that changes package metadata alongside the version', () => {
    const { dir, parent } = createRepository()
    writeFileSync(
      dir + '/package.json',
      JSON.stringify({ name: 'typeclaw', version: '1.2.3', scripts: { test: 'false' } }),
    )
    git(dir, 'add', 'package.json')
    git(dir, 'commit', '-qm', '1.2.3')

    expect(validate(dir, parent, '1.2.3')).toBe(1)
  })
})
