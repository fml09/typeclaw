import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { createManagedDefaultPluginLoader } from './index'

const pluginIndexSpecifier = pathToFileURL(join(process.cwd(), 'src', 'plugin', 'index.ts')).href

describe('createManagedDefaultPluginLoader', () => {
  test('binds the injected GWS default to the immutable image package', async () => {
    const root = await mkdtemp(join(tmpdir(), 'typeclaw-managed-plugin-'))
    try {
      const agentDir = join(root, 'agent')
      const imageRoot = join(root, 'image')
      await installGws(join(agentDir, 'node_modules', 'typeclaw-gws-multi-account'), '0.1.0')
      await installGws(join(imageRoot, 'node_modules', 'typeclaw-gws-multi-account'), '0.3.4')
      const loader = createManagedDefaultPluginLoader('managed', [], imageRoot)

      expect(loader).toBeDefined()
      await expect(loader?.('typeclaw-gws-multi-account@^0.3.4', agentDir)).resolves.toMatchObject({
        version: '0.3.4',
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('leaves an explicitly configured GWS package agent-local', async () => {
    const root = await mkdtemp(join(tmpdir(), 'typeclaw-managed-plugin-'))
    try {
      const agentDir = join(root, 'agent')
      const imageRoot = join(root, 'image')
      await installGws(join(agentDir, 'node_modules', 'typeclaw-gws-multi-account'), '0.4.0')
      await installGws(join(imageRoot, 'node_modules', 'typeclaw-gws-multi-account'), '0.3.4')
      const loader = createManagedDefaultPluginLoader('managed', ['typeclaw-gws-multi-account@0.4.0'], imageRoot)

      expect(loader).toBeDefined()
      await expect(loader?.('typeclaw-gws-multi-account@0.4.0', agentDir)).resolves.toMatchObject({
        version: '0.4.0',
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('does not satisfy an explicit GWS entry from the image when Agent Folder hydration is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'typeclaw-managed-plugin-'))
    try {
      const agentDir = join(root, 'agent')
      await mkdir(agentDir, { recursive: true })
      // This is the same ancestry as /agent -> /node_modules in the image.
      // Normal package lookup would walk upward and silently find this copy.
      await installGws(join(root, 'node_modules', 'typeclaw-gws-multi-account'), '0.3.4')
      const loader = createManagedDefaultPluginLoader('managed', ['typeclaw-gws-multi-account@0.4.0'], root)

      expect(loader).toBeDefined()
      await expect(loader?.('typeclaw-gws-multi-account@0.4.0', agentDir)).rejects.toThrow('cannot resolve plugin')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

async function installGws(packageDir: string, version: string): Promise<void> {
  await mkdir(packageDir, { recursive: true })
  await writeFile(
    join(packageDir, 'package.json'),
    JSON.stringify({ name: 'typeclaw-gws-multi-account', version, type: 'module', main: 'index.js' }),
  )
  await writeFile(
    join(packageDir, 'index.js'),
    `import { definePlugin } from '${pluginIndexSpecifier}'
export default definePlugin({ plugin: async () => ({}) })`,
  )
}
