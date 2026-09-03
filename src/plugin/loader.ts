import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { DefinedPlugin } from './types'

export type ResolvedPlugin = {
  name: string
  version: string | undefined
  source: string
  defined: DefinedPlugin<any>
}

export type LoadPluginEntryFn = (entry: string, agentDir: string) => Promise<ResolvedPlugin>

export type LoadPluginEntryOptions = {
  // Managed images can bind image-owned defaults to the immutable root package
  // graph while leaving explicitly configured packages agent-local. The value
  // is a project directory containing node_modules, not node_modules itself.
  preferredPackageSearchDir?: string
  preferredPackages?: ReadonlySet<string>
  // Stops a preferred package lookup after inspecting this directory. Managed
  // explicit plugins use the Agent Folder as a hard boundary so walking to
  // `/node_modules` cannot silently satisfy a missing hydrated override.
  preferredPackageSearchBoundaryDir?: string
}

// Thrown only when a plugin entry cannot be resolved at all (uninstalled
// package, missing local file, unresolvable export subpath). The manager
// treats this as non-fatal and skips the entry.
export class PluginNotFoundError extends Error {
  readonly entry: string
  constructor(entry: string, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'PluginNotFoundError'
    this.entry = entry
  }
}

// Thrown when a plugin entry violates a security boundary (e.g. a local path
// escaping the agent directory). Stays fatal for ALL plugins — even the
// per-plugin tolerance for user plugin bugs MUST NOT swallow this, or a
// malicious typeclaw.json could point at arbitrary host files and have the
// failure silently downgraded to a warning.
export class PluginSecurityError extends Error {
  readonly entry: string
  constructor(entry: string, message: string) {
    super(message)
    this.name = 'PluginSecurityError'
    this.entry = entry
  }
}

// Thrown when a platform-declared extension cannot be loaded. Separate from
// PluginNotFoundError because a platform extension is administrator-owned,
// image-mounted code: a path that is missing, unreadable, or not a plugin is a
// misconfigured deployment, and skipping it silently would boot a runtime that
// looks healthy while the capability the administrator shipped is simply gone.
export class PlatformExtensionError extends Error {
  readonly path: string
  constructor(path: string, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'PlatformExtensionError'
    this.path = path
  }
}

// The trusted-local load path used ONLY for TYPECLAW_PLATFORM_EXTENSIONS.
//
// Why this is not a hole in loadLocal's containment check: that check exists to
// stop a plugin entry AUTHORED BY THE MODEL OR THE AGENT FOLDER — a
// `typeclaw.json#plugins` string the agent can rewrite at will — from escaping
// the Agent Folder and importing arbitrary host files. This list is not
// agent-authored: it is process environment set by the platform before the
// runtime starts, in the `managed` deployment profile, where the agent has no
// way to edit the environment of its own process (the caller gates on
// resolveDeploymentProfile() for exactly this reason). The path is therefore
// already outside the agent's reach before it gets here, so the containment
// check has nothing left to protect. The guard on config-declared entries is
// unchanged: loadLocal still refuses every path outside agentDir, and
// PluginSecurityError stays fatal there.
export async function loadPlatformExtension(path: string): Promise<ResolvedPlugin> {
  if (!isAbsolute(path)) {
    throw new PlatformExtensionError(path, `platform extension path must be absolute: ${path}`)
  }
  const resolved = resolve(path)
  let isDirectory: boolean
  try {
    isDirectory = statSync(resolved).isDirectory()
  } catch (err) {
    throw new PlatformExtensionError(resolved, `platform extension path is missing or unreadable: ${resolved}`, {
      cause: err,
    })
  }
  const entryFile = isDirectory ? resolveDirectoryEntryFile(resolved) : resolved
  let mod: { default?: unknown }
  try {
    mod = (await import(toModuleSpecifier(entryFile))) as { default?: unknown }
  } catch (err) {
    throw new PlatformExtensionError(resolved, `platform extension failed to import: ${entryFile}`, { cause: err })
  }
  let defined: DefinedPlugin<any>
  try {
    defined = expectDefined(mod, resolved)
  } catch (err) {
    throw new PlatformExtensionError(resolved, describeError(err), { cause: err })
  }
  // The name is the basename so the administrator can address the extension's
  // config block in typeclaw.json without knowing the mount layout.
  const name = isDirectory ? basename(resolved) : platformExtensionNameForFile(resolved)
  if (name.length === 0) {
    throw new PlatformExtensionError(resolved, `platform extension path has no usable plugin name: ${resolved}`)
  }
  return { name, version: undefined, source: resolved, defined }
}

