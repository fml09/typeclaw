import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import * as ts from '@typescript/typescript6'

import { hooklessGitArgs } from './hookless'

const RUNTIME_GIT_FILES = [
  'src/bundled-plugins/backup/runner.ts',
  'src/bundled-plugins/backup/index.ts',
  'src/bundled-plugins/memory/dreaming.ts',
  'src/git/system-commit.ts',
  'src/git/reconcile-ignored.ts',
  'src/doctor/commit.ts',
  'src/agent/git-nudge.ts',
  'src/bundled-plugins/guard/policies/uncommitted-changes.ts',
  'src/dreams/git.ts',
  'src/init/index.ts',
  'src/git/resolve-identity.ts',
] as const

const RUNTIME_COMMIT_PATHS = [
  'src/git/system-commit.ts',
  'src/bundled-plugins/backup/runner.ts',
  'src/bundled-plugins/memory/dreaming.ts',
  'src/doctor/commit.ts',
  'src/init/index.ts',
] as const

describe('runtime git invocation guard', () => {
  test('retrofitted committers import resolveAgentGit', async () => {
    for (const file of RUNTIME_GIT_FILES.filter((file) => file !== 'src/init/index.ts')) {
      const source = await readFile(join(process.cwd(), file), 'utf8')
      expect(source, file).toContain('resolveAgentGit')
    }
  })

  test('every runtime-owned direct git spawn disables hooks through the shared helper', async () => {
    for (const file of RUNTIME_GIT_FILES) {
      const source = await readFile(join(process.cwd(), file), 'utf8')
      expect(findBareGitSpawns(source, file), file).toEqual([])
    }
  })

  test('detects direct-array and multiline object spawn forms without hooklessGitArgs', () => {
    expect(findBareGitSpawns("Bun.spawn(['git', 'status'])", 'direct.ts')).toHaveLength(1)
    expect(
      findBareGitSpawns(`bun.spawn({\n  cmd: [\n    'git',\n    'commit',\n  ],\n})`, 'multiline.ts'),
    ).toHaveLength(1)
    expect(findBareGitSpawns("Bun.spawn(['git', ...hooklessGitArgs(['status'])])", 'safe.ts')).toEqual([])
  })

  test('enumerates every TypeClaw-owned commit path under the hookless invariant', async () => {
    for (const file of RUNTIME_COMMIT_PATHS) {
      const source = await readFile(join(process.cwd(), file), 'utf8')
      expect(source, file).toContain("'commit'")
      // The hookless invariant is satisfied either directly (a raw spawn using
      // hooklessGitArgs) or via the shared `runGit` helper, which applies
      // hooklessGitArgs internally AND drains both pipes to avoid fd leaks.
      const hookless = source.includes('hooklessGitArgs') || source.includes('runGit(')
      expect(hookless, file).toBe(true)
    }
  })

  test('places the hook override before repository-layout and subcommand args', () => {
    expect(hooklessGitArgs(['--git-dir', '/repo/gitdir', '--work-tree', '/repo/worktree', 'commit'])).toEqual([
      '-c',
      'core.hooksPath=/dev/null',
      '--git-dir',
      '/repo/gitdir',
      '--work-tree',
      '/repo/worktree',
      'commit',
    ])
  })
})

function findBareGitSpawns(source: string, fileName: string): number[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const lines: number[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isBunSpawn(node.expression)) {
      const command = commandArray(node.arguments[0])
      if (command !== undefined && isGitArray(command) && !usesHooklessGitArgs(command)) {
        lines.push(sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return lines
}

function isBunSpawn(expression: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(expression) &&
    expression.name.text === 'spawn' &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text.toLocaleLowerCase() === 'bun'
  )
}

function commandArray(argument: ts.Expression | undefined): ts.ArrayLiteralExpression | undefined {
  if (argument === undefined) return undefined
  if (ts.isArrayLiteralExpression(argument)) return argument
  if (!ts.isObjectLiteralExpression(argument)) return undefined
  for (const property of argument.properties) {
    if (!ts.isPropertyAssignment(property)) continue
    const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : undefined
    if (name === 'cmd' && ts.isArrayLiteralExpression(property.initializer)) return property.initializer
  }
  return undefined
}

function isGitArray(command: ts.ArrayLiteralExpression): boolean {
  const first = command.elements[0]
  return first !== undefined && ts.isStringLiteral(first) && first.text === 'git'
}

function usesHooklessGitArgs(command: ts.ArrayLiteralExpression): boolean {
  return command.elements.some(
    (element) =>
      ts.isSpreadElement(element) &&
      ts.isCallExpression(element.expression) &&
      ts.isIdentifier(element.expression.expression) &&
      element.expression.expression.text === 'hooklessGitArgs',
  )
}
