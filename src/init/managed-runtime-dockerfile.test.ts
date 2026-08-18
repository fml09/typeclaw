import { describe, expect, test } from 'bun:test'

import { GHCR_BASE_IMAGE_REPO } from './cli-version'
import { buildManagedRuntimeDockerfile, MANAGED_RUNTIME_UID } from './managed-runtime-dockerfile'

describe('buildManagedRuntimeDockerfile', () => {
  test('packages an immutable non-root runtime independent of /agent/node_modules', () => {
    const out = buildManagedRuntimeDockerfile({ baseImageVersion: '1.2.3' })

    expect(out).toContain(`FROM ${GHCR_BASE_IMAGE_REPO}:1.2.3`)
    expect(out).toContain('COPY typeclaw.tgz /tmp/typeclaw.tgz')
    expect(out).toContain('COPY typeclaw-gws-multi-account.tgz /tmp/typeclaw-gws-multi-account.tgz')
    expect(out).toContain('COPY package.json bun.lock /tmp/runtime-install/')
    expect(out).toContain('bun install --frozen-lockfile --production --ignore-scripts --linker=hoisted')
    expect(out).toContain('cp -a node_modules/. /node_modules/')
    expect(out).not.toContain('mv node_modules /node_modules')
    expect(out).toContain('tar -xzf /tmp/typeclaw.tgz')
    expect(out).toContain('tar -xzf /tmp/typeclaw-gws-multi-account.tgz')
    expect(out).not.toContain('bun add')
    expect(out).toContain('test ! -e /node_modules/node_modules')
    expect(out).toContain(`bun -e 'await import("zod")'`)
    expect(out).toContain('/node_modules/typeclaw/src/cli/index.ts')
    expect(out).not.toContain('/agent/node_modules/typeclaw/src/cli/index.ts')
    expect(out).toContain('apt-get install -y --no-install-recommends gh tini tmux python3')
    expect(out).toContain('TYPECLAW_HOME=/opt/typeclaw')
    expect(out).toContain('TYPECLAW_MODEL_CACHE=/opt/typeclaw/models')
    expect(out).toContain('TYPECLAW_DEPLOYMENT_PROFILE=managed')
    expect(out).toContain(`USER ${MANAGED_RUNTIME_UID}:${MANAGED_RUNTIME_UID}`)
    expect(out).toContain('HEALTHCHECK')
    expect(out).toContain('/health/live')
    expect(out).toContain('CMD ["run"]')
  })

  test('rejects a base image version that cannot be used as a release tag', () => {
    expect(() => buildManagedRuntimeDockerfile({ baseImageVersion: 'latest' })).toThrow('release version')
  })

  test('can bind PR validation to a checkout-built base image repository', () => {
    const out = buildManagedRuntimeDockerfile({
      baseImageVersion: '1.2.3',
      baseImageRepository: 'typeclaw-base-pr-arm64',
    })

    expect(out).toContain('FROM typeclaw-base-pr-arm64:1.2.3')
  })

  test('rejects a base image repository that can inject Dockerfile syntax', () => {
    expect(() =>
      buildManagedRuntimeDockerfile({
        baseImageVersion: '1.2.3',
        baseImageRepository: 'typeclaw-base\nRUN false',
      }),
    ).toThrow('base image repository')
  })
})
