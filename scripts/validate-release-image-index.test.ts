import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratchDirs: string[] = []
const validator = join(import.meta.dir, 'validate-release-image-index.sh')

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function validate(manifest: unknown, revision = 'source-sha'): ReturnType<typeof Bun.spawnSync> {
  const dir = mkdtempSync(join(tmpdir(), 'typeclaw-release-index-'))
  scratchDirs.push(dir)
  const path = join(dir, 'manifest.json')
  writeFileSync(path, JSON.stringify(manifest))
  return Bun.spawnSync(['bash', validator, path, revision], { stdout: 'pipe', stderr: 'pipe' })
}

type ManifestDescriptor = {
  mediaType: string
  digest: string
  size: number
  platform: { os: string; architecture: string }
  annotations?: Record<string, string>
}

function index(platforms: Array<{ os: string; architecture: string }>) {
  return {
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.index.v1+json',
    annotations: { 'org.opencontainers.image.revision': 'source-sha' },
    manifests: platforms.map<ManifestDescriptor>((platform, index) => ({
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      digest: `sha256:${String(index).padStart(64, '0')}`,
      size: 1,
      platform,
    })),
  }
}

describe('validate-release-image-index.sh', () => {
  test('accepts the paired amd64 and arm64 release index', () => {
    const result = validate(
      index([
        { os: 'linux', architecture: 'amd64' },
        { os: 'linux', architecture: 'arm64' },
      ]),
    )

    expect(result.exitCode).toBe(0)
  })

  test('accepts BuildKit attestation descriptors alongside the paired images', () => {
    const manifest = index([
      { os: 'linux', architecture: 'amd64' },
      { os: 'linux', architecture: 'arm64' },
    ])
    manifest.manifests.push({
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      digest: `sha256:${'a'.repeat(64)}`,
      size: 1,
      platform: { os: 'unknown', architecture: 'unknown' },
      annotations: { 'vnd.docker.reference.type': 'attestation-manifest' },
    })

    expect(validate(manifest).exitCode).toBe(0)
  })

  test('rejects a single-platform manifest even with the expected revision annotation', () => {
    const result = validate({
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      annotations: { 'org.opencontainers.image.revision': 'source-sha' },
    })

    expect(result.exitCode).toBe(1)
  })

  test('rejects an index missing one required architecture', () => {
    const result = validate(index([{ os: 'linux', architecture: 'amd64' }]))

    expect(result.exitCode).toBe(1)
  })

  test('rejects unrelated platform descriptors beyond the paired images', () => {
    const result = validate(
      index([
        { os: 'linux', architecture: 'amd64' },
        { os: 'linux', architecture: 'arm64' },
        { os: 'windows', architecture: 'amd64' },
      ]),
    )

    expect(result.exitCode).toBe(1)
  })

  test('rejects an unmarked unknown descriptor', () => {
    const result = validate(
      index([
        { os: 'linux', architecture: 'amd64' },
        { os: 'linux', architecture: 'arm64' },
        { os: 'unknown', architecture: 'unknown' },
      ]),
    )

    expect(result.exitCode).toBe(1)
  })
})
