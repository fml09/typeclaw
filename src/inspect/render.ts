import { styled } from '@/shared'

import { originLabel, readableId } from './label'
import type { InspectEvent } from './types'

export type RenderOptions = {
  color: boolean
  maxTextLength?: number
  // When false, the timestamp column is blanked (kept the same width so the tag
  // column stays aligned). The line view passes this from a TimeGate so a run of
  // same-category events shows the timestamp only on its first line.
  showTime?: boolean
}

const TIME_WIDTH = '--:--:--'.length

export function renderEvent(event: InspectEvent, opts: RenderOptions): string {
  const time = opts.showTime === false ? ' '.repeat(TIME_WIDTH) : renderTime(event.ts, opts)
  const tag = renderTag(event, opts)
  const body = renderBody(event, opts)
  return `${time}  ${tag}  ${body}`
}

// Decides whether an event's timestamp should be shown, given the running render
// position: a timestamp prints only when the event's category differs from the
// previous one, so a run of same-category events (e.g. back-to-back thinking
// blocks or a tool start/end pair) carries a single timestamp at its start.
export class TimeGate {
  private prevCat: InspectEvent['cat'] | null = null

  shouldShow(cat: InspectEvent['cat']): boolean {
    const show = cat !== this.prevCat
    this.prevCat = cat
    return show
  }

  // Clear the running category so the next event always shows its timestamp.
  // Called at a visible section boundary (the live divider) so the first live
  // row is stamped even when it shares the last replayed event's category.
  reset(): void {
    this.prevCat = null
  }
}

const DEFAULT_MAX_TEXT = 200

function renderTime(ts: number, opts: RenderOptions): string {
  if (ts === 0) return tint(opts, 'dim', '--:--:--')
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return tint(opts, 'dim', `${hh}:${mm}:${ss}`)
}

function renderTag(event: InspectEvent, opts: RenderOptions): string {
  switch (event.cat) {
    case 'meta':
      return tint(opts, 'magenta', padEnd('meta', 9))
    case 'user':
      return tint(opts, 'cyan', padEnd('user', 9))
    case 'assistant':
      return tint(opts, 'green', padEnd('assist', 9))
    case 'thinking':
      return tint(opts, 'gray', padEnd('think', 9))
    case 'tool':
      return tint(opts, 'yellow', padEnd(event.phase === 'start' ? 'tool ▸' : 'tool ◂', 9))
    case 'error':
      if (event.stopReason === 'aborted') return tint(opts, 'yellow', padEnd('abort', 9))
      return tint(opts, 'red', padEnd('error', 9))
    case 'done':
      return tint(opts, 'gray', padEnd('done', 9))
    case 'broadcast':
      return tint(opts, 'magenta', padEnd('bcast', 9))
    case 'cron-fire':
      return tint(opts, 'magenta', padEnd('cron', 9))
    case 'inbound':
      return tint(opts, 'cyan', padEnd('inbound', 9))
  }
}

function renderBody(event: InspectEvent, opts: RenderOptions): string {
  switch (event.cat) {
    case 'meta':
      return `origin: ${originLabel(event.origin)}`
    case 'user':
      return truncate(singleLine(event.text), opts.maxTextLength ?? DEFAULT_MAX_TEXT)
    case 'assistant':
      return truncate(singleLine(event.text), opts.maxTextLength ?? DEFAULT_MAX_TEXT)
    case 'thinking': {
      const prefix = event.redacted === true ? `${tint(opts, 'dim', '[redacted]')} ` : ''
      const body = event.text === '' ? '' : truncate(singleLine(event.text), opts.maxTextLength ?? DEFAULT_MAX_TEXT)
      return `${prefix}${tint(opts, 'dim', body)}`
    }
    case 'tool': {
      if (event.phase === 'start') {
        return `${event.name}(${renderArgs(event.args)})`
      }
      const dur = formatDuration(event.durationMs ?? 0)
      const status = event.isError ? tint(opts, 'red', 'error') : 'ok'
      const result = renderResult(event.result, opts.maxTextLength ?? DEFAULT_MAX_TEXT)
      return `${event.name} → ${status}${result ? ` ${result}` : ''} (${dur})`
    }
    case 'error': {
      const aborted = event.stopReason === 'aborted'
      const text = truncate(singleLine(event.message), opts.maxTextLength ?? DEFAULT_MAX_TEXT)
      const suffix =
        event.stopReason !== undefined && !aborted ? ` ${tint(opts, 'dim', `(stop=${event.stopReason})`)}` : ''
      return `${tint(opts, aborted ? 'yellow' : 'red', text)}${suffix}`
    }
    case 'done':
      return renderDone(event, opts)
    case 'broadcast':
      return renderBroadcastBody(event.payload, opts.maxTextLength ?? DEFAULT_MAX_TEXT)
    case 'cron-fire':
      return `${event.jobId} fired`
    case 'inbound':
      return renderInboundBody(event, opts)
  }
}

