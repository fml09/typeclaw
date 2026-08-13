import { resolveAgentGit } from './resolve-agent-git'
import { runGit } from './run'

export type GitIdentity = { name: string; email: string }

const GIT_CONFIG_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
} as const

const GIT_REPOSITORY_ENV_NAMES = new Set([
  'GIT_COMMON_DIR',
  'GIT_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_WORK_TREE',
])

export async function resolveGitIdentity(cwd: string): Promise<GitIdentity | null> {
  const repo = resolveAgentGit(cwd)
  if (repo === null) return null

  const values = await readRepositoryIdentity(cwd, repo.gitArgs)
  const name = values.get('user.name')?.at(-1)?.trim() || null
  const email = values.get('user.email')?.at(-1)?.trim() || null
  return name !== null && email !== null ? { name, email } : null
}

async function readRepositoryIdentity(cwd: string, gitArgs: readonly string[]): Promise<Map<string, string[]>> {
  try {
    const result = await runGit(Bun, cwd, [...gitArgs, 'config', '--null', '--get-regexp', '^user\\.(name|email)$'], {
      env: { ...withoutGitOverrides(process.env), ...GIT_CONFIG_ENV },
    })
    if (result.exitCode !== 0) return new Map()
    return parseNullConfigEntries(result.stdout)
  } catch {
    return new Map()
  }
}

function parseNullConfigEntries(output: string): Map<string, string[]> {
  const values = new Map<string, string[]>()
  for (const entry of output.split('\0')) {
    if (entry.length === 0) continue
    const separator = entry.indexOf('\n')
    if (separator < 0) continue
    const key = entry.slice(0, separator)
    const value = entry.slice(separator + 1)
    const existing = values.get(key)
    if (existing === undefined) values.set(key, [value])
    else existing.push(value)
  }
  return values
}

function withoutGitOverrides(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => {
      const normalized = name.toUpperCase()
      return !normalized.startsWith('GIT_CONFIG') && !GIT_REPOSITORY_ENV_NAMES.has(normalized)
    }),
  )
}

export const _internal = { withoutGitOverrides }
