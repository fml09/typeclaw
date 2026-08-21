import type { AgentRuntimeState, ComposeStatusResult } from '@/compose'
import { styled } from '@/shared'

export type FormatComposeStatusOptions = { useColor?: boolean }

type ColorFn = (s: string) => string
type Palette = {
  bold: ColorFn
  dim: ColorFn
  green: ColorFn
  yellow: ColorFn
  cyan: ColorFn
}

const identity: ColorFn = (s) => s
const NO_PALETTE: Palette = {
  bold: identity,
  dim: identity,
  green: identity,
  yellow: identity,
  cyan: identity,
}

const COLOR_PALETTE: Palette = {
  bold: (s) => styled('bold', s),
  dim: (s) => styled('dim', s),
  green: (s) => styled('green', s),
  yellow: (s) => styled('yellow', s),
  cyan: (s) => styled('cyan', s),
}

const STATE_LABELS: Record<AgentRuntimeState, string> = {
  running: 'running',
  stopped: 'stopped',
  absent: 'not started',
}

const STATE_LABEL_WIDTH = Math.max(...Object.values(STATE_LABELS).map((l) => l.length))

export function formatComposeStatus(result: ComposeStatusResult, opts: FormatComposeStatusOptions = {}): string {
  const useColor = opts.useColor ?? false
  const p: Palette = useColor ? COLOR_PALETTE : NO_PALETTE

  if (result.entries.length === 0) {
    return p.dim(`No typeclaw agents in ${result.rootCwd}.`)
  }

  const nameWidth = result.entries.reduce((w, e) => Math.max(w, e.name.length), 0)
  const header = p.dim(
    `${result.entries.length} ${result.entries.length === 1 ? 'agent' : 'agents'} in ${result.rootCwd}`,
  )

  const lines = [header, '']
  for (const entry of result.entries) {
    lines.push(renderRow(entry, nameWidth, p))
  }
  return lines.join('\n')
}

function renderRow(entry: ComposeStatusResult['entries'][number], nameWidth: number, p: Palette): string {
  const glyph = renderGlyph(entry.state, p)
  const name = p.bold(entry.name.padEnd(nameWidth))
  const state = renderState(entry.state, p)
  const detail = renderDetail(entry, p)
  return detail ? `  ${glyph}  ${name}  ${state}  ${detail}` : `  ${glyph}  ${name}  ${state}`
}

function renderGlyph(state: AgentRuntimeState, p: Palette): string {
  switch (state) {
    case 'running':
      return p.green('●')
    case 'stopped':
      return p.yellow('○')
    case 'absent':
      return p.dim('·')
  }
}

function renderState(state: AgentRuntimeState, p: Palette): string {
  const label = STATE_LABELS[state].padEnd(STATE_LABEL_WIDTH)
  switch (state) {
    case 'running':
      return p.green(label)
    case 'stopped':
      return p.yellow(label)
    case 'absent':
      return p.dim(label)
  }
}

function renderDetail(entry: ComposeStatusResult['entries'][number], p: Palette): string {
  if (entry.state !== 'running' || entry.hostPort === null) return ''
  return p.dim('port ') + p.cyan(String(entry.hostPort))
}
