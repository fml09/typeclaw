import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { derivePluginNameFromPackage, loadPluginEntry, PluginNotFoundError, splitPluginEntrySpec } from './loader'

const pluginIndexSpecifier = pathToFileURL(join(process.cwd(), 'src', 'plugin', 'index.ts')).href

describe('splitPluginEntrySpec', () => {
  test('splits a versioned unscoped entry', () => {
    expect(splitPluginEntrySpec('typeclaw-plugin-foo@1.2.3')).toEqual({
      name: 'typeclaw-plugin-foo',
      versionSpec: '1.2.3',
    })
  })

  test('leaves a bare unscoped entry without a version', () => {
    expect(splitPluginEntrySpec('typeclaw-plugin-foo')).toEqual({
      name: 'typeclaw-plugin-foo',
      versionSpec: undefined,
    })
  })

  test('splits a versioned scoped entry on the last @', () => {
    expect(splitPluginEntrySpec('@acme/typeclaw-plugin-foo@2.0.0')).toEqual({
      name: '@acme/typeclaw-plugin-foo',
      versionSpec: '2.0.0',
    })
  })

  test('does not treat the leading scope @ as a version delimiter', () => {
    expect(splitPluginEntrySpec('@acme/typeclaw-plugin-foo')).toEqual({
      name: '@acme/typeclaw-plugin-foo',
      versionSpec: undefined,
    })
  })

  test('preserves dist-tag version specs', () => {
    expect(splitPluginEntrySpec('typeclaw-plugin-foo@latest')).toEqual({
      name: 'typeclaw-plugin-foo',
      versionSpec: 'latest',
    })
  })
})

describe('derivePluginNameFromPackage', () => {
  test('strips typeclaw-plugin- prefix', () => {
    expect(derivePluginNameFromPackage('typeclaw-plugin-standup-log')).toBe('standup-log')
  })

  test('strips scoped prefix and typeclaw-plugin- prefix', () => {
    expect(derivePluginNameFromPackage('@acme/typeclaw-plugin-helicone')).toBe('helicone')
  })

  test('keeps unprefixed names as-is', () => {
    expect(derivePluginNameFromPackage('memory')).toBe('memory')
  })

  test('strips scope from scoped names without typeclaw prefix', () => {
    expect(derivePluginNameFromPackage('@acme/cool-plugin')).toBe('cool-plugin')
  })
})

