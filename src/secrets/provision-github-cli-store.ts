import { spawnSync } from 'node:child_process'
import {
  accessSync,
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  type BigIntStats,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix, win32 } from 'node:path'

import { SecretsBackend } from './storage'

const COMMAND_TIMEOUT_MS = 15_000
const TOKEN_OUTPUT_LIMIT = 16 * 1024
const HOSTS_FILE_LIMIT = 256 * 1024
const PRIVATE_DIR_MODE = 0o700
const AUTH_ENV_NAMES = new Set([
  'gh_token',
  'github_token',
  'gh_enterprise_token',
  'github_enterprise_token',
  'gh_host',
])

export type GithubCliProvisionRequest = {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  stdin?: string
  timeoutMs: number
  maxOutputBytes: number
}

export type GithubCliProvisionRunner = (request: GithubCliProvisionRequest) => {
  status: number | null
  stdout: string
  stderr: string
}

export type GithubCliProvisionResult = { ok: true } | { ok: false; reason: string }

export type ProvisionGithubCliStoreOptions = {
  agentDir: string
  deniedRoots?: readonly string[]
  env?: NodeJS.ProcessEnv
  runner?: GithubCliProvisionRunner
  resolveExecutable?: GithubCliExecutableResolver
  revalidateExecutable?: (identity: GithubCliExecutableIdentity) => boolean
}

export type GithubCliExecutableIdentity = {
  canonicalPath: string
  dev: bigint
  ino: bigint
  mode: bigint
  size: bigint
  ctimeNs: bigint
  mtimeNs: bigint
}

export type GithubCliExecutableResolver = (
  options: ResolveGithubCliExecutableOptions,
) => GithubCliExecutableIdentity | null

export type ResolveGithubCliExecutableOptions = {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  deniedRoots?: readonly string[]
  isRegularExecutable?: (path: string) => boolean
}

export function provisionGithubCliStore(options: ProvisionGithubCliStoreOptions): GithubCliProvisionResult {
  const runner = options.runner ?? runGithubCli
  const hostEnv = scrubGithubAuthEnv(options.env ?? process.env)
  const resolveOptions = { env: hostEnv, deniedRoots: options.deniedRoots ?? [] }
  const executable =
    options.resolveExecutable !== undefined
      ? options.resolveExecutable(resolveOptions)
      : resolveGithubCliExecutable(resolveOptions)
  if (executable === null) return failed('Could not find a trusted GitHub CLI executable on the host PATH.')
  const revalidate = options.revalidateExecutable ?? revalidateGithubCliExecutable
  const tokenResult = runPinnedGithubCli(runner, executable, revalidate, {
    command: executable.canonicalPath,
    args: ['auth', 'token', '--hostname', 'github.com'],
    env: hostEnv,
    timeoutMs: COMMAND_TIMEOUT_MS,
    maxOutputBytes: TOKEN_OUTPUT_LIMIT,
  })
  if (tokenResult === null) return failed('The trusted GitHub CLI executable changed before invocation.')
  if (tokenResult.status !== 0) return failed('Could not read the active host github.com GitHub CLI credential.')

  const token = validateTokenOutput(tokenResult.stdout)
  if (token === null) return failed('The active host github.com GitHub CLI credential was invalid.')

  let configDir: string | undefined
  try {
    configDir = mkdtempSync(join(tmpdir(), 'typeclaw-gh-provision-'))
    chmodSync(configDir, PRIVATE_DIR_MODE)
    const loginResult = runPinnedGithubCli(runner, executable, revalidate, {
      command: executable.canonicalPath,
      args: [
        'auth',
        'login',
        '--hostname',
        'github.com',
        '--git-protocol',
        'https',
        '--with-token',
        '--insecure-storage',
      ],
      env: { ...hostEnv, GH_CONFIG_DIR: configDir },
      stdin: `${token}\n`,
      timeoutMs: COMMAND_TIMEOUT_MS,
      maxOutputBytes: TOKEN_OUTPUT_LIMIT,
    })
    if (loginResult === null) return failed('The trusted GitHub CLI executable changed before invocation.')
    if (loginResult.status !== 0) return failed('GitHub CLI could not generate the isolated credential store.')

    const hosts = readGeneratedHosts(join(configDir, 'hosts.yml'))
    if (hosts === null) return failed('GitHub CLI generated an invalid isolated credential store.')
    new SecretsBackend(join(options.agentDir, 'secrets.json')).writeGithubCliSync({ hosts })
    return { ok: true }
  } catch {
    return failed('GitHub CLI credential provisioning failed.')
  } finally {
    if (configDir !== undefined) rmSync(configDir, { recursive: true, force: true })
  }
}

