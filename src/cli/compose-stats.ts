import type { AgentStatsState, ComposeStatsResult } from '@/compose'
import { styled } from '@/shared'

export type FormatComposeStatsOptions = { useColor?: boolean }

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

const STATE_LABELS: Record<AgentStatsState, string> = {
  running: 'running',
  stopped: 'stopped',
  absent: 'not started',
}

const STATE_LABEL_WIDTH = Math.max(...Object.values(STATE_LABELS).map((l) => l.length))

export function formatComposeStats(result: ComposeStatsResult, opts: FormatComposeStatsOptions = {}): string {
  const useColor = opts.useColor ?? false
  const p: Palette = useColor ? COLOR_PALETTE : NO_PALETTE

  if (result.entries.length === 0) {
    return p.dim(`No typeclaw agents in ${result.rootCwd}.`)
  }

  const nameWidth = result.entries.reduce((w, e) => Math.max(w, e.name.length), 0)
  const cpuWidth = result.entries.reduce((w, e) => Math.max(w, (e.cpuPercent ?? '').length), 'cpu'.length)
  const memWidth = result.entries.reduce((w, e) => Math.max(w, (e.memUsage ?? '').length), 'memory'.length)

  const header = p.dim(
    `${result.entries.length} ${result.entries.length === 1 ? 'agent' : 'agents'} in ${result.rootCwd}`,
  )

  const lines = [header, '']
  for (const entry of result.entries) {
    lines.push(renderRow(entry, { nameWidth, cpuWidth, memWidth }, p))
  }
  return lines.join('\n')
}

type Widths = { nameWidth: number; cpuWidth: number; memWidth: number }

function renderRow(entry: ComposeStatsResult['entries'][number], w: Widths, p: Palette): string {
  const glyph = renderGlyph(entry.state, p)
  const name = p.bold(entry.name.padEnd(w.nameWidth))
  const state = renderState(entry.state, p)

  if (entry.state !== 'running') {
    return `  ${glyph}  ${name}  ${state}`
  }

  const cpu = p.cyan((entry.cpuPercent ?? '-').padStart(w.cpuWidth))
  const mem = p.cyan((entry.memUsage ?? '-').padEnd(w.memWidth))
  const memPct = p.dim(`(${entry.memPercent ?? '-'})`)
  const pids = p.dim(`${entry.pids ?? '-'} pids`)
  return `  ${glyph}  ${name}  ${state}  ${cpu}  ${mem} ${memPct}  ${pids}`
}

function renderGlyph(state: AgentStatsState, p: Palette): string {
  switch (state) {
    case 'running':
      return p.green('●')
    case 'stopped':
      return p.yellow('○')
    case 'absent':
      return p.dim('·')
  }
}

function renderState(state: AgentStatsState, p: Palette): string {
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
