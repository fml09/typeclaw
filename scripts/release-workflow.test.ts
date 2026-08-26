import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const workflow = readFileSync(join(import.meta.dir, '..', '.github', 'workflows', 'release.yml'), 'utf8')
const parsedWorkflow = Bun.YAML.parse(workflow) as {
  jobs: Record<
    string,
    {
      steps?: Array<{ uses?: string; with?: { ref?: string } }>
    }
  >
}

describe('release workflow immutable version tags', () => {
  test('serializes all versions before any mutable release state is written', () => {
    expect(workflow).toContain('group: release\n')
    expect(workflow).not.toContain('group: release-${{ github.event.inputs.version }}')
  })

  test('anchors both OCI indexes to the source commit and refuses to rewrite existing version tags', () => {
    expect(workflow.match(/index:org\.opencontainers\.image\.revision/g)).toHaveLength(2)
    expect(workflow).toContain("if: needs.checks.outputs.base_exists != 'true'")
    expect(workflow).toContain("if: needs.checks.outputs.runtime_exists != 'true'")
  })

  test('is registry-only: no npm publication, OIDC, or deploy-key credential remains', () => {
    // Fork divergence (ADR 0003 in fml09/typeclaw-operator): the `typeclaw`
    // npm package is upstream-owned, so trusted publishing can never be
    // configured here. The managed runtime image embeds its own dependency
    // graph, so nothing consumes npm at runtime either. These assertions
    // keep the registry-only posture from regressing.
    expect(workflow).not.toContain('npm publish')
    expect(workflow).not.toContain('--provenance')
    expect(workflow).not.toContain('registry-url')
    expect(workflow).not.toContain('secrets.DEPLOY_KEY')
    expect(workflow).not.toContain('id-token: write')
    expect(workflow).toContain('promote_latest: ${{ steps.preflight.outputs.promote_latest }}')
    // The managed runtime must FROM this fork's base image, never the
    // upstream-owned default that produced the first failed dispatch.
    expect(workflow).toContain(
      'emit-managed-runtime-dockerfile.ts "$VERSION" \\\n            "ghcr.io/${{ github.repository_owner }}/typeclaw-base"',
    )
    expect(workflow.match(/-t "\$\{REGISTRY_IMAGE\}:latest"/g)).toHaveLength(1)
    expect(workflow).toContain('"${REGISTRY_IMAGE}@${{ needs.merge-base.outputs.version_digest }}"')
  })

  test('derives latest promotion from repository release tags instead of npm', () => {
    expect(workflow).toContain("git ls-remote --tags origin 'refs/tags/[0-9]*'")
    expect(workflow).toContain("grep -E '^[0-9]+\\.[0-9]+\\.[0-9]+$'")
  })

  test('fails closed when image or git release identity belongs to another source commit', () => {
    expect(workflow).toContain('org.opencontainers.image.revision')
    expect(workflow).toContain('release tag source does not match workflow source')
    expect(workflow).toContain('source_sha="$(bash scripts/resolve-release-source.sh "$VERSION" "$GITHUB_SHA")"')
    expect(workflow).toContain('git checkout --detach "$source_sha"')
    expect(workflow).toContain('fetch-depth: 0')
    expect(workflow).toContain('validate-release-image-index.sh "$raw" "$SOURCE_SHA"')
    expect(workflow.match(/is-release-version-bump\.sh/g)).toHaveLength(2)
  })

  test('never force-moves a published version tag during repair', () => {
    expect(workflow).not.toMatch(/git tag -f/)
    expect(workflow).not.toMatch(/git push --force origin "refs\/tags/)
    expect(workflow).toContain("if: needs.checks.outputs.tag_exists != 'true'")
  })

  test('reserves the main-branch bump before builds and publishes from canonical source', () => {
    expect(workflow.indexOf('reserve-version:')).toBeLessThan(workflow.indexOf('build-base:'))
    expect(workflow).toContain('main moved before version ${VERSION} was reserved')
    expect(workflow).toContain('ref: ${{ needs.checks.outputs.source_sha }}')
    expect(workflow).toContain('BUMP_SHA: ${{ needs.reserve-version.outputs.bump_sha }}')
  })

  test('checks out the canonical release source in every downstream job', () => {
    const unpinned = Object.entries(parsedWorkflow.jobs).flatMap(([name, job]) =>
      name === 'checks'
        ? []
        : (job.steps ?? [])
            .filter((step) => step.uses?.startsWith('actions/checkout@'))
            .flatMap((step, index) =>
              step.with?.ref === '${{ needs.checks.outputs.source_sha }}' ? [] : [`${name} checkout ${index + 1}`],
            ),
    )

    expect(unpinned).toEqual([])
  })
})
