import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratchDirs: string[] = []
const resolver = join(import.meta.dir, 'resolve-release-source.sh')

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

function createRepository(): { dir: string; source: string } {
  const dir = mkdtempSync(join(tmpdir(), 'typeclaw-release-source-'))
  scratchDirs.push(dir)
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.name', 'TypeClaw Test')
  git(dir, 'config', 'user.email', 'test@typeclaw.dev')
  writePackage(dir, '1.0.0')
  git(dir, 'add', 'package.json')
  git(dir, 'commit', '-qm', 'initial')
  return { dir, source: git(dir, 'rev-parse', 'HEAD') }
}

function writePackage(dir: string, version: string): void {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'typeclaw', version, scripts: { test: 'bun test' } }))
}

function commitVersion(dir: string, version: string): string {
  writePackage(dir, version)
  git(dir, 'add', 'package.json')
  git(dir, 'commit', '-qm', version)
  return git(dir, 'rev-parse', 'HEAD')
}

function resolve(dir: string, version: string, head = 'HEAD'): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync(['bash', resolver, version, head], {
    cwd: dir,
    stdout: 'pipe',
    stderr: 'pipe',
  })
}

describe('resolve-release-source.sh', () => {
  test('recovers the reserved source after later main commits and selects that workspace', () => {
    const { dir, source } = createRepository()
    commitVersion(dir, '1.2.3')
    writeFileSync(join(dir, 'later.ts'), 'export const later = true\n')
    git(dir, 'add', 'later.ts')
    git(dir, 'commit', '-qm', 'later pull request')

    const result = resolve(dir, '1.2.3')
    expect(result.exitCode).toBe(0)
    expect(result.stdout?.toString().trim()).toBe(source)

    git(dir, 'checkout', '--detach', source)
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(source)
    expect(existsSync(join(dir, 'later.ts'))).toBe(false)
  })

  test('uses the requested head when no reservation exists', () => {
    const { dir } = createRepository()
    writeFileSync(join(dir, 'feature.ts'), 'export const feature = true\n')
    git(dir, 'add', 'feature.ts')
    git(dir, 'commit', '-qm', 'feature')
    const head = git(dir, 'rev-parse', 'HEAD')

    const result = resolve(dir, '1.2.3')
    expect(result.exitCode).toBe(0)
    expect(result.stdout?.toString().trim()).toBe(head)
  })

  test('fails closed when one first-parent history contains duplicate reservations', () => {
    const { dir } = createRepository()
    commitVersion(dir, '1.2.3')
    writePackage(dir, '1.0.0')
    git(dir, 'add', 'package.json')
    git(dir, 'commit', '-qm', 'continue development')
    commitVersion(dir, '1.2.3')

    const result = resolve(dir, '1.2.3')
    expect(result.exitCode).toBe(1)
    expect(result.stderr?.toString()).toContain('multiple exact release reservations')
  })
})
