import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isWindows } from '@/shared'

import { createKeyStore, defaultKeyStoreDir, KeyStoreError } from './keys'

const onWindows = isWindows()

async function withTempKeysDir<T>(fn: (keysDir: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'typeclaw-keys-'))
  return fn(join(root, 'keys'))
}

describe('keys store', () => {
  test('defaultKeyStoreDir honors TYPECLAW_HOME and otherwise uses the runtime home', () => {
    expect(defaultKeyStoreDir({ TYPECLAW_HOME: '/durable/typeclaw' }, '/home/runtime')).toBe('/durable/typeclaw/keys')
    expect(defaultKeyStoreDir({}, '/home/runtime')).toBe('/home/runtime/.typeclaw/keys')
  })

  test('ensure creates a 32-byte key on first call and returns it on subsequent calls', async () => {
    await withTempKeysDir(async (keysDir) => {
      const store = createKeyStore({ keysDir })
      const first = await store.ensure('kakao')
      expect(first.length).toBe(32)
      const second = await store.ensure('kakao')
      expect(second.equals(first)).toBe(true)
    })
  })

  test('ensure writes the key file with mode 0600', async () => {
    await withTempKeysDir(async (keysDir) => {
      const store = createKeyStore({ keysDir })
      await store.ensure('kakao')
      const info = await stat(store.keyPath('kakao'))
      // NTFS mode bits are not meaningful on Windows; see #899.
      if (!onWindows) expect(info.mode & 0o777).toBe(0o600)
    })
  })

  test('keys for different containers are independent', async () => {
    await withTempKeysDir(async (keysDir) => {
      const store = createKeyStore({ keysDir })
      const a = await store.ensure('kakao-1')
      const b = await store.ensure('kakao-2')
      expect(a.equals(b)).toBe(false)
    })
  })

  test('exists returns false before ensure and true after', async () => {
    await withTempKeysDir(async (keysDir) => {
      const store = createKeyStore({ keysDir })
      expect(store.exists('kakao')).toBe(false)
      await store.ensure('kakao')
      expect(store.exists('kakao')).toBe(true)
    })
  })

  test('read returns the stored key bytes', async () => {
    await withTempKeysDir(async (keysDir) => {
      const store = createKeyStore({ keysDir })
      const written = await store.ensure('kakao')
      const onDisk = await readFile(store.keyPath('kakao'))
      const readBack = await store.read('kakao')
      expect(readBack.equals(written)).toBe(true)
      expect(readBack.equals(onDisk)).toBe(true)
    })
  })

  test('read throws with code=missing when the file is absent', async () => {
    await withTempKeysDir(async (keysDir) => {
      const store = createKeyStore({ keysDir })
      try {
        await store.read('kakao')
        throw new Error('expected throw')
      } catch (err) {
        expect(err).toBeInstanceOf(KeyStoreError)
        expect((err as KeyStoreError).code).toBe('missing')
      }
    })
  })

  test('ensure throws on a pre-existing corrupt-size key file (does NOT silently overwrite)', async () => {
    await withTempKeysDir(async (keysDir) => {
      const store = createKeyStore({ keysDir })
      await store.ensure('kakao')
      await writeFile(store.keyPath('kakao'), Buffer.alloc(7))
      try {
        await store.ensure('kakao')
        throw new Error('expected throw')
      } catch (err) {
        expect(err).toBeInstanceOf(KeyStoreError)
        expect((err as KeyStoreError).code).toBe('corrupt_size')
      }
    })
  })

  test('read throws with code=corrupt_size when the file is not 32 bytes', async () => {
    await withTempKeysDir(async (keysDir) => {
      const store = createKeyStore({ keysDir })
      await store.ensure('kakao')
      await writeFile(store.keyPath('kakao'), Buffer.alloc(8))
      try {
        await store.read('kakao')
        throw new Error('expected throw')
      } catch (err) {
        expect(err).toBeInstanceOf(KeyStoreError)
        expect((err as KeyStoreError).code).toBe('corrupt_size')
      }
    })
  })

  test('rejects container names that could traverse the keys directory', async () => {
    await withTempKeysDir(async (keysDir) => {
      const store = createKeyStore({ keysDir })
      const bad = ['../escape', '/etc/passwd', 'has space', 'with/slash', '', '.hidden']
      for (const name of bad) {
        try {
          await store.ensure(name)
          throw new Error(`expected throw on ${JSON.stringify(name)}`)
        } catch (err) {
          expect(err).toBeInstanceOf(KeyStoreError)
          expect((err as KeyStoreError).code).toBe('invalid_name')
        }
      }
    })
  })

  test('keyPath is stable per name across invocations', async () => {
    await withTempKeysDir(async (keysDir) => {
      const store = createKeyStore({ keysDir })
      expect(store.keyPath('kakao')).toBe(store.keyPath('kakao'))
    })
  })

  test('read rejects symlinks at the key path (defense against same-user symlink attack)', async () => {
    await withTempKeysDir(async (keysDir) => {
      const store = createKeyStore({ keysDir })
      const decoyDir = await mkdtemp(join(tmpdir(), 'typeclaw-keys-decoy-'))
      const decoy = join(decoyDir, 'decoy.key')
      await writeFile(decoy, Buffer.alloc(32, 0x42))
      const fs = await import('node:fs/promises')
      await fs.mkdir(keysDir, { recursive: true })
      await symlink(decoy, store.keyPath('kakao'))
      try {
        await store.read('kakao')
        throw new Error('expected throw on symlinked key file')
      } catch (err) {
        if (!(err instanceof Error)) throw err
        expect(err.message).toMatch(/not a regular file/)
      }
    })
  })

  test('concurrent ensure() calls converge: both return the same key bytes (race-safe)', async () => {
    await withTempKeysDir(async (keysDir) => {
      const store = createKeyStore({ keysDir })
      const [a, b] = await Promise.all([store.ensure('kakao'), store.ensure('kakao')])
      expect(a.equals(b)).toBe(true)
    })
  })
})
