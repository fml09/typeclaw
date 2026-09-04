import { existsSync } from 'node:fs'
import { chmod, lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { fingerprintKey, generateKey } from './encryption'

const KEY_FILE_MODE = 0o600
const KEY_DIR_MODE = 0o700
const KEY_BYTES = 32

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/

export class KeyStoreError extends Error {
  constructor(
    message: string,
    public readonly code: 'invalid_name' | 'missing' | 'corrupt_size' | 'not_a_regular_file' | 'race_lost',
  ) {
    super(message)
    this.name = 'KeyStoreError'
  }
}

export type KeyStoreOptions = {
  keysDir: string
}

// Shared by hostd and the managed runtime credential renewer. Keeping the
// location next to KeyStore avoids making container-stage code import
// hostd/paths merely to find the durable encryption-key directory.
export function defaultKeyStoreDir(env: NodeJS.ProcessEnv = process.env, homeDir = homedir()): string {
  const root = env.TYPECLAW_HOME && env.TYPECLAW_HOME.length > 0 ? env.TYPECLAW_HOME : join(homeDir, '.typeclaw')
  return join(root, 'keys')
}

// Per-agent symmetric key store. Each container/agent gets its own 32-byte
// random key under <keysDir>/<containerName>.key (file mode 0600, dir 0700).
// In the host profile, the host CLI generates and reads these and hostd uses
// them for renewal; the container never receives the key. In the managed
// profile, the trusted runtime receives the platform-provided durable home and
// uses the same key only for credential renewal fallback.
export function createKeyStore(opts: KeyStoreOptions): KeyStore {
  const ensureDir = async (): Promise<void> => {
    await mkdir(opts.keysDir, { recursive: true })
    await chmod(opts.keysDir, KEY_DIR_MODE).catch(() => {})
    await chmod(dirname(opts.keysDir), KEY_DIR_MODE).catch(() => {})
  }

  const keyPath = (containerName: string): string => {
    if (!SAFE_NAME.test(containerName)) {
      throw new KeyStoreError(`invalid container name for key file: ${JSON.stringify(containerName)}`, 'invalid_name')
    }
    return join(opts.keysDir, `${containerName}.key`)
  }

  return {
    keyPath,

    exists(containerName: string): boolean {
      try {
        return existsSync(keyPath(containerName))
      } catch {
        return false
      }
    },

    async read(containerName: string): Promise<Buffer> {
      const path = keyPath(containerName)
      if (!existsSync(path)) {
        throw new KeyStoreError(`key file missing: ${path}`, 'missing')
      }
      await assertRegularFile(path)
      const buf = await readFile(path)
      if (buf.length !== KEY_BYTES) {
        throw new KeyStoreError(`key file is ${buf.length} bytes (expected ${KEY_BYTES}): ${path}`, 'corrupt_size')
      }
      return buf
    },

    async ensure(containerName: string): Promise<Buffer> {
      const path = keyPath(containerName)
      if (existsSync(path)) {
        await assertRegularFile(path)
        const existing = await readFile(path)
        if (existing.length === KEY_BYTES) return existing
        // Corrupt-size key: surface rather than silently overwrite. The user
        // may have a backup; replacing it here would make every existing
        // ciphertext permanently undecryptable without telling them.
        throw new KeyStoreError(
          `existing key file is ${existing.length} bytes (expected ${KEY_BYTES}): ${path}. ` +
            'Move it aside and re-run reauth to mint a fresh key.',
          'corrupt_size',
        )
      }
      await ensureDir()
      // Exclusive-create (wx flag) makes the first-write race-safe: if two
      // processes both pass the existsSync check above and race, only one
      // wx open of the temp file (or the final-path file via rename below)
      // succeeds. The loser reads the winning key off disk and returns IT
      // rather than its own bytes. Without this, the loser's
      // secrets.json#encryptedPassword would be ciphertext for a key that
      // just got overwritten by the winner's rename — silent
      // undecryptable-ness.
      const fresh = generateKey()
      // Per-PID-and-randomized temp path so two same-process concurrent
      // ensure() calls don't collide on the same temp file. The crypto-random
      // suffix is the only reason same-process concurrency is safe at all.
      const tmpSuffix = Math.random().toString(36).slice(2, 10)
      const tmp = `${path}.${process.pid}.${tmpSuffix}.tmp`
      try {
        await writeFile(tmp, fresh, { mode: KEY_FILE_MODE, flag: 'wx' })
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code !== 'EEXIST') throw err
        // Astronomically unlikely (same pid AND same random suffix). Treat
        // as a corruption signal and surface; do not silently overwrite.
        throw new KeyStoreError(`temp key path collision at ${tmp}; refusing to overwrite`, 'race_lost')
      }
      try {
        // link() is atomic and refuses to overwrite an existing dest. If the
        // dest already exists, another process won the race; link will throw
        // EEXIST. We then unlink our tmp and read the winner's bytes.
        const fs = await import('node:fs/promises')
        await fs.link(tmp, path)
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        const fs = await import('node:fs/promises')
        if (code === 'EEXIST') {
          await fs.unlink(tmp).catch(() => {})
          if (!existsSync(path)) {
            throw new KeyStoreError(
              `key path ${path} reports EEXIST but is not present; refusing to retry`,
              'race_lost',
            )
          }
          await assertRegularFile(path)
          const winner = await readFile(path)
          if (winner.length !== KEY_BYTES) {
            throw new KeyStoreError(
              `race winner key at ${path} is ${winner.length} bytes (expected ${KEY_BYTES})`,
              'race_lost',
            )
          }
          return winner
        }
        await fs.unlink(tmp).catch(() => {})
        throw err
      }
      // Clean up the temp file (the link succeeded; tmp is now a second
      // hardlink that we no longer need). Best-effort.
      const fs2 = await import('node:fs/promises')
      await fs2.unlink(tmp).catch(() => {})
      await chmod(path, KEY_FILE_MODE).catch(() => {})
      return fresh
    },

    fingerprint(key: Buffer): string {
      return fingerprintKey(key)
    },
  }
}

export type KeyStore = {
  keyPath: (containerName: string) => string
  exists: (containerName: string) => boolean
  read: (containerName: string) => Promise<Buffer>
  ensure: (containerName: string) => Promise<Buffer>
  fingerprint: (key: Buffer) => string
}

// Reject symlinks (and other non-regular files) so a same-user attacker who
// can write under ~/.typeclaw/keys/ can't pre-place <name>.key as a symlink
// to another 32-byte readable file and have TypeClaw treat that file's
// content as the encryption key. lstat refuses to follow the link itself.
async function assertRegularFile(path: string): Promise<void> {
  const info = await lstat(path)
  if (!info.isFile()) {
    throw new KeyStoreError(
      `key path ${path} is not a regular file (mode=${info.mode.toString(8)})`,
      'not_a_regular_file',
    )
  }
}
