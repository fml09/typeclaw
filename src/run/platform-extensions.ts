import { isAbsolute } from 'node:path'

import type { DeploymentProfile } from '@/container/controller'
import { loadPlatformExtension, PlatformExtensionError, type ResolvedPlugin } from '@/plugin'

export const PLATFORM_EXTENSIONS_ENV = 'TYPECLAW_PLATFORM_EXTENSIONS'

export type PlatformExtensionsLogger = {
  info: (msg: string) => void
  warn: (msg: string) => void
}

const consoleLogger: PlatformExtensionsLogger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
}

// Parses TYPECLAW_PLATFORM_EXTENSIONS into the absolute paths to load.
//
// Honored only in the `managed` profile: a Platform Extension is
// administrator-owned code the platform mounts read-only into an immutable
// image, and the whole reason it may skip the Agent Folder containment check is
// that the agent cannot reach the environment of its own process there. In the
// `host` profile the operator IS the agent's neighbour on the same machine and
// the Agent Folder is the supported place to install a plugin, so the variable
// is ignored — loudly, because a platform that set it and got nothing would
// otherwise debug a capability that silently never loaded.
export function resolvePlatformExtensionPaths(
  profile: DeploymentProfile,
  env: NodeJS.ProcessEnv = process.env,
  logger: PlatformExtensionsLogger = consoleLogger,
): readonly string[] {
  const raw = env[PLATFORM_EXTENSIONS_ENV]
  if (raw === undefined || raw.trim() === '') return []
  if (profile !== 'managed') {
    logger.warn(
      `[plugin] ${PLATFORM_EXTENSIONS_ENV} is set but the deployment profile is "${profile}"; platform extensions are ignored outside the managed profile`,
    )
    return []
  }
  const paths: string[] = []
  for (const segment of raw.split(':')) {
    const path = segment.trim()
    // Empty segments come from a trailing or doubled separator in a generated
    // env value; they are noise, not a misconfiguration.
    if (path === '') continue
    if (!isAbsolute(path)) {
      throw new PlatformExtensionError(
        path,
        `${PLATFORM_EXTENSIONS_ENV} entry is not an absolute path: ${JSON.stringify(path)}`,
      )
    }
    // The same mount listed twice would otherwise resolve to two plugins with
    // one name and abort boot on the name-conflict check.
    if (!paths.includes(path)) paths.push(path)
  }
  return paths
}

// Resolves each declared path into a loadable plugin. Every failure throws:
// these paths are the platform's own declaration, so a missing mount or a file
// that is not a definePlugin(...) result is a deployment error that must abort
// boot rather than leave the operator with a runtime that is missing the
// capability it was configured to have.
export async function loadPlatformExtensions(
  paths: readonly string[],
  logger: PlatformExtensionsLogger = consoleLogger,
): Promise<ResolvedPlugin[]> {
  const loaded: ResolvedPlugin[] = []
  for (const path of paths) {
    const resolved = await loadPlatformExtension(path)
    logger.info(`[plugin] platform extension loaded: ${resolved.name} (${resolved.source})`)
    loaded.push(resolved)
  }
  return loaded
}
