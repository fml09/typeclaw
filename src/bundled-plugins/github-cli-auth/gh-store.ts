import { spawn, type ChildProcess } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { lstat, mkdtemp, open, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

import {
  CONTAINER_RUNTIME_HOME,
  formatCommand,
  mapVirtualTmpPath,
  SESSION_TMP_ROOT,
  sessionTmpDir,
  type SandboxMount,
} from '@/sandbox'

import type { GitCommandDecision } from './git-command'

const GH_CONFIG_DIR = `${CONTAINER_RUNTIME_HOME}/.config/gh`
const TRUSTED_GH_EXECUTABLE = '/usr/bin/gh'
const GH_TOKEN_OUTPUT_LIMIT = 16 * 1024
const GH_TOKEN_TIMEOUT_MS = 5_000
const GIT_TIMEOUT_MS = 2_000
const GIT_STDOUT_LIMIT = 64 * 1024
const PROCESS_KILL_SETTLE_MS = 250
const GITHUB_OWNER_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/
const GITHUB_REPOSITORY_PATTERN = /^(?!\.\.?$)[a-z0-9._-]{1,100}$/
const GITHUB_URL_PATTERNS = [
  /^https:\/\/github\.com\/([^/\s:@]+)\/([^/\s?#]+?)(?:\.git)?\/?$/i,
  /^git@github\.com:([^/\s:?#]+)\/([^/\s?#]+?)(?:\.git)?$/i,
  /^ssh:\/\/git@github\.com\/([^/\s:?#]+)\/([^/\s?#]+?)(?:\.git)?\/?$/i,
] as const
const AMBIENT_GH_AUTH_KEYS = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'GH_HOST',
] as const

export type PreparedGithubStorePush = {
  command: string
  env: Record<string, string>
  backingGitDir: string
  mount: SandboxMount
}

export type GithubStorePushPlan = {
  askpassPath: string
  worktreeRoot: DirectoryIdentity
  sourceCwd: DirectoryIdentity
  sourceCwdSandboxPath: string
  gitDir: DirectoryIdentity
  commonDir: DirectoryIdentity
  objects: DirectoryIdentity
  objectsSandboxPath: string
  objectFormat: 'sha1' | 'sha256'
  shallow: ShallowMetadata
  repo: string
  remote: string
  requestedRefspecs: string[]
  refspecs: ReconstructedRefspecs
}

export type GhTokenCommandOptions = {
  cmd: string[]
  env: NodeJS.ProcessEnv
  timeoutMs: number
  maxStdoutBytes: number
}

export function canonicalGithubRepoFromGitUrl(raw: string): string | null {
  const url = raw.trim()
  for (const pattern of GITHUB_URL_PATTERNS) {
    const match = pattern.exec(url)
    if (match === null) continue
    const owner = match[1]?.toLocaleLowerCase()
    const repo = match[2]?.toLocaleLowerCase()
    if (
      owner === undefined ||
      repo === undefined ||
      !GITHUB_OWNER_PATTERN.test(owner) ||
      !GITHUB_REPOSITORY_PATTERN.test(repo)
    ) {
      return null
    }
    return `${owner}/${repo}`
  }
  return null
}

export type GhTokenCommandRunner = (
  options: GhTokenCommandOptions,
) => Promise<{ exitCode: number; stdout: string } | null>

let ghTokenCommandRunnerForTests: GhTokenCommandRunner | undefined

export function setGhTokenCommandRunnerForTests(runner: GhTokenCommandRunner | undefined): void {
  ghTokenCommandRunnerForTests = runner
}

export async function resolveGithubCliStoreToken(
  runner: GhTokenCommandRunner | undefined = undefined,
  parentEnv: NodeJS.ProcessEnv = process.env,
  configDir: string = GH_CONFIG_DIR,
): Promise<string | null> {
  if (!(await isSafeGithubCliStore(configDir))) return null
  const env: NodeJS.ProcessEnv = { ...parentEnv, GH_CONFIG_DIR: configDir }
  for (const key of AMBIENT_GH_AUTH_KEYS) delete env[key]

  const result = await (runner ?? ghTokenCommandRunnerForTests ?? runGhTokenCommand)({
    cmd: [TRUSTED_GH_EXECUTABLE, 'auth', 'token', '--hostname', 'github.com'],
    env,
    timeoutMs: GH_TOKEN_TIMEOUT_MS,
    maxStdoutBytes: GH_TOKEN_OUTPUT_LIMIT,
  })
  if (result === null || result.exitCode !== 0) return null
  if (Buffer.byteLength(result.stdout) > GH_TOKEN_OUTPUT_LIMIT || result.stdout.includes('\0')) return null

  const token = result.stdout.endsWith('\r\n')
    ? result.stdout.slice(0, -2)
    : result.stdout.endsWith('\n')
      ? result.stdout.slice(0, -1)
      : result.stdout
  if (token === '' || token.trim() !== token || token.includes('\n') || token.includes('\r')) return null
  return token
}

async function isSafeGithubCliStore(configDir: string): Promise<boolean> {
  const hostsPath = join(configDir, 'hosts.yml')
  for (const path of [dirname(dirname(configDir)), dirname(configDir), configDir, hostsPath]) {
    try {
      const metadata = await lstat(path)
      const isTarget = path === hostsPath
      if (metadata.isSymbolicLink() || (isTarget ? !metadata.isFile() : !metadata.isDirectory())) return false
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
      return false
    }
  }
  return true
}

export const GH_STORE_AMBIENT_AUTH_KEYS: readonly string[] = AMBIENT_GH_AUTH_KEYS

const STORE_GIT_CONFIG: readonly [string, string][] = [
  ['core.hooksPath', '/dev/null'],
  ['core.askPass', ''],
  ['credential.helper', ''],
  ['credential.useHttpPath', 'true'],
  ['http.followRedirects', 'false'],
  ['http.sslVerify', 'true'],
  ['http.proxy', ''],
  ['protocol.allow', 'never'],
  ['protocol.https.allow', 'always'],
]

const CLEAN_GIT_BASE_ENV: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  LANG: process.env.LANG,
  LC_ALL: process.env.LC_ALL,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_PARAMETERS: '',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
}

export async function planGithubStorePush(
  decision: GitCommandDecision,
  options: { agentDir: string; sessionId: string; askpassPath: string },
): Promise<GithubStorePushPlan | null> {
  if (decision.kind !== 'inject' || decision.access !== 'write') return null
  const provenance = decision.pushProvenance
  if (
    provenance?.kind !== 'configured-remote' ||
    !provenance.complete ||
    provenance.worktreeTopLevel === null ||
    provenance.pushUrls.length !== 1 ||
    provenance.repoSlugs.length !== 1 ||
    provenance.setUpstream
  ) {
    return null
  }
  const repo = canonicalGithubRepoFromGitUrl(provenance.pushUrls[0] as string)
  if (
    repo === null ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ||
    decision.repoSlug.toLocaleLowerCase() !== repo ||
    provenance.repoSlugs[0] !== repo
  ) {
    return null
  }

  try {
    const mappedSourceCwd = mapVirtualTmpPath(options.agentDir, options.sessionId, provenance.sourceCwd)
    const physicalSessionTmp = mappedSourceCwd === undefined ? null : await physicalSessionTmpDir(options.sessionId)
    const worktreeRoot = await canonicalDirectory(provenance.worktreeTopLevel)
    const sourceCwd = await canonicalDirectory(mappedSourceCwd ?? provenance.sourceCwd)
    if (!isWithin(worktreeRoot.path, sourceCwd.path)) return null
    if (physicalSessionTmp !== null && !isWithin(physicalSessionTmp, sourceCwd.path)) return null

    const gitDirOutput = await sourceGitOutput(sourceCwd.path, ['rev-parse', '--absolute-git-dir'])
    const commonDirOutput = await sourceGitOutput(sourceCwd.path, ['rev-parse', '--git-common-dir'])
    const objectFormatOutput = await sourceGitOutput(sourceCwd.path, ['rev-parse', '--show-object-format'])
    if (gitDirOutput === null || commonDirOutput === null || !isObjectFormat(objectFormatOutput)) return null
    const gitDir = await canonicalDirectory(resolveReportedPath(sourceCwd.path, gitDirOutput))
    const commonDir = await canonicalDirectory(resolveReportedPath(sourceCwd.path, commonDirOutput))
    const objects = await canonicalDirectory(join(commonDir.path, 'objects'))
    if (
      physicalSessionTmp !== null &&
      [worktreeRoot, gitDir, commonDir, objects].some((directory) => !isWithin(physicalSessionTmp, directory.path))
    ) {
      return null
    }
    const sourceCwdSandboxPath =
      mappedSourceCwd === undefined ? sourceCwd.path : resolve(options.agentDir, provenance.sourceCwd)
    const objectsSandboxPath =
      physicalSessionTmp === null ? objects.path : sandboxVisiblePath(physicalSessionTmp, objects.path)
    if (objectsSandboxPath.includes(':') || objectsSandboxPath.includes('\n') || objectsSandboxPath.includes('\r')) {
      return null
    }
    if (!(await configuredRemoteMatchesTarget(gitDir.path, provenance.remote, repo))) return null
    const shallow = await captureShallowMetadata(sourceCwd.path, gitDir.path, commonDir.path)

    const refspecs = await reconstructRefspecs({
      gitDir: gitDir.path,
      remote: provenance.remote,
      requested: provenance.refspecs,
    })
    if (refspecs === null || refspecs.values.length === 0) return null

    return {
      askpassPath: options.askpassPath,
      worktreeRoot,
      sourceCwd,
      sourceCwdSandboxPath,
      gitDir,
      commonDir,
      objects,
      objectsSandboxPath,
      objectFormat: objectFormatOutput,
      shallow,
      repo,
      remote: provenance.remote,
      requestedRefspecs: [...provenance.refspecs],
      refspecs,
    }
  } catch {
    return null
  }
}

export async function prepareGithubStorePush(plan: GithubStorePushPlan): Promise<PreparedGithubStorePush | null> {
  let backingGitDir: string | null = null
  let completed = false
  try {
    await assertDirectoryIdentity(plan.worktreeRoot)
    await assertDirectoryIdentity(plan.sourceCwd)
    await assertDirectoryIdentity(plan.gitDir)
    await assertDirectoryIdentity(plan.commonDir)
    await assertDirectoryIdentity(plan.objects)
    if ((await sourceGitOutput(plan.sourceCwd.path, ['rev-parse', '--show-object-format'])) !== plan.objectFormat) {
      return null
    }
    if (!(await shallowMetadataMatches(plan.shallow))) return null
    if (!(await configuredRemoteMatchesTarget(plan.gitDir.path, plan.remote, plan.repo))) return null

    const currentRefspecs = await reconstructRefspecs({
      gitDir: plan.gitDir.path,
      remote: plan.remote,
      requested: plan.requestedRefspecs,
    })
    if (currentRefspecs === null || !sameRefspecs(plan.refspecs, currentRefspecs)) return null

    backingGitDir = await mkdtemp(join(tmpdir(), 'typeclaw-gh-store-push-'))
    if (!(await runGit(['init', '--bare', '--quiet', `--object-format=${plan.objectFormat}`, backingGitDir])).ok)
      return null
    if (plan.shallow.file !== null) {
      await writeFile(join(backingGitDir, 'shallow'), plan.shallow.file.content, { flag: 'wx', mode: 0o444 })
    }
    const alternateEnv = { GIT_ALTERNATE_OBJECT_DIRECTORIES: plan.objects.path }
    for (const ref of currentRefspecs.refs) {
      const updated = await runGit(['--git-dir', backingGitDir, 'update-ref', ref.name, ref.oid], alternateEnv)
      if (!updated.ok) return null
    }
    if (currentRefspecs.head !== null) {
      const head = await runGit(
        ['--git-dir', backingGitDir, 'symbolic-ref', 'HEAD', currentRefspecs.head],
        alternateEnv,
      )
      if (!head.ok) return null
    }
    await assertDirectoryIdentity(plan.objects)
    if ((await sourceGitOutput(plan.sourceCwd.path, ['rev-parse', '--show-object-format'])) !== plan.objectFormat) {
      return null
    }
    if (!(await shallowMetadataMatches(plan.shallow))) return null

    const virtualGitDir = `/tmp/${basename(backingGitDir)}`
    const destination = `https://github.com/${plan.repo}.git`
    const command = formatCommand([
      '/usr/bin/git',
      '--git-dir',
      virtualGitDir,
      'push',
      destination,
      ...currentRefspecs.values,
    ])
    const configEnv = Object.fromEntries(
      STORE_GIT_CONFIG.flatMap(([key, value], index) => [
        [`GIT_CONFIG_KEY_${index}`, key],
        [`GIT_CONFIG_VALUE_${index}`, key === 'core.askPass' ? plan.askpassPath : value],
      ]),
    )
    completed = true
    return {
      command,
      backingGitDir,
      mount: { type: 'ro-bind', source: backingGitDir, dest: virtualGitDir },
      env: {
        GIT_DIR: virtualGitDir,
        GIT_ALTERNATE_OBJECT_DIRECTORIES: plan.objectsSandboxPath,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_PARAMETERS: '',
        GIT_ALLOW_PROTOCOL: 'https',
        GIT_CONFIG_COUNT: String(STORE_GIT_CONFIG.length),
        ...configEnv,
        HTTP_PROXY: '',
        HTTPS_PROXY: '',
        ALL_PROXY: '',
        http_proxy: '',
        https_proxy: '',
        all_proxy: '',
      },
    }
  } catch {
    return null
  } finally {
    if (backingGitDir !== null && !completed) await rm(backingGitDir, { recursive: true, force: true })
  }
}

export async function cleanupPreparedGithubStorePush(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true })
}

export type DirectoryIdentity = { path: string; dev: number; ino: number }
export type ShallowMetadata = {
  path: string
  parent: DirectoryIdentity
  file: null | { dev: number; ino: number; content: string }
}
export type ReconstructedRefspecs = {
  values: string[]
  refs: Array<{ name: string; oid: string }>
  head: string | null
}

function sameRefspecs(left: ReconstructedRefspecs, right: ReconstructedRefspecs): boolean {
  if (
    left.head !== right.head ||
    left.values.length !== right.values.length ||
    left.refs.length !== right.refs.length
  ) {
    return false
  }
  if (left.values.some((value, index) => value !== right.values[index])) return false
  return left.refs.every((ref, index) => {
    const candidate = right.refs[index]
    return candidate !== undefined && ref.name === candidate.name && ref.oid === candidate.oid
  })
}

async function canonicalDirectory(path: string): Promise<DirectoryIdentity> {
  const canonical = await realpath(path)
  const linkInfo = await lstat(canonical)
  const info = await stat(canonical)
  if (linkInfo.isSymbolicLink() || !info.isDirectory()) throw new Error('not a stable directory')
  return { path: canonical, dev: info.dev, ino: info.ino }
}

async function assertDirectoryIdentity(expected: DirectoryIdentity): Promise<void> {
  const canonical = await realpath(expected.path)
  const info = await stat(canonical)
  if (canonical !== expected.path || !info.isDirectory() || info.dev !== expected.dev || info.ino !== expected.ino) {
    throw new Error('directory identity changed')
  }
}

async function captureShallowMetadata(sourceCwd: string, gitDir: string, commonDir: string): Promise<ShallowMetadata> {
  const reported = await sourceGitOutput(sourceCwd, ['rev-parse', '--git-path', 'shallow'])
  if (reported === null) throw new Error('could not resolve shallow metadata')
  const unresolved = resolveReportedPath(sourceCwd, reported)
  const parent = await canonicalDirectory(dirname(unresolved))
  if (!isWithin(gitDir, parent.path) && !isWithin(commonDir, parent.path)) {
    throw new Error('shallow metadata escaped the repository')
  }
  const path = join(parent.path, basename(unresolved))
  return { path, parent, file: await readShallowFile(path) }
}

async function shallowMetadataMatches(expected: ShallowMetadata): Promise<boolean> {
  try {
    await assertDirectoryIdentity(expected.parent)
    const current = await readShallowFile(expected.path)
    if (expected.file === null || current === null) return expected.file === current
    return (
      expected.file.dev === current.dev &&
      expected.file.ino === current.ino &&
      expected.file.content === current.content
    )
  } catch {
    return false
  }
}

async function readShallowFile(path: string): Promise<ShallowMetadata['file']> {
  let before: Awaited<ReturnType<typeof lstat>>
  try {
    before = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  if (before.isSymbolicLink() || !before.isFile()) throw new Error('unsafe shallow metadata')

  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error('shallow metadata identity changed')
    }
    const content = await handle.readFile('utf8')
    if (!isValidShallowContent(content)) throw new Error('malformed shallow metadata')
    return { dev: opened.dev, ino: opened.ino, content }
  } finally {
    await handle.close()
  }
}

function isValidShallowContent(content: string): boolean {
  if (content === '' || content.includes('\0') || content.includes('\r')) return false
  const lines = (content.endsWith('\n') ? content.slice(0, -1) : content).split('\n')
  if (lines.some((line) => !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(line))) return false
  return lines.every((line) => line.length === lines[0]?.length)
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

async function physicalSessionTmpDir(sessionId: string): Promise<string> {
  const lexical = sessionTmpDir(sessionId)
  if (!isWithin(SESSION_TMP_ROOT, lexical)) throw new Error('session id escaped the session tmp root')
  return join(await realpath('/tmp'), relative('/tmp', lexical))
}

function sandboxVisiblePath(physicalSessionTmp: string, physicalPath: string): string {
  if (physicalPath === physicalSessionTmp) return '/tmp'
  if (!isWithin(physicalSessionTmp, physicalPath)) throw new Error('path escaped the session tmp root')
  return join('/tmp', relative(physicalSessionTmp, physicalPath))
}

function isObjectFormat(value: string | null): value is 'sha1' | 'sha256' {
  return value === 'sha1' || value === 'sha256'
}

function resolveReportedPath(cwd: string, reported: string): string {
  if (reported === '' || reported.includes('\0') || reported.includes('\n') || reported.includes('\r')) {
    throw new Error('invalid git path')
  }
  return isAbsolute(reported) ? reported : resolve(cwd, reported)
}

async function reconstructRefspecs(options: {
  gitDir: string
  remote: string
  requested: readonly string[]
}): Promise<ReconstructedRefspecs | null> {
  let requested = [...options.requested]
  if (requested.length === 0) {
    const configured = await sourceGitResult(options.gitDir, ['config', '--get-all', `remote.${options.remote}.push`])
    if (configured.ok && configured.stdout.trim() !== '') {
      requested = configured.stdout.trim().split(/\r?\n/)
    } else if (configured.code !== 1) {
      return null
    }
  }

  let head: string | null = null
  if (requested.length === 0) {
    head = await sourceGitDirOutput(options.gitDir, ['symbolic-ref', '-q', 'HEAD'])
    if (head === null || !head.startsWith('refs/heads/')) return null
    const modeResult = await sourceGitResult(options.gitDir, ['config', '--get', 'push.default'])
    const mode = modeResult.ok ? modeResult.stdout.trim() : 'simple'
    if (modeResult.code !== 0 && modeResult.code !== 1) return null
    if (mode === 'nothing' || mode === 'matching') return null
    if (mode === 'upstream' || mode === 'simple' || mode === '') {
      const branch = head.slice('refs/heads/'.length)
      const branchRemote = await sourceGitDirOutput(options.gitDir, ['config', '--get', `branch.${branch}.remote`])
      const merge = await sourceGitDirOutput(options.gitDir, ['config', '--get', `branch.${branch}.merge`])
      if (branchRemote !== options.remote || merge === null || !merge.startsWith('refs/heads/')) return null
      if (mode !== 'upstream' && merge.slice('refs/heads/'.length) !== branch) return null
      requested = [`${head}:${merge}`]
    } else if (mode === 'current') {
      requested = [`${head}:${head}`]
    } else {
      return null
    }
  }

  const refs = new Map<string, string>()
  const values: string[] = []
  for (const raw of requested) {
    const reconstructed = await reconstructOneRefspec(options.gitDir, raw)
    if (reconstructed === null) return null
    values.push(reconstructed.value)
    if (reconstructed.ref !== null) refs.set(reconstructed.ref.name, reconstructed.ref.oid)
    if (reconstructed.head !== null) head = reconstructed.head
  }
  return { values, refs: [...refs].map(([name, oid]) => ({ name, oid })), head }
}

async function reconstructOneRefspec(
  gitDir: string,
  raw: string,
): Promise<{ value: string; ref: { name: string; oid: string } | null; head: string | null } | null> {
  if (raw === '' || raw.includes('\n') || raw.includes('\r') || raw.includes('\0') || raw.includes('*')) return null
  const force = raw.startsWith('+')
  const body = force ? raw.slice(1) : raw
  const colon = body.indexOf(':')
  if (colon !== body.lastIndexOf(':')) return null
  const source = colon === -1 ? body : body.slice(0, colon)
  const requestedDestination = colon === -1 ? '' : body.slice(colon + 1)
  if (source === '') {
    const destination = await normalizeDestination(gitDir, requestedDestination)
    return destination === null ? null : { value: `:${destination}`, ref: null, head: null }
  }

  let sourceRef: string
  let head: string | null = null
  if (source === 'HEAD') {
    const resolvedHead = await sourceGitDirOutput(gitDir, ['symbolic-ref', '-q', 'HEAD'])
    if (resolvedHead === null || !resolvedHead.startsWith('refs/heads/')) return null
    sourceRef = resolvedHead
    head = resolvedHead
  } else if (source.startsWith('refs/heads/') || source.startsWith('refs/tags/')) {
    sourceRef = source
  } else if (/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(source)) {
    const symbolic = await sourceGitDirOutput(gitDir, ['rev-parse', '--symbolic-full-name', '--verify', source])
    if (symbolic === null || (!symbolic.startsWith('refs/heads/') && !symbolic.startsWith('refs/tags/'))) return null
    sourceRef = symbolic
  } else {
    return null
  }
  if (!(await validRef(sourceRef))) return null
  const oid = await sourceGitDirOutput(gitDir, ['rev-parse', '--verify', `${sourceRef}^{object}`])
  if (oid === null || !/^[0-9a-f]{40,64}$/i.test(oid)) return null
  const destination = await normalizeDestination(
    gitDir,
    requestedDestination === '' ? sourceRef : requestedDestination,
    sourceRef.startsWith('refs/tags/') ? 'tags' : 'heads',
  )
  if (destination === null) return null
  return {
    value: `${force ? '+' : ''}${sourceRef}:${destination}`,
    ref: { name: sourceRef, oid },
    head,
  }
}

async function normalizeDestination(gitDir: string, raw: string, namespace?: 'heads' | 'tags'): Promise<string | null> {
  if (!raw.startsWith('refs/') && namespace === undefined) return null
  const destination = raw.startsWith('refs/') ? raw : `refs/${namespace}/${raw}`
  return (await validRef(destination, gitDir)) ? destination : null
}

async function validRef(ref: string, gitDir?: string): Promise<boolean> {
  const result = await runGit([...(gitDir === undefined ? [] : ['--git-dir', gitDir]), 'check-ref-format', ref])
  return result.ok
}

async function sourceGitOutput(cwd: string, args: string[]): Promise<string | null> {
  const result = await runGit(['-C', cwd, ...args])
  return result.ok ? singleLine(result.stdout) : null
}

async function sourceGitDirOutput(gitDir: string, args: string[]): Promise<string | null> {
  const result = await sourceGitResult(gitDir, args)
  return result.ok ? singleLine(result.stdout) : null
}

async function sourceGitResult(gitDir: string, args: string[]): Promise<GitRunResult> {
  return await runGit(['--git-dir', gitDir, ...args])
}

async function configuredRemoteMatchesTarget(gitDir: string, remote: string, repo: string): Promise<boolean> {
  const result = await sourceGitResult(gitDir, ['remote', 'get-url', '--push', '--all', remote])
  if (!result.ok) return false
  const urls = result.stdout.trim().split(/\r?\n/).filter(Boolean)
  return urls.length === 1 && canonicalGithubRepoFromGitUrl(urls[0] as string) === repo
}

function singleLine(output: string): string | null {
  const trimmed = output.trim()
  return trimmed === '' || trimmed.includes('\n') || trimmed.includes('\r') || trimmed.includes('\0') ? null : trimmed
}

export type GitRunResult = { ok: boolean; code: number; stdout: string }

export type BoundedGitCommandOptions = {
  executable: string
  args: string[]
  env: NodeJS.ProcessEnv
  timeoutMs: number
  maxStdoutBytes: number
}

async function runGit(args: string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<GitRunResult> {
  return await runBoundedGitCommand({
    executable: '/usr/bin/git',
    args,
    env: { ...CLEAN_GIT_BASE_ENV, ...extraEnv },
    timeoutMs: GIT_TIMEOUT_MS,
    maxStdoutBytes: GIT_STDOUT_LIMIT,
  })
}

export async function runBoundedGitCommand(options: BoundedGitCommandOptions): Promise<GitRunResult> {
  return await new Promise((resolveResult) => {
    const child = spawn(options.executable, options.args, {
      detached: process.platform !== 'win32',
      env: options.env,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const chunks: Buffer[] = []
    let bytes = 0
    let settled = false
    let terminated = false
    let settleTimer: ReturnType<typeof setTimeout> | undefined
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined
    const finish = (result: GitRunResult): void => {
      if (settled) return
      settled = true
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer)
      if (settleTimer !== undefined) clearTimeout(settleTimer)
      resolveResult(result)
    }
    const terminate = (): void => {
      if (settleTimer !== undefined || settled) return
      terminated = true
      killChildProcessGroup(child)
      settleTimer = setTimeout(() => finish({ ok: false, code: -1, stdout: '' }), PROCESS_KILL_SETTLE_MS)
    }
    timeoutTimer = setTimeout(terminate, options.timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes <= options.maxStdoutBytes) chunks.push(chunk)
      else {
        terminate()
      }
    })
    child.on('error', () => finish({ ok: false, code: -1, stdout: '' }))
    child.on('close', (code) => {
      if (terminated) return finish({ ok: false, code: -1, stdout: '' })
      const exitCode = code ?? -1
      finish({
        ok: exitCode === 0 && bytes <= options.maxStdoutBytes,
        code: exitCode,
        stdout: Buffer.concat(chunks).toString('utf8'),
      })
    })
  })
}

const runGhTokenCommand: GhTokenCommandRunner = async (options) =>
  await new Promise((resolve) => {
    const child = spawn(options.cmd[0] as string, options.cmd.slice(1), {
      detached: process.platform !== 'win32',
      env: options.env,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const chunks: Buffer[] = []
    let bytes = 0
    let overflow = false
    let settled = false
    let settleTimer: ReturnType<typeof setTimeout> | undefined
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined
    const finish = (value: { exitCode: number; stdout: string } | null): void => {
      if (settled) return
      settled = true
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer)
      if (settleTimer !== undefined) clearTimeout(settleTimer)
      resolve(value)
    }
    const terminate = (): void => {
      if (settleTimer !== undefined || settled) return
      killChildProcessGroup(child)
      settleTimer = setTimeout(() => finish(null), PROCESS_KILL_SETTLE_MS)
    }
    timeoutTimer = setTimeout(terminate, options.timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > options.maxStdoutBytes) {
        overflow = true
        terminate()
        return
      }
      chunks.push(chunk)
    })
    child.on('error', () => finish(null))
    child.on('close', (code) => {
      if (overflow || code === null) finish(null)
      else finish({ exitCode: code, stdout: Buffer.concat(chunks).toString('utf8') })
    })
  })

function killChildProcessGroup(child: ChildProcess): void {
  if (process.platform !== 'win32' && child.pid !== undefined) {
    try {
      process.kill(-child.pid, 'SIGKILL')
      return
    } catch {
      child.kill('SIGKILL')
      return
    }
  }
  child.kill('SIGKILL')
}
