import type { ComposeUsageResult } from '@/compose'
import { styled } from '@/shared'
import type { UsageReport, UsageTotals } from '@/usage'
import { formatCacheHitRate, formatCost, formatTokens } from '@/usage/format'

export type FormatComposeUsageOptions = {
  useColor?: boolean
}

type ColorFn = (s: string) => string
type Palette = {
  bold: ColorFn
  dim: ColorFn
  cyan: ColorFn
  yellow: ColorFn
  red: ColorFn
}

const identity: ColorFn = (s) => s
const NO_PALETTE: Palette = { bold: identity, dim: identity, cyan: identity, yellow: identity, red: identity }
const COLOR_PALETTE: Palette = {
  bold: (s) => styled('bold', s),
  dim: (s) => styled('dim', s),
  cyan: (s) => styled('cyan', s),
  yellow: (s) => styled('yellow', s),
  red: (s) => styled('red', s),
}

export function formatComposeUsage(result: ComposeUsageResult, opts: FormatComposeUsageOptions = {}): string {
  const p: Palette = opts.useColor ? COLOR_PALETTE : NO_PALETTE

  if (result.agents.length === 0) {
    return p.dim(`No typeclaw agents in ${result.rootCwd}.`)
  }

  const sections: string[] = []
  sections.push(`${p.bold('USAGE')} ${p.dim(`— ${result.rootCwd}`)}`)
  sections.push(rangeLine(result.range, p))
  sections.push('')
  sections.push(renderTable(result, p))

  const warnings = collectWarnings(result)
  if (warnings.length > 0) {
    sections.push('')
    sections.push(p.yellow(`${warnings.length} warning(s):`))
    for (const w of warnings) sections.push(`  - ${w}`)
  }

  return sections.join('\n')
}

export function formatComposeUsageJson(result: ComposeUsageResult): string {
  return JSON.stringify(result, null, 2)
}

function rangeLine(range: ComposeUsageResult['range'], p: Palette): string {
  if (range.since === null && range.until === null) return p.dim('Range: all time')
  const since = range.since !== null ? new Date(range.since).toISOString() : '—'
  const until = range.until !== null ? new Date(range.until).toISOString() : '—'
  return p.dim(`Range: ${since} → ${until}`)
}

type Row = {
  label: string
  ok: boolean
  reason: string | null
  totals: UsageTotals
}

function renderTable(result: ComposeUsageResult, p: Palette): string {
  const rows: Row[] = result.results.map((r) => {
    if (!r.ok) {
      return { label: r.name, ok: false, reason: r.reason, totals: emptyTotals() }
    }
    return { label: r.name, ok: true, reason: null, totals: totalsFrom(r.data) }
  })

  const total = sumTotals(rows.filter((r) => r.ok).map((r) => r.totals))
  const headers = ['Agent', 'Sessions', 'Msgs', 'In', 'Out', 'Cache %', 'Cost']

  const dataCells = rows.map((r) => {
    if (!r.ok) {
      return [p.red(r.label), p.red(`error: ${r.reason ?? 'unknown'}`), '', '', '', '', '']
    }
    return [
      p.bold(r.label),
      String(sessionCountFor(r, result)),
      String(r.totals.messageCount),
      formatTokens(r.totals.input),
      formatTokens(r.totals.output),
      formatCacheHitRate(r.totals.input, r.totals.cacheRead),
      formatCost(r.totals.cost),
    ]
  })

  const totalSessions = result.results.reduce((acc, r) => acc + (r.ok ? r.data.aggregation.bySession.length : 0), 0)
  const totalCells = [
    'Total',
    String(totalSessions),
    String(total.messageCount),
    formatTokens(total.input),
    formatTokens(total.output),
    formatCacheHitRate(total.input, total.cacheRead),
    formatCost(total.cost),
  ]

  return alignTable([headers, ...dataCells, totalCells], p, { totalRowIdx: dataCells.length + 1 })
}

function sessionCountFor(row: Row, result: ComposeUsageResult): number {
  const match = result.results.find((r) => r.name === row.label)
  if (match === undefined || !match.ok) return 0
  return match.data.aggregation.bySession.length
}

function collectWarnings(result: ComposeUsageResult): string[] {
  const out: string[] = []
  for (const r of result.results) {
    if (!r.ok) continue
    for (const w of r.data.warnings) out.push(`[${r.name}] ${w}`)
  }
  return out
}

function totalsFrom(report: UsageReport): UsageTotals {
  return report.aggregation.total
}

function emptyTotals(): UsageTotals {
  return { messageCount: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 }
}

function sumTotals(parts: UsageTotals[]): UsageTotals {
  const acc = emptyTotals()
  for (const t of parts) {
    acc.messageCount += t.messageCount
    acc.input += t.input
    acc.output += t.output
    acc.cacheRead += t.cacheRead
    acc.cacheWrite += t.cacheWrite
    acc.totalTokens += t.totalTokens
    acc.cost += t.cost
  }
  return acc
}

function alignTable(table: string[][], p: Palette, opts: { totalRowIdx: number }): string {
  const widths = computeNaturalWidths(table)
  return table
    .map((row, idx) => {
      const cells = row.map((cell, c) => {
        const pad = widths[c]! - stripAnsi(cell).length
        return c === 0 ? cell + ' '.repeat(pad) : ' '.repeat(pad) + cell
      })
      const line = cells.join('  ')
      if (idx === 0) return p.cyan(line)
      if (idx === opts.totalRowIdx) return p.yellow(p.bold(line))
      return line
    })
    .join('\n')
}

function computeNaturalWidths(table: string[][]): number[] {
  const cols = table[0]?.length ?? 0
  const widths: number[] = []
  for (let c = 0; c < cols; c++) {
    let w = 0
    for (const row of table) {
      const cell = row[c] ?? ''
      const visible = stripAnsi(cell).length
      if (visible > w) w = visible
    }
    widths.push(w)
  }
  return widths
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, '')
}