function renderInboundBody(event: Extract<InspectEvent, { cat: 'inbound' }>, opts: RenderOptions): string {
  const workspace = readableId(event.adapter, event.workspace)
  const chat = readableId(event.adapter, event.chat)
  const coord = `${event.adapter}:${workspace}/${chat}${event.thread === null ? '' : `#${event.thread}`}`
  const who = event.authorName !== '' ? event.authorName : readableId(event.adapter, event.authorId)
  const decisionTag = tint(opts, decisionColor(event.decision), `[${event.decision}]`)
  const text = truncate(singleLine(event.text), opts.maxTextLength ?? DEFAULT_MAX_TEXT)
  return `${decisionTag} ${tint(opts, 'dim', coord)} ${who}: ${text}`
}

function decisionColor(decision: Extract<InspectEvent, { cat: 'inbound' }>['decision']): ColorName {
  switch (decision) {
    case 'engage':
      return 'green'
    case 'observe':
      return 'dim'
    case 'denied':
      return 'red'
    case 'claim':
      return 'magenta'
  }
}

function renderBroadcastBody(payload: unknown, maxLen: number): string {
  if (payload !== null && typeof payload === 'object') {
    const kind = (payload as { kind?: unknown }).kind
    if (typeof kind === 'string') {
      const rest = renderArgs(payload)
      return rest === '' ? kind : `${kind} ${rest}`
    }
  }
  try {
    const compact = JSON.stringify(payload)
    if (compact === undefined) return ''
    if (compact.length <= maxLen) return compact
    return `${compact.slice(0, maxLen)}…`
  } catch {
    return ''
  }
}

function renderDone(event: Extract<InspectEvent, { cat: 'done' }>, opts: RenderOptions): string {
  const parts: string[] = []
  if (event.totalTokens > 0) parts.push(`tokens: ${event.input} in / ${event.output} out`)
  if (event.cost > 0) parts.push(`$${event.cost.toFixed(4)}`)
  if (event.stopReason !== undefined) parts.push(`stop=${event.stopReason}`)
  return tint(opts, 'dim', parts.join(' · ') || '(no usage)')
}

function renderArgs(args: unknown): string {
  if (args === undefined) return ''
  if (typeof args === 'string') return JSON.stringify(args)
  try {
    const compact = JSON.stringify(args)
    if (compact === undefined) return ''
    if (compact.length <= 120) return compact
    return `${compact.slice(0, 120)}…`
  } catch {
    return '<unserializable>'
  }
}

function renderResult(result: unknown, maxLen: number): string {
  if (result === undefined || result === null) return ''
  if (typeof result === 'string') {
    const text = singleLine(result)
    if (text === '') return ''
    return `"${truncate(text, Math.min(80, maxLen))}"`
  }
  if (typeof result === 'number' || typeof result === 'boolean') return String(result)
  try {
    const compact = JSON.stringify(result)
    if (compact === undefined) return ''
    if (compact.length <= 80) return compact
    return `${compact.slice(0, 80)}…`
  } catch {
    return ''
  }
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  return `${text.slice(0, maxLen)}…`
}

function singleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function padEnd(text: string, width: number): string {
  if (text.length >= width) return text
  return text + ' '.repeat(width - text.length)
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  const sec = Math.round(s % 60)
  return `${m}m${sec}s`
}

type ColorName = 'dim' | 'magenta' | 'cyan' | 'green' | 'yellow' | 'red' | 'gray'

function tint(opts: RenderOptions, color: ColorName, text: string): string {
  if (!opts.color) return text
  return styled(color, text)
}
