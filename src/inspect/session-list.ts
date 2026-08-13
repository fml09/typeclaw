import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

import type { MinimalSessionOrigin } from '@/agent/session-meta'
import type { LiveSessionPayload } from '@/shared'

import { previewForHint } from './preview'
import { replayJsonl } from './replay'

export type SessionSummary = {
  sessionId: string
  sessionFile: string
  basename: string
  mtimeMs: number
  origin: MinimalSessionOrigin | null
  firstPrompt: string | null
  // True only for a registered session with no .jsonl on disk yet. Registration
  // means the session is warm, not that a reply is currently in flight. Disk
  // sessions leave this undefined.
  live?: boolean
}

export type ListSessionsOptions = {
  sessionsDir: string
  limit?: number
  sinceMs?: number
  onWarn?: (msg: string) => void
  liveSessions?: LiveSessionPayload[]
}

// pi-coding-agent writes session files as `${ISO_TIMESTAMP}_${SESSION_ID}.jsonl`,
// where SESSION_ID is a UUIDv7 by default. Older typeclaw versions (pre-May
// 2026, before the channel session-file basename was persisted) also produced
// bare `${SESSION_ID}.jsonl` files; legacy agent folders still carry those
// alongside the canonical form, and skipping them hides real history from
// `typeclaw inspect`. Accept both shapes: take whatever follows the last `_`
// as the id, or the whole stem when no `_` is present. The id must be
// filesystem-safe (no `/`, `\`, or whitespace) and must start with a non-`_`
// character so empty-id filenames like `_.jsonl` don't slip through.
const FILENAME_PATTERN = /^(?:.*_)?([^_/\\\s][^/\\\s]*)\.jsonl$/

// Bounds concurrent per-file I/O. An agent folder can hold tens of thousands of
// session files, and an unbounded `Promise.all` over them opens one file
// descriptor per concurrent stat/stream — enough to blow past a 256 `ulimit -n`
// and crash the process with EMFILE. 32 keeps throughput high while staying well
// under any sane FD ceiling.
const SESSION_IO_CONCURRENCY = 32

// A dependency-free bounded worker pool: `concurrency` workers pull from a shared
// cursor until the list is drained, preserving input order in the result.
async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (true) {
      const index = next++
      if (index >= items.length) return
      results[index] = await fn(items[index]!, index)
    }
  }
  const workerCount = Math.min(concurrency, items.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return results
}

type StatEntry = { path: string; basename: string; sessionId: string; mtimeMs: number }

// Split from listSessions so resolveSession can match ids first and peek only the
// candidates, instead of reading every file body on disk. Reads no file content.
async function statSessionFiles(opts: ListSessionsOptions): Promise<StatEntry[]> {
  return (await scanSessionFiles(opts)).eligible
}

async function scanSessionFiles(
  opts: ListSessionsOptions,
): Promise<{ eligible: StatEntry[]; onDiskSessionIds: Set<string> }> {
  const entries = await readSessionFiles(opts.sessionsDir, opts.onWarn)
  const withStats = await mapConcurrent(entries, SESSION_IO_CONCURRENCY, async (entry) => {
    const s = await safeStat(entry.path)
    if (s === null) return null
    const mtimeMs = s.mtimeMs
    return { ...entry, mtimeMs }
  })
  const valid = withStats.filter((v): v is StatEntry => v !== null)
  const eligible = opts.sinceMs === undefined ? valid : valid.filter((entry) => entry.mtimeMs >= opts.sinceMs!)
  eligible.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return { eligible, onDiskSessionIds: new Set(valid.map((entry) => entry.sessionId)) }
}

async function summarizeEntry(entry: StatEntry, onWarn?: (msg: string) => void): Promise<SessionSummary> {
  const peek = await peekSession(entry.path, onWarn)
  return {
    sessionId: entry.sessionId,
    sessionFile: entry.path,
    basename: entry.basename,
    mtimeMs: entry.mtimeMs,
    origin: peek.origin,
    firstPrompt: peek.firstPrompt,
  }
}

export async function listSessions(opts: ListSessionsOptions): Promise<SessionSummary[]> {
  const { eligible, onDiskSessionIds } = await scanSessionFiles(opts)
  const limited = opts.limit !== undefined ? eligible.slice(0, opts.limit) : eligible
  const disk = await mapConcurrent(limited, SESSION_IO_CONCURRENCY, (entry) => summarizeEntry(entry, opts.onWarn))
  if (opts.liveSessions === undefined || opts.liveSessions.length === 0) return disk
  return mergeLiveSessions(disk, opts.liveSessions, { onDiskSessionIds, limit: opts.limit })
}

