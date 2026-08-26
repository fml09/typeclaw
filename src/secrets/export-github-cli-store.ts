import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import type { GithubCliSecrets } from './schema'
import { SecretsBackend } from './storage'

const DIR_MODE = 0o700
const FILE_MODE = 0o600
const HOSTS_FILE_LIMIT = 256 * 1024

export type ExportGithubCliStoreResult =
  | { action: 'skipped'; reason: 'no-github-cli-credential' }
  | { action: 'wrote'; path: string }
  | { action: 'failed'; reason: string }

export type ExportGithubCliStoreOptions = {
  githubCli?: GithubCliSecrets
  homeDir?: string
  log?: (message: string) => void
}

export function exportGithubCliStoreIfApplicable(options: ExportGithubCliStoreOptions): ExportGithubCliStoreResult {
  const homeDir = options.homeDir ?? homedir()
  const target = join(homeDir, '.config', 'gh', 'hosts.yml')
  if (options.githubCli === undefined) {
    try {
      removeRuntimeStore(target, homeDir)
      return { action: 'skipped', reason: 'no-github-cli-credential' }
    } catch {
      return failedExport(options.log)
    }
  }
  try {
    validateHosts(options.githubCli.hosts)
    ensurePrivateDirectoryChain(dirname(target), homeDir)
    rejectUnsafeTarget(target)
    writeAtomic(target, options.githubCli.hosts)
    return { action: 'wrote', path: target }
  } catch {
    try {
      removeRuntimeStore(target, homeDir)
    } catch {
      // The original export failure remains the operator-facing cause.
    }
    return failedExport(options.log)
  }
}

export function exportGithubCliStoreForAgent(options: {
  agentDir: string
  homeDir?: string
  log?: (message: string) => void
}): ExportGithubCliStoreResult {
  try {
    const githubCli = new SecretsBackend(join(options.agentDir, 'secrets.json')).tryReadGithubCliSync()
    return exportGithubCliStoreIfApplicable({
      ...(githubCli !== undefined ? { githubCli } : {}),
      ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
      ...(options.log !== undefined ? { log: options.log } : {}),
    })
  } catch {
    try {
      removeRuntimeStore(join(options.homeDir ?? homedir(), '.config', 'gh', 'hosts.yml'), options.homeDir ?? homedir())
    } catch {
      // Reading failed first; cleanup is best-effort and must not mask that cause.
    }
    const reason = 'Could not read the stored trusted GitHub CLI credential.'
    options.log?.(`exportGithubCliStore: ${reason}`)
    return { action: 'failed', reason }
  }
}

function failedExport(log: ((message: string) => void) | undefined): ExportGithubCliStoreResult {
  const reason = 'Could not reconstruct the trusted GitHub CLI credential store.'
  log?.(`exportGithubCliStore: ${reason}`)
  return { action: 'failed', reason }
}

function validateHosts(hosts: string): void {
  if (hosts.length === 0 || hosts.includes('\0') || Buffer.byteLength(hosts) > HOSTS_FILE_LIMIT) {
    throw new Error('invalid GitHub CLI store')
  }
}

function ensurePrivateDirectoryChain(targetDir: string, homeDir: string): void {
  rejectNonDirectoryOrSymlink(homeDir)
  const configDir = join(homeDir, '.config')
  ensurePrivateDirectory(configDir)
  ensurePrivateDirectory(targetDir)
}

function ensurePrivateDirectory(path: string): void {
  if (existsSync(path)) rejectNonDirectoryOrSymlink(path)
  else mkdirSync(path, { mode: DIR_MODE })
  chmodSync(path, DIR_MODE)
}

function rejectNonDirectoryOrSymlink(path: string): void {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('unsafe GitHub CLI store directory')
}

function rejectUnsafeTarget(path: string): void {
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('unsafe GitHub CLI store target')
}

function removeRuntimeStore(target: string, homeDir: string): void {
  rejectNonDirectoryOrSymlink(homeDir)
  for (const path of [join(homeDir, '.config'), dirname(target)]) {
    if (!existsSync(path)) return
    rejectNonDirectoryOrSymlink(path)
  }
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error('unsafe GitHub CLI store target')
  unlinkSync(target)
}

function writeAtomic(target: string, hosts: string): void {
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
  const fd = openSync(tmp, 'wx', FILE_MODE)
  closeSync(fd)
  try {
    writeFileSync(tmp, hosts, { encoding: 'utf8', mode: FILE_MODE })
    renameSync(tmp, target)
    chmodSync(target, FILE_MODE)
  } catch (error) {
    try {
      unlinkSync(tmp)
    } catch {
      // best-effort cleanup after an atomic write failure
    }
    throw error
  }
}