// A platform mounts one extension per directory and may point the env var at
// either the directory or its entry file. Naming a file `index` after its own
// basename would make both spellings of the SAME mount produce different names:
// the typeclaw.json config block would be looked up under `index` instead of
// the directory name the administrator wrote, and a second mount in the same
// `<name>/index.ts` shape would collide on `index` and abort boot at the
// plugin-name-conflict check. Falling back to the containing directory (Node's
// own module-resolution convention) makes the two spellings agree.
function platformExtensionNameForFile(file: string): string {
  const stripped = stripModuleExtension(basename(file))
  return stripped === 'index' ? basename(dirname(file)) : stripped
}

const DIRECTORY_ENTRY_CANDIDATES = ['index.ts', 'index.tsx', 'index.js', 'index.mjs', 'index.cjs'] as const

function resolveDirectoryEntryFile(dir: string): string {
  const pkgJsonPath = join(dir, 'package.json')
  if (existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { main?: unknown; module?: unknown }
      const main = typeof pkg.module === 'string' ? pkg.module : typeof pkg.main === 'string' ? pkg.main : null
      if (main !== null) {
        const candidate = join(dir, main)
        if (existsSync(candidate)) return candidate
      }
    } catch {
      // A malformed package.json is not fatal on its own — fall through to the
      // index.* candidates and let the miss below name the directory.
    }
  }
  for (const candidate of DIRECTORY_ENTRY_CANDIDATES) {
    const full = join(dir, candidate)
    if (existsSync(full)) return full
  }
  throw new PlatformExtensionError(
    dir,
    `platform extension directory has no entry file (looked for package.json main/module and ${DIRECTORY_ENTRY_CANDIDATES.join(', ')}): ${dir}`,
  )
}

export async function loadPluginEntry(
  entry: string,
  agentDir: string,
  options: LoadPluginEntryOptions = {},
): Promise<ResolvedPlugin> {
  if (isLocalPath(entry)) {
    return loadLocal(entry, agentDir)
  }
  return loadNpm(entry, agentDir, options)
}

function isLocalPath(entry: string): boolean {
  return entry.startsWith('./') || entry.startsWith('../') || isAbsolute(entry)
}

async function loadLocal(entry: string, agentDir: string): Promise<ResolvedPlugin> {
  const resolved = resolve(agentDir, entry)
  // Confine local plugin paths to within agentDir so a malicious typeclaw.json
  // cannot point at arbitrary files on the host.
  const rel = relative(agentDir, resolved)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new PluginSecurityError(entry, `plugin path escapes agent directory: ${entry} (resolved to ${resolved})`)
  }
  if (!existsSync(resolved)) {
    throw new PluginNotFoundError(entry, `plugin path does not exist: ${entry} (resolved to ${resolved})`)
  }
  const mod = (await import(toModuleSpecifier(resolved))) as { default?: unknown }
  const defined = expectDefined(mod, entry)
  const name = stripModuleExtension(basename(resolved))
  return { name, version: undefined, source: entry, defined }
}

function stripModuleExtension(name: string): string {
  return name.replace(/\.(ts|tsx|js|mjs|cjs)$/i, '')
}