describe('loadPluginEntry — local path', () => {
  // 60s, not the global 30s: this writes a temp plugin then `await import()`s it,
  // paying Bun's cold transpile + module-resolution of the `@/plugin` graph. That
  // is ~400ms in isolation but starves past 30s under full 18-worker contention.
  // The budget absorbs the starvation while still failing loudly on a real hang.
  test('loads a relative-path plugin and derives name from basename', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-loader-'))
    try {
      await mkdir(join(dir, 'plugins'))
      await writeFile(
        join(dir, 'plugins', 'local-thing.ts'),
        `import { definePlugin } from '${pluginIndexSpecifier}'
export default definePlugin({
  plugin: async () => ({}),
})`,
      )
      const resolved = await loadPluginEntry('./plugins/local-thing.ts', dir)
      expect(resolved.name).toBe('local-thing')
      expect(resolved.version).toBeUndefined()
      expect(resolved.source).toBe('./plugins/local-thing.ts')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 60_000)

  test('throws PluginNotFoundError when local path does not exist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-loader-'))
    try {
      await expect(loadPluginEntry('./plugins/missing.ts', dir)).rejects.toBeInstanceOf(PluginNotFoundError)
      await expect(loadPluginEntry('./plugins/missing.ts', dir)).rejects.toThrow(/does not exist/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('throws a fatal (non-not-found) error when path escapes the agent directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-loader-'))
    try {
      const promise = loadPluginEntry('../escape.ts', dir)
      await expect(promise).rejects.toThrow(/escapes agent directory/)
      await expect(loadPluginEntry('../escape.ts', dir)).rejects.not.toBeInstanceOf(PluginNotFoundError)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('throws a fatal (non-not-found) error when default export is not a definePlugin result', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-loader-'))
    try {
      await mkdir(join(dir, 'plugins'))
      await writeFile(join(dir, 'plugins', 'bad.ts'), `export default { plugin: 'not a function' }`)
      await expect(loadPluginEntry('./plugins/bad.ts', dir)).rejects.toThrow(/default export is not/)
      await expect(loadPluginEntry('./plugins/bad.ts', dir)).rejects.not.toBeInstanceOf(PluginNotFoundError)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('an existing local plugin that throws at import time stays fatal (not classified as not-found)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-loader-'))
    try {
      await mkdir(join(dir, 'plugins'))
      await writeFile(join(dir, 'plugins', 'explodes.ts'), `throw new Error('boom at import time')`)
      await expect(loadPluginEntry('./plugins/explodes.ts', dir)).rejects.toThrow(/boom at import time/)
      await expect(loadPluginEntry('./plugins/explodes.ts', dir)).rejects.not.toBeInstanceOf(PluginNotFoundError)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('loadPluginEntry — npm', () => {
  test('prefers an immutable package root for a selected managed default', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-loader-npm-'))
    try {
      const agentPkgDir = join(dir, 'agent', 'node_modules', 'typeclaw-plugin-standup-log')
      const imagePkgDir = join(dir, 'image', 'node_modules', 'typeclaw-plugin-standup-log')
      await Promise.all([mkdir(agentPkgDir, { recursive: true }), mkdir(imagePkgDir, { recursive: true })])
      for (const [pkgDir, version] of [
        [agentPkgDir, '0.1.0'],
        [imagePkgDir, '0.2.0'],
      ] as const) {
        await writeFile(
          join(pkgDir, 'package.json'),
          JSON.stringify({
            name: 'typeclaw-plugin-standup-log',
            version,
            type: 'module',
            main: 'index.js',
          }),
        )
        await writeFile(
          join(pkgDir, 'index.js'),
          `import { definePlugin } from '${pluginIndexSpecifier}'
export default definePlugin({
  plugin: async () => ({}),
})`,
        )
      }

      const resolved = await loadPluginEntry('typeclaw-plugin-standup-log@^0.2.0', join(dir, 'agent'), {
        preferredPackageSearchDir: join(dir, 'image'),
        preferredPackages: new Set(['typeclaw-plugin-standup-log']),
      })

      expect(resolved.version).toBe('0.2.0')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('reads package.json for name + version when located in node_modules', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-loader-npm-'))
    try {
      const pkgDir = join(dir, 'node_modules', 'typeclaw-plugin-standup-log')
      await mkdir(pkgDir, { recursive: true })
      await writeFile(
        join(pkgDir, 'package.json'),
        JSON.stringify({
          name: 'typeclaw-plugin-standup-log',
          version: '0.1.2',
          type: 'module',
          main: 'index.js',
        }),
      )
      await writeFile(
        join(pkgDir, 'index.js'),
        `import { definePlugin } from '${pluginIndexSpecifier}'
export default definePlugin({
  plugin: async () => ({}),
})`,
      )
      const resolved = await loadPluginEntry('typeclaw-plugin-standup-log', dir)
      expect(resolved.name).toBe('standup-log')
      expect(resolved.version).toBe('0.1.2')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('resolves a versioned entry from node_modules under its bare name', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-loader-npm-'))
    try {
      const pkgDir = join(dir, 'node_modules', 'typeclaw-plugin-standup-log')
      await mkdir(pkgDir, { recursive: true })
      await writeFile(
        join(pkgDir, 'package.json'),
        JSON.stringify({
          name: 'typeclaw-plugin-standup-log',
          version: '0.1.2',
          type: 'module',
          main: 'index.js',
        }),
      )
      await writeFile(
        join(pkgDir, 'index.js'),
        `import { definePlugin } from '${pluginIndexSpecifier}'
export default definePlugin({
  plugin: async () => ({}),
})`,
      )
      const resolved = await loadPluginEntry('typeclaw-plugin-standup-log@0.1.2', dir)
      expect(resolved.name).toBe('standup-log')
      expect(resolved.version).toBe('0.1.2')
      expect(resolved.source).toBe('typeclaw-plugin-standup-log@0.1.2')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('throws PluginNotFoundError for an uninstalled package', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-loader-npm-'))
    try {
      await expect(loadPluginEntry('typeclaw-plugin-not-installed-xyz', dir)).rejects.toBeInstanceOf(
        PluginNotFoundError,
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
