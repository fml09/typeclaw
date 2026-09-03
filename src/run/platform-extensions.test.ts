import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { loadPlugins } from '@/plugin'

import { loadPlatformExtensions, PLATFORM_EXTENSIONS_ENV, resolvePlatformExtensionPaths } from './platform-extensions'

const pluginIndexSpecifier = pathToFileURL(join(process.cwd(), 'src', 'plugin', 'index.ts')).href
// Extensions are written into a temp dir outside the repo, so bare specifiers
// like `zod` do not resolve from there — pin the real file the repo resolves to.
const zodSpecifier = pathToFileURL(Bun.resolveSync('zod', process.cwd())).href

function collectingLogger() {
  const lines: string[] = []
  return { lines, info: (m: string) => lines.push(m), warn: (m: string) => lines.push(m) }
}

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'typeclaw-platform-ext-'))
  try {
    return await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// A plugin whose tool name is derived from its file so a test can tell which
// extension actually loaded.
async function writeExtensionFile(path: string, marker: string): Promise<void> {
  await writeFile(
    path,
    `import { definePlugin } from '${pluginIndexSpecifier}'
export default definePlugin({ plugin: async () => ({ skillsDirs: ['${marker}'] }) })`,
  )
}

describe('resolvePlatformExtensionPaths', () => {
  test('splits a colon-separated list in the managed profile', () => {
    expect(resolvePlatformExtensionPaths('managed', { [PLATFORM_EXTENSIONS_ENV]: '/opt/a/index.ts:/opt/b' })).toEqual([
      '/opt/a/index.ts',
      '/opt/b',
    ])
  })

  test('ignores empty segments and repeats of the same mount', () => {
    expect(resolvePlatformExtensionPaths('managed', { [PLATFORM_EXTENSIONS_ENV]: '/opt/a:: /opt/a :/opt/b:' })).toEqual(
      ['/opt/a', '/opt/b'],
    )
  })

  test('is ignored with a warning outside the managed profile', () => {
    const logger = collectingLogger()
    expect(resolvePlatformExtensionPaths('host', { [PLATFORM_EXTENSIONS_ENV]: '/opt/a' }, logger)).toEqual([])
    expect(logger.lines.some((l) => l.includes('deployment profile is "host"'))).toBe(true)
  })

  test('returns nothing when the variable is unset or blank', () => {
    expect(resolvePlatformExtensionPaths('managed', {})).toEqual([])
    expect(resolvePlatformExtensionPaths('managed', { [PLATFORM_EXTENSIONS_ENV]: '   ' })).toEqual([])
  })

  test('a relative entry is a loud failure, not a silent skip', () => {
    expect(() => resolvePlatformExtensionPaths('managed', { [PLATFORM_EXTENSIONS_ENV]: 'plugins/x.ts' })).toThrow(
      /not an absolute path/,
    )
  })
})

describe('loadPlatformExtensions', () => {
  test('names a file extension after its basename without the extension, and logs it', async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, 'personal-desktop-computer-use.ts')
      await writeExtensionFile(file, 'from-file')
      const logger = collectingLogger()

      const loaded = await loadPlatformExtensions([file], logger)

      expect(loaded.map((p) => p.name)).toEqual(['personal-desktop-computer-use'])
      expect(loaded[0]!.source).toBe(file)
      expect(logger.lines.some((l) => l.includes('platform extension loaded: personal-desktop-computer-use'))).toBe(
        true,
      )
    })
  })

  // The operator mounts one extension per directory and may name either the
  // directory or its entry file. `index` is not a name — it would key the
  // typeclaw.json config block on the wrong string and make every such mount
  // claim the same plugin name.
  test('an entry file named index is named after its containing directory, matching the directory form', async () => {
    await withTempDir(async (dir) => {
      const extDir = join(dir, 'personal-desktop-computer-use')
      await mkdir(extDir, { recursive: true })
      await writeExtensionFile(join(extDir, 'index.ts'), 'from-index-file')
      const logger = collectingLogger()

      const loaded = await loadPlatformExtensions([join(extDir, 'index.ts')], logger)

      expect(loaded.map((p) => p.name)).toEqual(['personal-desktop-computer-use'])
      expect(logger.lines.some((l) => l.includes('platform extension loaded: personal-desktop-computer-use'))).toBe(
        true,
      )
    })
  })

  test('two <name>/index.ts mounts get distinct names instead of both claiming "index"', async () => {
    await withTempDir(async (dir) => {
      const first = join(dir, 'extension-a')
      const second = join(dir, 'extension-b')
      await mkdir(first, { recursive: true })
      await mkdir(second, { recursive: true })
      await writeExtensionFile(join(first, 'index.ts'), 'from-a')
      await writeExtensionFile(join(second, 'index.ts'), 'from-b')

      const loaded = await loadPlatformExtensions(
        [join(first, 'index.ts'), join(second, 'index.ts')],
        collectingLogger(),
      )

      expect(loaded.map((p) => p.name)).toEqual(['extension-a', 'extension-b'])
    })
  })

  test('names a directory extension after the directory and loads its index file', async () => {
    await withTempDir(async (dir) => {
      const extDir = join(dir, 'personal-desktop-computer-use')
      await mkdir(extDir, { recursive: true })
      await writeExtensionFile(join(extDir, 'index.ts'), 'from-dir')
      const logger = collectingLogger()

      const loaded = await loadPlatformExtensions([extDir], logger)

      expect(loaded.map((p) => p.name)).toEqual(['personal-desktop-computer-use'])
    })
  })

  test('a missing path is a named failure, not a skipped entry', async () => {
    await withTempDir(async (dir) => {
      const missing = join(dir, 'not-there.ts')
      const promise = loadPlatformExtensions([missing], collectingLogger())
      await expect(promise).rejects.toThrow(/missing or unreadable/)
      await expect(promise).rejects.toThrow(missing)
    })
  })

  test('a directory with no entry file names the directory it looked in', async () => {
    await withTempDir(async (dir) => {
      const extDir = join(dir, 'empty-extension')
      await mkdir(extDir, { recursive: true })
      await expect(loadPlatformExtensions([extDir], collectingLogger())).rejects.toThrow(/no entry file/)
    })
  })

  test('a file that is not a definePlugin result fails by name', async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, 'not-a-plugin.ts')
      await writeFile(file, 'export default { nope: true }')
      await expect(loadPlatformExtensions([file], collectingLogger())).rejects.toThrow(/definePlugin/)
    })
  })

  test('loads an absolute path outside the agent directory that loadLocal would refuse', async () => {
    await withTempDir(async (dir) => {
      const agentDir = join(dir, 'agent')
      await mkdir(agentDir, { recursive: true })
      const outside = join(dir, 'platform', 'desktop.ts')
      await mkdir(join(dir, 'platform'), { recursive: true })
      await writeExtensionFile(outside, 'outside')

      // The same path as a config-declared entry stays refused: the containment
      // guard is unchanged, only the platform-declared route bypasses it.
      const configDeclared = await loadPlugins({
        entries: [outside],
        agentDir,
        configsByName: {},
      }).catch((err: unknown) => err)
      expect(configDeclared).toBeInstanceOf(Error)
      expect(String(configDeclared)).toContain('escapes agent directory')

      const loaded = await loadPlugins({
        entries: [],
        agentDir,
        configsByName: {},
        platformExtensions: await loadPlatformExtensions([outside], collectingLogger()),
      })
      expect(loaded.loadedPlugins.map((p) => p.name)).toEqual(['desktop'])
    })
  })
})

