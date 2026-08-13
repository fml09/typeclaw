import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ViewerItem } from './item'
import { listViewerItems } from './item-list'
import { runViewerLoop, type TailController } from './loop'

let agentDir: string
let sessionsDir: string

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-item-list-'))
  sessionsDir = join(agentDir, 'sessions')
  await mkdir(sessionsDir, { recursive: true })
})

afterEach(async () => {
  await rm(agentDir, { recursive: true, force: true })
})

const ID_A = '019ee000-aaaa-7000-9000-00000000aaaa'
const ID_B = '019ee000-bbbb-7000-9000-00000000bbbb'
const ID_C = '019ee000-cccc-7000-9000-00000000cccc'

function numberedId(index: number): string {
  return `019ee000-${index.toString().padStart(4, '0')}-7000-9000-${index.toString().padStart(12, '0')}`
}

function metaLine(origin: unknown): string {
  return JSON.stringify({
    type: 'custom',
    customType: 'typeclaw.session-meta',
    data: { origin },
    timestamp: 1_000_000,
  })
}

async function seed(basename: string, origin: unknown, mtimeSeconds: number): Promise<void> {
  const path = join(sessionsDir, basename)
  await writeFile(path, metaLine(origin) + '\n')
  await utimes(path, mtimeSeconds, mtimeSeconds)
}

describe('listViewerItems', () => {
  test('marks the most-recent tui-origin session as the single writable item when container is up', async () => {
    await seed(`a_${ID_A}.jsonl`, { kind: 'tui' }, 1000)
    await seed(`b_${ID_B}.jsonl`, { kind: 'tui' }, 3000)
    await seed(`c_${ID_C}.jsonl`, { kind: 'cron', jobId: 'j', jobKind: 'prompt' }, 2000)

    const { items, writableSessionId } = await listViewerItems({
      sessionsDir,
      containerRunning: true,
      interactive: true,
    })

    expect(writableSessionId).toBe(ID_B)
    const writable = items.filter((i) => i.kind === 'tui')
    expect(writable).toHaveLength(1)
    expect(writable[0]).toMatchObject({ kind: 'tui', writable: true })
    const cronItem = items.find((i) => i.kind === 'session' && i.summary.sessionId === ID_C)
    expect(cronItem).toBeDefined()
  })

  test('all sessions are read-only when the container is down', async () => {
    await seed(`a_${ID_A}.jsonl`, { kind: 'tui' }, 1000)
    await seed(`b_${ID_B}.jsonl`, { kind: 'tui' }, 2000)

    const { items, writableSessionId } = await listViewerItems({
      sessionsDir,
      containerRunning: false,
      interactive: true,
    })

    expect(writableSessionId).toBeNull()
    expect(items.filter((i) => i.kind === 'tui')).toHaveLength(0)
    expect(items.filter((i) => i.kind === 'session')).toHaveLength(2)
  })

  test('allowWritable:false suppresses the writable row even with the container up (detach handoff)', async () => {
    await seed(`a_${ID_A}.jsonl`, { kind: 'tui' }, 1000)
    await seed(`b_${ID_B}.jsonl`, { kind: 'tui' }, 3000)

    const { items, writableSessionId } = await listViewerItems({
      sessionsDir,
      containerRunning: true,
      interactive: true,
      allowWritable: false,
    })

    expect(writableSessionId).toBeNull()
    expect(items.filter((i) => i.kind === 'tui')).toHaveLength(0)
    expect(items.filter((i) => i.kind === 'session')).toHaveLength(2)
  })

  test('appends a logs row by default, suppressible via includeLogs:false', async () => {
    await seed(`a_${ID_A}.jsonl`, { kind: 'tui' }, 1000)

    const withLogs = await listViewerItems({ sessionsDir, containerRunning: true, interactive: true })
    expect(withLogs.items.at(-1)).toEqual({ kind: 'logs' })

    const withoutLogs = await listViewerItems({
      sessionsDir,
      containerRunning: true,
      interactive: true,
      includeLogs: false,
    })
    expect(withoutLogs.items.some((i) => i.kind === 'logs')).toBe(false)
  })

  test('no writable item when container is up but no tui-origin session exists', async () => {
    await seed(`c_${ID_C}.jsonl`, { kind: 'cron', jobId: 'j', jobKind: 'prompt' }, 2000)

    const { writableSessionId, items } = await listViewerItems({
      sessionsDir,
      containerRunning: true,
      interactive: true,
    })

    expect(writableSessionId).toBeNull()
    expect(items.filter((i) => i.kind === 'tui')).toHaveLength(0)
  })

  test('overlays a live-only registry session not yet on disk', async () => {
    // given one disk session and a registry session with no .jsonl yet
    await seed(`a_${ID_A}.jsonl`, { kind: 'tui' }, 1000)

    const { items } = await listViewerItems({
      sessionsDir,
      containerRunning: true,
      interactive: true,
      liveSessions: [
        { sessionId: ID_B, origin: { kind: 'cron', jobId: 'j', jobKind: 'prompt' }, registeredAtMs: 9_000_000 },
      ],
    })

    // then the live session appears as a read-only session row flagged live
    const liveItem = items.find((i) => i.kind !== 'logs' && i.summary.sessionId === ID_B)
    expect(liveItem).toBeDefined()
    if (liveItem === undefined || liveItem.kind === 'logs') throw new Error('unreachable')
    expect(liveItem.summary.live).toBe(true)
    expect(liveItem.writable).toBe(false)
  })

  test('a live tui session already flushed to disk is not duplicated', async () => {
    // given a tui session present both on disk and in the registry
    await seed(`a_${ID_A}.jsonl`, { kind: 'tui' }, 1000)

    const { items } = await listViewerItems({
      sessionsDir,
      containerRunning: true,
      interactive: true,
      liveSessions: [{ sessionId: ID_A, origin: { kind: 'tui' }, registeredAtMs: 9_000_000 }],
    })

    // then it appears exactly once, sourced from disk (no live flag)
    const rows = items.filter((i) => i.kind !== 'logs' && i.summary.sessionId === ID_A)
    expect(rows).toHaveLength(1)
    if (rows[0]?.kind === 'logs') throw new Error('unreachable')
    expect(rows[0]?.summary.live).toBeUndefined()
  })

  test('a registry session below the disk summary limit stays disk-backed and does not expand the picker', async () => {
    const diskIds: string[] = []
    for (let index = 0; index < 21; index++) {
      const id = numberedId(index)
      diskIds.push(id)
      await seed(`session_${id}.jsonl`, { kind: 'cron', jobId: `${index}`, jobKind: 'prompt' }, 1000 + index)
    }

    const { items } = await listViewerItems({
      sessionsDir,
      containerRunning: true,
      interactive: true,
      includeLogs: false,
      limit: 20,
      liveSessions: [{ sessionId: diskIds[0]!, origin: { kind: 'tui' }, registeredAtMs: 9_000_000 }],
    })

    expect(items).toHaveLength(20)
    expect(items.some((item) => item.kind !== 'logs' && item.summary.sessionId === diskIds[0])).toBe(false)
    expect(items.filter((item) => item.kind !== 'logs' && item.summary.live === true)).toHaveLength(0)
  })

  test('a registry-only session displaces the oldest selected history row within the requested limit', async () => {
    const diskIds: string[] = []
    for (let index = 0; index < 21; index++) {
      const id = numberedId(index)
      diskIds.push(id)
      await seed(`session_${id}.jsonl`, { kind: 'cron', jobId: `${index}`, jobKind: 'prompt' }, 1000 + index)
    }
    const registryOnlyId = ID_A

    const { items } = await listViewerItems({
      sessionsDir,
      containerRunning: true,
      interactive: true,
      includeLogs: false,
      limit: 20,
      liveSessions: [{ sessionId: registryOnlyId, origin: { kind: 'tui' }, registeredAtMs: 9_000_000 }],
    })

    expect(items).toHaveLength(20)
    expect(items[0]).toMatchObject({ summary: { sessionId: registryOnlyId, live: true } })
    expect(items.some((item) => item.kind !== 'logs' && item.summary.sessionId === diskIds[1])).toBe(false)
    expect(items.some((item) => item.kind !== 'logs' && item.summary.sessionId === diskIds[20])).toBe(true)
  })

  test('non-TTY run classifies the most-recent tui-origin session read-only even with the container up', async () => {
    await seed(`a_${ID_A}.jsonl`, { kind: 'tui' }, 3000)
    await seed(`c_${ID_C}.jsonl`, { kind: 'cron', jobId: 'j', jobKind: 'prompt' }, 2000)

    const { items, writableSessionId } = await listViewerItems({
      sessionsDir,
      containerRunning: true,
      interactive: false,
    })

    expect(writableSessionId).toBeNull()
    expect(items.filter((i) => i.kind === 'tui')).toHaveLength(0)
    const tuiRow = items.find((i) => i.kind !== 'logs' && i.summary.sessionId === ID_A)
    expect(tuiRow).toMatchObject({ kind: 'session', writable: false })
  })
})

