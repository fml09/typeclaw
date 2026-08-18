import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const workflow = readFileSync(join(import.meta.dir, '..', '.github', 'workflows', 'release.yml'), 'utf8')

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

  test('promotes mutable latest tags only after npm publish and never during an older repair', () => {
    expect(workflow).toContain('promote_latest: ${{ steps.preflight.outputs.promote_latest }}')
    expect(workflow).toContain('npm publish --provenance --access public --tag "release-${VERSION//./-}"')
    expect(workflow.indexOf('- name: Publish to npm')).toBeLessThan(
      workflow.indexOf('- name: Promote matching base image to latest'),
    )
    expect(workflow.match(/-t "\$\{REGISTRY_IMAGE\}:latest"/g)).toHaveLength(1)
    expect(workflow).toContain('"${REGISTRY_IMAGE}@${{ needs.merge-base.outputs.version_digest }}"')
  })

  test('fails closed when npm, image, or git release identity belongs to another source commit', () => {
    expect(workflow).toContain('npm_git_head')
    expect(workflow).toContain('org.opencontainers.image.revision')
    expect(workflow).toContain('release tag source does not match workflow source')
    expect(workflow).toContain('published npm source does not match workflow source')
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
})