describe('platform extensions in loadPlugins', () => {
  test('load AFTER config-declared plugins and take their config block by name', async () => {
    await withTempDir(async (dir) => {
      const agentDir = join(dir, 'agent')
      await mkdir(join(agentDir, 'plugins'), { recursive: true })
      await writeExtensionFile(join(agentDir, 'plugins', 'local-thing.ts'), 'local')
      const extension = join(dir, 'platform', 'desktop.ts')
      await mkdir(join(dir, 'platform'), { recursive: true })
      await writeFile(
        extension,
        `import { definePlugin } from '${pluginIndexSpecifier}'
import { z } from '${zodSpecifier}'
export default definePlugin({
  configSchema: z.object({ gatewayUrl: z.string() }),
  plugin: async (ctx) => ({ skillsDirs: [ctx.config.gatewayUrl] }),
})`,
      )

      const loaded = await loadPlugins({
        entries: ['./plugins/local-thing.ts'],
        agentDir,
        configsByName: { desktop: { gatewayUrl: 'http://gateway:8080' } },
        platformExtensions: await loadPlatformExtensions([extension], collectingLogger()),
      })

      expect(loaded.loadedPlugins.map((p) => p.name)).toEqual(['local-thing', 'desktop'])
      expect(loaded.registry.skillsDirs.map((d) => d.path)).toContain('http://gateway:8080')
    })
  })

  test('a <name>/index.ts mount takes the config block written under the directory name', async () => {
    await withTempDir(async (dir) => {
      const agentDir = join(dir, 'agent')
      await mkdir(agentDir, { recursive: true })
      const extDir = join(dir, 'personal-desktop-computer-use')
      await mkdir(extDir, { recursive: true })
      await writeFile(
        join(extDir, 'index.ts'),
        `import { definePlugin } from '${pluginIndexSpecifier}'
import { z } from '${zodSpecifier}'
export default definePlugin({
  configSchema: z.object({ gatewayUrl: z.string() }),
  plugin: async (ctx) => ({ skillsDirs: [ctx.config.gatewayUrl] }),
})`,
      )

      const loaded = await loadPlugins({
        entries: [],
        agentDir,
        // Written the way the administrator addresses the mount, not the way
        // the entry file happens to be spelled.
        configsByName: { 'personal-desktop-computer-use': { gatewayUrl: 'http://gateway:8080' } },
        platformExtensions: await loadPlatformExtensions([join(extDir, 'index.ts')], collectingLogger()),
      })

      expect(loaded.loadedPlugins.map((p) => p.name)).toEqual(['personal-desktop-computer-use'])
      expect(loaded.registry.skillsDirs.map((d) => d.path)).toContain('http://gateway:8080')
    })
  })

  test('an extension whose config is absent is registered with undefined config', async () => {
    await withTempDir(async (dir) => {
      const agentDir = join(dir, 'agent')
      await mkdir(agentDir, { recursive: true })
      const extension = join(dir, 'desktop.ts')
      await writeFile(
        extension,
        `import { definePlugin } from '${pluginIndexSpecifier}'
import { z } from '${zodSpecifier}'
export default definePlugin({
  configSchema: z.object({ gatewayUrl: z.string().optional() }),
  plugin: async (ctx) => ({ skillsDirs: [ctx.config.gatewayUrl ?? 'unset'] }),
})`,
      )

      const loaded = await loadPlugins({
        entries: [],
        agentDir,
        configsByName: {},
        platformExtensions: await loadPlatformExtensions([extension], collectingLogger()),
      })

      expect(loaded.registry.skillsDirs.map((d) => d.path)).toEqual(['unset'])
    })
  })

  test('an extension that throws at registration aborts boot instead of being skipped', async () => {
    await withTempDir(async (dir) => {
      const agentDir = join(dir, 'agent')
      await mkdir(agentDir, { recursive: true })
      const extension = join(dir, 'broken.ts')
      await writeFile(
        extension,
        `import { definePlugin } from '${pluginIndexSpecifier}'
export default definePlugin({ plugin: async () => { throw new Error('gateway unreachable') } })`,
      )

      await expect(
        loadPlugins({
          entries: [],
          agentDir,
          configsByName: {},
          platformExtensions: await loadPlatformExtensions([extension], collectingLogger()),
        }),
      ).rejects.toThrow('gateway unreachable')
    })
  })
})
