import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

describe('channel skill descriptions', () => {
  test('never mandate reading a skill before every reply', async () => {
    const skillsRoot = resolve(import.meta.dir)
    const glob = new Bun.Glob('typeclaw-channel-*/SKILL.md')
    const paths = [...glob.scanSync({ cwd: skillsRoot, absolute: true })]
    expect(paths.length).toBeGreaterThan(0)

    for (const path of paths) {
      const source = await Bun.file(path).text()
      const description = source.match(/^description:\s*(.+)$/m)?.[1]
      expect(description, `${path} has a single-line description`).toBeDefined()
      expect(description, path).not.toMatch(/BEFORE every/i)
      expect(description, path).not.toMatch(/before composing replies/i)
      expect(description, path).not.toMatch(/Read this skill before composing/i)
    }
  })
})
