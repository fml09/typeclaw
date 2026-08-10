import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { enforceAndPinToolFiles, enforceCanonicalSecretDenial } from './tool-file-safety'

test('enforceCanonicalSecretDenial ignores non-file declarations for canonical credentials', async () => {
  const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-canonical-denial-'))
  const options = {
    tool: 'mcp_call',
    args: { pattern: 'secrets.json' },
    agentDir,
    fileOperands: { nonFile: ['pattern'] },
  }

  try {
    expect(() => enforceCanonicalSecretDenial(options)).toThrow(/^blocked:/)
  } finally {
    await rm(agentDir, { recursive: true, force: true })
  }
})

test('enforceCanonicalSecretDenial trusts prose semantics only for first-party builtins', async () => {
  const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-canonical-prose-'))

  try {
    expect(() =>
      enforceCanonicalSecretDenial({
        tool: 'write',
        args: { path: 'public/report.md', content: 'x'.repeat(300) },
        agentDir,
        toolProvenance: 'first-party',
      }),
    ).not.toThrow()
    expect(() =>
      enforceCanonicalSecretDenial({
        tool: 'write',
        args: { path: 'public/report.md', content: 'secrets.json' },
        agentDir,
        toolProvenance: 'plugin',
      }),
    ).toThrow(/^blocked:/)
  } finally {
    await rm(agentDir, { recursive: true, force: true })
  }
})

test('plugin collisions cannot inherit first-party no-file-operand shortcuts', async () => {
  const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-canonical-collision-'))

  try {
    await expect(
      enforceAndPinToolFiles({
        tool: 'channel_read',
        args: { path: 'secrets.json' },
        agentDir,
        genericInputs: true,
        toolProvenance: 'plugin',
      }),
    ).rejects.toThrow(/blocked:|ambiguous local file operand/)
  } finally {
    await rm(agentDir, { recursive: true, force: true })
  }
})