// Overlay container-registry sessions onto the disk listing. A live session
// already flushed to disk is dropped from the overlay — the disk
// summary wins, carrying its real mtime and prompt preview. Only sessions with
// no .jsonl yet become synthetic live rows, sorted to the top by registration
// time. The final limit applies after merging, so registry-only rows displace
// older history rather than expanding the picker.
export function mergeLiveSessions(
  disk: SessionSummary[],
  live: LiveSessionPayload[],
  opts: { onDiskSessionIds?: ReadonlySet<string>; limit?: number } = {},
): SessionSummary[] {
  const onDisk = opts.onDiskSessionIds ?? new Set(disk.map((s) => s.sessionId))
  const liveOnly = live
    .filter((l) => !onDisk.has(l.sessionId))
    .map(
      (l): SessionSummary => ({
        sessionId: l.sessionId,
        sessionFile: '',
        basename: '',
        mtimeMs: l.registeredAtMs,
        origin: l.origin,
        firstPrompt: null,
        live: true,
      }),
    )
  const merged = [...liveOnly, ...disk].sort((a, b) => b.mtimeMs - a.mtimeMs)
  return opts.limit !== undefined ? merged.slice(0, opts.limit) : merged
}

export type ResolveResult =
  | { ok: true; summary: SessionSummary }
  | { ok: false; reason: 'not-found' | 'ambiguous'; matches: SessionSummary[] }

const MIN_PREFIX_LENGTH = 4

export async function resolveSession(
  sessionsDir: string,
  sessionIdOrPrefix: string,
  onWarn?: (msg: string) => void,
): Promise<ResolveResult> {
  // Match on stat-only metadata (filename-derived id + mtime) first, then peek
  // ONLY the matched candidates. Peeking every session to find one by id/prefix
  // opened a file descriptor per file — tens of thousands at once on a busy agent,
  // which crashes with EMFILE. Id resolution never needs a file's body.
  const entries = await statSessionFiles({ sessionsDir, ...(onWarn !== undefined ? { onWarn } : {}) })

  const exact = entries.find((e) => e.sessionId === sessionIdOrPrefix)
  if (exact !== undefined) return { ok: true, summary: await summarizeEntry(exact, onWarn) }

  if (sessionIdOrPrefix.length < MIN_PREFIX_LENGTH || !isSessionIdShape(sessionIdOrPrefix)) {
    return { ok: false, reason: 'not-found', matches: [] }
  }
  const prefixMatches = entries.filter((e) => e.sessionId.startsWith(sessionIdOrPrefix))
  if (prefixMatches.length === 0) return { ok: false, reason: 'not-found', matches: [] }
  if (prefixMatches.length === 1) return { ok: true, summary: await summarizeEntry(prefixMatches[0]!, onWarn) }
  const matches = await mapConcurrent(prefixMatches, SESSION_IO_CONCURRENCY, (e) => summarizeEntry(e, onWarn))
  return { ok: false, reason: 'ambiguous', matches }
}

const SESSION_ID_SHAPE = /^[^_/\\\s][^/\\\s]*$/

export function isSessionIdShape(value: string): boolean {
  return SESSION_ID_SHAPE.test(value)
}

async function readSessionFiles(
  dir: string,
  onWarn?: (msg: string) => void,
): Promise<{ path: string; basename: string; sessionId: string }[]> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true, encoding: 'utf8' })
  } catch (err) {
    if (isNoEnt(err)) return []
    throw err
  }
  const out: { path: string; basename: string; sessionId: string }[] = []
  for (const entry of entries) {
    const name = entry.name
    if (!name.endsWith('.jsonl')) continue
    if (!entry.isFile() && !entry.isSymbolicLink()) {
      onWarn?.(`skipping non-file in sessions/: ${name}`)
      continue
    }
    const match = FILENAME_PATTERN.exec(name)
    if (!match) {
      onWarn?.(`skipping session file with unexpected name: ${name}`)
      continue
    }
    out.push({ path: join(dir, name), basename: name, sessionId: match[1]! })
  }
  return out
}

async function safeStat(path: string): Promise<{ mtimeMs: number } | null> {
  try {
    const s = await stat(path)
    return { mtimeMs: s.mtimeMs }
  } catch {
    return null
  }
}

const PREVIEW_MAX_BYTES = 64 * 1024

async function peekSession(
  path: string,
  onWarn?: (msg: string) => void,
): Promise<{ origin: MinimalSessionOrigin | null; firstPrompt: string | null }> {
  let origin: MinimalSessionOrigin | null = null
  const userTexts: string[] = []
  let bytesRead = 0
  for await (const event of replayJsonl(path, onWarn !== undefined ? { onWarn } : {})) {
    if (event.cat === 'meta' && origin === null) origin = event.origin
    if (event.cat === 'user' && userTexts.length < MAX_PREVIEW_CANDIDATES) userTexts.push(event.text)
    if (origin !== null && userTexts.length >= MAX_PREVIEW_CANDIDATES) break
    bytesRead += approximateSize(event)
    if (bytesRead > PREVIEW_MAX_BYTES) break
  }
  // Resolve the hint after the loop so origin (which selects the extraction
  // strategy) is known even if a user event precedes the meta event. A turn
  // that is pure injected preamble yields null, so fall through to the next user
  // turn for a useful glance.
  let firstPrompt: string | null = null
  for (const text of userTexts) {
    firstPrompt = previewForHint(origin, text)
    if (firstPrompt !== null) break
  }
  return { origin, firstPrompt }
}

const MAX_PREVIEW_CANDIDATES = 5

function approximateSize(event: { ts: number }): number {
  return JSON.stringify(event).length
}

function isNoEnt(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT'
}
