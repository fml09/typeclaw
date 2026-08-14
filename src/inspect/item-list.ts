import type { ViewerItem } from './item'
import { listSessions, type ListSessionsOptions, type SessionSummary } from './session-list'

export type ListViewerItemsOptions = ListSessionsOptions & {
  containerRunning: boolean
  // A writable row dispatches to runTuiViewer, which drives a raw-mode pi-tui
  // terminal — unusable without a TTY. Required (not defaulted) so a non-TTY
  // caller can't silently promote a writable row it then can't drive, which
  // would auto-open a TUI on an explicit id past the picker guard.
  interactive: boolean
  includeLogs?: boolean
  // Defaults to true. The detach-to-list path (after `typeclaw tui` esc) sets
  // this false: detaching ENDS the server-side session, so the just-killed
  // (most-recent) tui transcript — and any older tui transcript the heuristic
  // would otherwise promote — must NOT be offered as a writable live row.
  allowWritable?: boolean
}

export type ViewerList = {
  items: ViewerItem[]
  writableSessionId: string | null
}

// Builds the session-viewer list. The writable TUI row is a heuristic, not an
// authoritative query: when the container is up AND stdin is a TTY, the single
// most-recent tui-origin session becomes the read+write `tui` item; every other
// session is read-only. With the container down (no live session to drive) or a
// non-TTY stdin (no terminal to drive it), all sessions are read-only. The
// `logs` row is appended last (container stdout, available offline) so it sits
// below the divider in the picker.
export async function listViewerItems(opts: ListViewerItemsOptions): Promise<ViewerList> {
  const sessions = await listSessions(opts)
  const allowWritable = opts.interactive && opts.allowWritable !== false
  const writableSessionId = opts.containerRunning && allowWritable ? pickWritableSession(sessions) : null

  const items: ViewerItem[] = sessions.map((summary) =>
    summary.sessionId === writableSessionId
      ? { kind: 'tui', summary, writable: true }
      : { kind: 'session', summary, writable: false },
  )

  if (opts.includeLogs !== false) items.push({ kind: 'logs' })

  return { items, writableSessionId }
}

function pickWritableSession(sessions: SessionSummary[]): string | null {
  const tuiSession = sessions.find((s) => s.origin?.kind === 'tui')
  return tuiSession?.sessionId ?? null
}
