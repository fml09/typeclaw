import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const skill = readFileSync(join(import.meta.dir, 'typeclaw-channel-github', 'SKILL.md'), 'utf8')

describe('typeclaw-channel-github PR review instructions', () => {
  test('minimal intake captures identity then delegates immediately without parent diff analysis', () => {
    const lower = skill.toLowerCase()
    expect(lower).toContain('minimal intake')
    expect(lower).toContain('repo, pr number, current head sha')
    expect(lower).toContain('delegate immediately')
    expect(lower).toContain('do not run `gh pr diff`')
  })

  test('waits event-driven and does not poll before completion', () => {
    const lower = skill.toLowerCase()
    expect(lower).toContain('completion `<system-reminder>`')
    expect(lower).toContain('do not poll `subagent_output`')
    expect(lower).toContain('only after that reminder')
  })

  test('parent verification is proportional and limited to reviewer-cited anchors', () => {
    const lower = skill.toLowerCase()
    expect(lower).toContain('validate only the cited anchors')
    expect(lower).toContain('do not re-review the diff')
    expect(lower).toContain('proportional')
  })
})
