import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { describeError } from './describe-error'

const FILE_VERSION = 1

// The per-channel-key override of the mid-turn delivery path, set from a
// channel with /steer and /queue. Absence of an entry (rather than a third enum
// value) is what "no override" means, so the adapter's `steer.enabled` config
// keeps deciding for every channel nobody has spoken for.
export type ChannelDeliveryMode = 'steer' | 'queue'

type FileV1 = {
  version: 1
  modes: Record<string, ChannelDeliveryMode>
}

export type ChannelDeliveryModesLogger = {
  warn: (msg: string) => void
  error: (msg: string) => void
}

const consoleLogger: ChannelDeliveryModesLogger = {
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
}

// Deliberately its OWN file rather than a field on ChannelSessionRecord. That
// record carries a migration chain (FILE_VERSION 7 plus four legacy readers)
// keyed to session identity; a per-key delivery preference has nothing to do
// with which session a channel is bound to, outlives every session rollover,
// and would force each future sessions.json migration to carry it along.
export function channelDeliveryModesPath(agentDir: string): string {
  return join(agentDir, 'channels', 'delivery-modes.json')
}

export async function loadChannelDeliveryModes(
  agentDir: string,
  logger: ChannelDeliveryModesLogger = consoleLogger,
): Promise<Map<string, ChannelDeliveryMode>> {
  const path = channelDeliveryModesPath(agentDir)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    // No file is the normal state: nobody has run /steer or /queue here yet.
    return new Map()
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    logger.error(`[channels] ${path} corrupted: ${describeError(err)}; starting with no delivery-mode overrides`)
    return new Map()
  }
  if (typeof parsed !== 'object' || parsed === null) {
    logger.warn(`[channels] ${path} not an object; ignored`)
    return new Map()
  }
  const file = parsed as Partial<FileV1>
  if (file.version !== FILE_VERSION) {
    logger.warn(`[channels] ${path} version ${String(file.version)} not supported (expected ${FILE_VERSION}); ignored`)
    return new Map()
  }
  const modes = new Map<string, ChannelDeliveryMode>()
  if (typeof file.modes !== 'object' || file.modes === null) return modes
  for (const [keyId, mode] of Object.entries(file.modes)) {
    // An unknown mode string is dropped rather than trusted: the gate reads
    // this map directly, and an unrecognized value there would be neither
    // steer nor queue.
    if (keyId.length > 0 && (mode === 'steer' || mode === 'queue')) modes.set(keyId, mode)
  }
  return modes
}

export async function saveChannelDeliveryModes(
  agentDir: string,
  modes: ReadonlyMap<string, ChannelDeliveryMode>,
  logger: ChannelDeliveryModesLogger = consoleLogger,
): Promise<void> {
  const path = channelDeliveryModesPath(agentDir)
  const payload: FileV1 = { version: FILE_VERSION, modes: Object.fromEntries(modes) }
  try {
    await mkdir(dirname(path), { recursive: true })
    // Write-then-rename so a crash mid-write leaves the previous overrides
    // intact instead of a truncated file the next boot would discard.
    const tmp = `${path}.tmp`
    await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    await rename(tmp, path)
  } catch (err) {
    logger.error(`[channels] failed to persist delivery modes: ${describeError(err)}`)
  }
}