async function loadNpm(entry: string, agentDir: string, options: LoadPluginEntryOptions): Promise<ResolvedPlugin> {
  // The version suffix (`name@1.2.3`, `@scope/name@1.2.3`) is consumed by the
  // host reconcile step when materializing the entry into package.json. By load
  // time the package is installed at `node_modules/<name>/` under its bare name,
  // so passing the raw `name@version` here would miss the dir and fail the
  // bare-import fallback too.
  const { name: packageName } = splitPluginEntrySpec(entry)
  const packageSearchDir = options.preferredPackages?.has(packageName) ? options.preferredPackageSearchDir : undefined
  const resolutionDir = packageSearchDir ?? agentDir
  const packageSearchBoundaryDir =
    packageSearchDir !== undefined ? options.preferredPackageSearchBoundaryDir : undefined
  const pkgJsonPath = findPackageJson(packageName, resolutionDir, packageSearchBoundaryDir)
  if (pkgJsonPath === null && packageSearchBoundaryDir !== undefined) {
    throw new PluginNotFoundError(
      entry,
      `cannot resolve plugin "${entry}" inside package boundary ${packageSearchBoundaryDir}`,
    )
  }
  let pkgName = packageName
  let version: string | undefined
  let entryPath: string | null = null
  if (pkgJsonPath !== null) {
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as {
        name?: unknown
        version?: unknown
        main?: unknown
        module?: unknown
      }
      if (typeof pkg.name === 'string' && pkg.name.length > 0) pkgName = pkg.name
      if (typeof pkg.version === 'string' && pkg.version.length > 0) version = pkg.version
      const main = typeof pkg.module === 'string' ? pkg.module : typeof pkg.main === 'string' ? pkg.main : null
      if (main !== null) {
        const candidate = join(dirname(pkgJsonPath), main)
        if (existsSync(candidate)) {
          entryPath = candidate
        }
      }
    } catch {
      // Fall through to bare-import resolution.
    }
  }
  // Resolve before importing so an unresolvable entry (uninstalled package,
  // missing export subpath) is classified as PluginNotFoundError WITHOUT
  // running the module. Once resolution succeeds, any import-time throw is a
  // genuine plugin bug and propagates fatally -- never swallowed as not-found.
  // The entryPath branch covers packages whose `main`/`module` was already
  // located on disk; the else branch lets Bun's resolver read `exports` maps.
  let importTarget: string
  if (entryPath !== null) {
    importTarget = toModuleSpecifier(entryPath)
  } else {
    try {
      importTarget = toModuleSpecifier(Bun.resolveSync(packageName, resolutionDir))
    } catch (err) {
      throw new PluginNotFoundError(entry, `cannot resolve plugin "${entry}": ${describeError(err)}`, { cause: err })
    }
  }
  const mod = (await import(importTarget)) as { default?: unknown }
  const defined = expectDefined(mod, entry)
  const name = derivePluginNameFromPackage(pkgName)
  return { name, version, source: entry, defined }
}

export type PluginEntrySpec = { name: string; versionSpec: string | undefined }

// Splits an npm-style entry into package name and optional version spec. The
// version delimiter is the LAST `@` that isn't the leading scope marker, so
// `@scope/pkg@1.2.3` → { name: '@scope/pkg', versionSpec: '1.2.3' } while
// `@scope/pkg` → { name: '@scope/pkg', versionSpec: undefined }.
export function splitPluginEntrySpec(entry: string): PluginEntrySpec {
  const scoped = entry.startsWith('@')
  const searchFrom = scoped ? entry.indexOf('/') + 1 : 0
  const at = entry.indexOf('@', searchFrom)
  if (at <= 0) return { name: entry, versionSpec: undefined }
  const versionSpec = entry.slice(at + 1)
  return {
    name: entry.slice(0, at),
    versionSpec: versionSpec.length > 0 ? versionSpec : undefined,
  }
}

export function derivePluginNameFromPackage(packageName: string): string {
  const PREFIX = 'typeclaw-plugin-'
  const SCOPED_PREFIX_RE = /^@[^/]+\//
  const stripped = packageName.replace(SCOPED_PREFIX_RE, '')
  return stripped.startsWith(PREFIX) ? stripped.slice(PREFIX.length) : stripped
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function toModuleSpecifier(target: string): string {
  return isAbsolute(target) ? pathToFileURL(target).href : target
}

function findPackageJson(entry: string, agentDir: string, boundaryDir?: string): string | null {
  const PACKAGE_JSON = 'package.json'
  let cur = resolve(agentDir)
  const boundary = boundaryDir === undefined ? null : resolve(boundaryDir)
  if (boundary !== null) {
    const fromBoundary = relative(boundary, cur)
    if (fromBoundary.startsWith('..') || isAbsolute(fromBoundary)) return null
  }
  while (true) {
    const p = join(cur, 'node_modules', entry, PACKAGE_JSON)
    if (existsSync(p)) return p
    if (boundary !== null && cur === boundary) return null
    const parent = dirname(cur)
    if (parent === cur) return null
    cur = parent
  }
}

function expectDefined(mod: { default?: unknown }, entry: string): DefinedPlugin<any> {
  const def = mod.default
  if (
    def !== null &&
    typeof def === 'object' &&
    'plugin' in (def as Record<string, unknown>) &&
    typeof (def as { plugin: unknown }).plugin === 'function'
  ) {
    return def as DefinedPlugin<any>
  }
  throw new Error(`plugin ${entry}: default export is not a definePlugin(...) result`)
}
