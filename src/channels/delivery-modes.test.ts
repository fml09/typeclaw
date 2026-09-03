import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { channelDeliveryModesPath, loadChannelDeliveryModes, saveChannelDeliveryModes } from './delivery-modes'

const silentLogger = { warn: () => {}, error: () => {} }

async function agentDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'channels-delivery-modes-'))
}

describe('channel delivery modes', () => {
  test('round-trips overrides through the file', async () => {
    const dir = await agentDir()
    await saveChannelDeliveryModes(
      dir,
      new Map([
        ['discord-bot:g1:c1:', 'steer'],
        ['slack-bot:w1:c2:t3', 'queue'],
      ]),
      silentLogger,
    )

    expect(await loadChannelDeliveryModes(dir, silentLogger)).toEqual(
      new Map([
        ['discord-bot:g1:c1:', 'steer'],
        ['slack-bot:w1:c2:t3', 'queue'],
      ]),
    )
  })

  test('leaves no temp file behind after the atomic write', async () => {
    const dir = await agentDir()
    await saveChannelDeliveryModes(dir, new Map([['discord-bot:g1:c1:', 'steer']]), silentLogger)

    const entries = await readdir(dirname(channelDeliveryModesPath(dir)))
    expect(entries).toEqual(['delivery-modes.json'])
  })

  test('a missing file is the normal empty state, not an error', async () => {
    const dir = await agentDir()
    expect(await loadChannelDeliveryModes(dir, silentLogger)).toEqual(new Map())
  })

  test('a corrupt file starts empty and says so', async () => {
    const dir = await agentDir()
    const path = channelDeliveryModesPath(dir)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, '{ not json', 'utf8')
    const errors: string[] = []

    const modes = await loadChannelDeliveryModes(dir, { warn: () => {}, error: (m) => errors.push(m) })

    expect(modes).toEqual(new Map())
    expect(errors.some((m) => m.includes('corrupted'))).toBe(true)
  })

  test('an unknown file version is ignored rather than half-read', async () => {
    const dir = await agentDir()
    const path = channelDeliveryModesPath(dir)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify({ version: 99, modes: { 'discord-bot:g1:c1:': 'steer' } }), 'utf8')
    const warnings: string[] = []

    const modes = await loadChannelDeliveryModes(dir, { warn: (m) => warnings.push(m), error: () => {} })

    expect(modes).toEqual(new Map())
    expect(warnings.some((m) => m.includes('version 99 not supported'))).toBe(true)
  })

  test('drops entries whose mode is not steer or queue', async () => {
    const dir = await agentDir()
    const path = channelDeliveryModesPath(dir)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(
      path,
      JSON.stringify({ version: 1, modes: { 'discord-bot:g1:c1:': 'inject', 'discord-bot:g1:c2:': 'queue' } }),
      'utf8',
    )

    expect(await loadChannelDeliveryModes(dir, silentLogger)).toEqual(new Map([['discord-bot:g1:c2:', 'queue']]))
  })
})