function runGithubCli(request: GithubCliProvisionRequest): ReturnType<GithubCliProvisionRunner> {
  const result = spawnSync(request.command, request.args, {
    encoding: 'utf8',
    env: request.env,
    input: request.stdin,
    timeout: request.timeoutMs,
    maxBuffer: request.maxOutputBytes,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  return {
    status: result.status,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
  }
}

export function resolveGithubCliExecutable(
  options: ResolveGithubCliExecutableOptions = {},
): GithubCliExecutableIdentity | null {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const pathApi = platform === 'win32' ? win32 : posix
  const pathValue = env.PATH ?? Object.entries(env).find(([key]) => key.toLocaleLowerCase() === 'path')?.[1]
  if (pathValue === undefined) return null
  const executableName = platform === 'win32' ? 'gh.exe' : 'gh'
  const deniedRoots = canonicalizeDeniedRoots(options.deniedRoots ?? [], pathApi)
  if (deniedRoots === null) return null

  for (const rawEntry of pathValue.split(pathApi.delimiter)) {
    const entry = unquotePathEntry(rawEntry)
    if (entry === '' || !pathApi.isAbsolute(entry)) continue
    const candidate = pathApi.join(entry, executableName)
    const basename = pathApi.basename(candidate)
    const nameMatches = platform === 'win32' ? basename.toLocaleLowerCase() === 'gh.exe' : basename === executableName
    if (!pathApi.isAbsolute(candidate) || !nameMatches) continue
    if (options.isRegularExecutable !== undefined) {
      if (!options.isRegularExecutable(candidate) || isInsideAnyRoot(candidate, deniedRoots, pathApi)) continue
      return syntheticExecutableIdentity(candidate)
    }
    const identity = inspectGithubCliExecutable(candidate, platform)
    if (identity === null || isInsideAnyRoot(identity.canonicalPath, deniedRoots, pathApi)) continue
    return identity
  }
  return null
}

function unquotePathEntry(entry: string): string {
  return entry.length >= 2 && entry.startsWith('"') && entry.endsWith('"') ? entry.slice(1, -1) : entry
}

function inspectGithubCliExecutable(path: string, platform: NodeJS.Platform): GithubCliExecutableIdentity | null {
  try {
    const canonicalPath = realpathSync(path)
    const pathApi = platform === 'win32' ? win32 : posix
    const expectedName = platform === 'win32' ? 'gh.exe' : 'gh'
    const actualName = pathApi.basename(canonicalPath)
    if (!pathApi.isAbsolute(canonicalPath)) return null
    if (platform === 'win32' ? actualName.toLocaleLowerCase() !== expectedName : actualName !== expectedName)
      return null
    const canonical = lstatSync(canonicalPath, { bigint: true })
    if (canonical.isSymbolicLink() || !canonical.isFile()) return null
    if (platform !== 'win32') accessSync(canonicalPath, fsConstants.X_OK)
    return identityFromStats(canonicalPath, canonical)
  } catch {
    return null
  }
}

function revalidateGithubCliExecutable(identity: GithubCliExecutableIdentity): boolean {
  const current = inspectGithubCliExecutable(identity.canonicalPath, process.platform)
  return current !== null && executableIdentitiesEqual(identity, current)
}

function runPinnedGithubCli(
  runner: GithubCliProvisionRunner,
  identity: GithubCliExecutableIdentity,
  revalidate: (identity: GithubCliExecutableIdentity) => boolean,
  request: GithubCliProvisionRequest,
): ReturnType<GithubCliProvisionRunner> | null {
  if (!revalidate(identity)) return null
  return runner(request)
}

function canonicalizeDeniedRoots(roots: readonly string[], pathApi: typeof posix | typeof win32): string[] | null {
  const canonical: string[] = []
  try {
    for (const root of roots) {
      if (!pathApi.isAbsolute(root)) return null
      canonical.push(realpathSync(root))
    }
    return canonical
  } catch {
    return null
  }
}

function isInsideAnyRoot(candidate: string, roots: readonly string[], pathApi: typeof posix | typeof win32): boolean {
  const normalizedCandidate = platformComparablePath(candidate, pathApi)
  return roots.some((root) => {
    const normalizedRoot = platformComparablePath(root, pathApi)
    const rel = pathApi.relative(normalizedRoot, normalizedCandidate)
    return rel === '' || (!rel.startsWith(`..${pathApi.sep}`) && rel !== '..' && !pathApi.isAbsolute(rel))
  })
}

function platformComparablePath(path: string, pathApi: typeof posix | typeof win32): string {
  return pathApi === win32 ? path.toLocaleLowerCase() : path
}

function identityFromStats(canonicalPath: string, stats: BigIntStats): GithubCliExecutableIdentity {
  return {
    canonicalPath,
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    size: stats.size,
    ctimeNs: stats.ctimeNs,
    mtimeNs: stats.mtimeNs,
  }
}

function executableIdentitiesEqual(a: GithubCliExecutableIdentity, b: GithubCliExecutableIdentity): boolean {
  return (
    a.canonicalPath === b.canonicalPath &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.mode === b.mode &&
    a.size === b.size &&
    a.ctimeNs === b.ctimeNs &&
    a.mtimeNs === b.mtimeNs
  )
}

function syntheticExecutableIdentity(canonicalPath: string): GithubCliExecutableIdentity {
  return { canonicalPath, dev: 0n, ino: 0n, mode: 0n, size: 0n, ctimeNs: 0n, mtimeNs: 0n }
}

function scrubGithubAuthEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = { ...env }
  for (const name of Object.keys(clean)) {
    if (AUTH_ENV_NAMES.has(name.toLocaleLowerCase())) delete clean[name]
  }
  return clean
}

function validateTokenOutput(stdout: string): string | null {
  if (Buffer.byteLength(stdout) > TOKEN_OUTPUT_LIMIT || stdout.includes('\0')) return null
  const normalized = stdout.endsWith('\r\n')
    ? stdout.slice(0, -2)
    : stdout.endsWith('\n')
      ? stdout.slice(0, -1)
      : stdout
  if (normalized.length === 0 || normalized.includes('\r') || normalized.includes('\n')) return null
  return normalized
}

function readGeneratedHosts(path: string): string | null {
  let fd: number | undefined
  try {
    const before = lstatSync(path)
    if (before.isSymbolicLink() || !before.isFile()) return null
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    const opened = fstatSync(fd)
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size === 0 ||
      opened.size > HOSTS_FILE_LIMIT
    ) {
      return null
    }
    const hosts = readFileSync(fd, 'utf8')
    if (hosts.length === 0 || hosts.includes('\0') || Buffer.byteLength(hosts) > HOSTS_FILE_LIMIT) return null
    return hosts
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function failed(reason: string): GithubCliProvisionResult {
  return { ok: false, reason }
}