function fakeScope(): TailController {
  const ctrl = new AbortController()
  return { signal: ctrl.signal, intent: () => null, dispose: () => ctrl.abort() }
}

describe('non-TTY explicit tui-origin id (regression: PR #1285)', () => {
  test('auto-opens as a read-only session and never launches the tui viewer or the picker', async () => {
    // given a tui-origin session that IS the writable candidate when the
    // container is up — the exact row that would dispatch to runTuiViewer
    await seed(`a_${ID_A}.jsonl`, { kind: 'tui' }, 3000)
    const { items } = await listViewerItems({ sessionsDir, containerRunning: true, interactive: false })

    let opened: ViewerItem | undefined
    let pickerCalls = 0

    // when an explicit id preselects that session without a TTY
    const result = await runViewerLoop<ViewerItem>({
      listItems: async () => items,
      keyOf: (item) => (item.kind === 'logs' ? 'logs' : item.summary.sessionId),
      preselectKey: ID_A,
      selectItem: async () => {
        pickerCalls++
        return { kind: 'cancelled' }
      },
      openItem: async (item) => {
        opened = item
        return { result: { ok: true, exitCode: 0 } }
      },
      createTailScope: fakeScope,
      onEmpty: () => ({ ok: false, exitCode: 1, reason: 'empty' }),
    })

    // then it opens read-only (so openViewerItem bypasses its tui branch) and
    // the clack picker is never reached
    expect(result).toEqual({ ok: true, exitCode: 0 })
    expect(pickerCalls).toBe(0)
    expect(opened).toMatchObject({ kind: 'session', writable: false, summary: { sessionId: ID_A } })
  })
})
