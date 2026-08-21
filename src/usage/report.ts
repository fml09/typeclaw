import { styled, type StyleFormat } from '@/shared'

import type { ModelUsage, OriginUsage, UsageTotals } from './aggregate'
import { formatCacheHitRate, formatCost, formatTokens, isoDay } from './format'
import type { UsageReport } from './index'
import type { OriginKind } from './scan'

export type FormatOptions = {
  useColor?: boolean
  view?: 'summary' | 'daily' | 'session' | 'models' | 'origin'
  limit?: number
  // Terminal width hint used to size the elastic Item column. Omit to render
  // without truncation (tests, piped output where columns is undefined).
  terminalWidth?: number
}

export function formatReport(report: UsageReport, opts: FormatOptions = {}): string {
  const view = opts.view ?? 'summary'
  const useColor = opts.useColor ?? false
  const ctx: RenderCtx = { useColor, terminalWidth: opts.terminalWidth ?? Number.POSITIVE_INFINITY }
  switch (view) {
    case 'summary':
      return renderSummary(report, ctx)
    case 'daily':
      return renderDaily(report, ctx, opts.limit)
    case 'session':
      return renderSessions(report, ctx, opts.limit ?? 20)
    case 'models':
      return renderModels(report, ctx, opts.limit)
    case 'origin':
      return renderOrigin(report, ctx)
  }
}

export function formatJson(report: UsageReport): string {
  return JSON.stringify(report, null, 2)
}

type RenderCtx = { useColor: boolean; terminalWidth: number }

function renderSummary(report: UsageReport, ctx: RenderCtx): string {
  const { aggregation } = report
  const sections: string[] = []
  sections.push(header(`USAGE`, ctx) + ' ' + dim(`— ${report.agentDir}`, ctx))
  sections.push(dim(`Timezone: ${report.timezone}`, ctx))

  if (aggregation.bySession.length === 0) {
    sections.push(dim('No assistant turns recorded yet.', ctx))
    return sections.join('\n')
  }

  const total = aggregation.total
  sections.push(
    `${dim('Sessions:', ctx)} ${color('cyan', String(aggregation.bySession.length), ctx)}` +
      `  ${dim('Messages:', ctx)} ${color('cyan', String(total.messageCount), ctx)}` +
      `  ${dim('In:', ctx)} ${formatTokens(total.input)}` +
      `  ${dim('Out:', ctx)} ${formatTokens(total.output)}` +
      `  ${dim('Sent:', ctx)} ${formatTokens(total.input + total.cacheRead)}` +
      `  ${dim('Cost:', ctx)} ${formatCost(total.cost)}`,
  )

  if (aggregation.byDay.length > 0) {
    sections.push('')
    const trend = renderDailyTrend(aggregation.byDay, ctx)
    if (trend !== null) sections.push(trend, '')
    sections.push(header('By day (most recent first)', ctx))
    const recent = aggregation.byDay.slice(-7).reverse()
    const dayRows = recent.map((d) => ({ label: d.date, totals: d as UsageTotals }))
    sections.push(renderTotalsTable(dayRows, ctx, { total: totalOfRows(dayRows) }))
  }

  if (aggregation.byOrigin.length > 0) {
    sections.push('')
    sections.push(header('By origin', ctx))
    sections.push(renderOriginTable(aggregation.byOrigin, ctx))
  }

  if (aggregation.byModel.length > 0) {
    sections.push('')
    sections.push(header('By model', ctx))
    const modelRows = aggregation.byModel.map((m) => ({
      label: colorModelLabel(m, ctx),
      modelId: m.model,
      totals: m as UsageTotals,
    }))
    sections.push(renderTotalsTable(modelRows, ctx, { total: totalOfRows(modelRows) }))
  }

  if (report.warnings.length > 0) {
    sections.push('')
    sections.push(color('yellow', `${report.warnings.length} warning(s):`, ctx))
    for (const w of report.warnings) sections.push(`  - ${w}`)
  }

  return sections.join('\n')
}

function renderOrigin(report: UsageReport, ctx: RenderCtx): string {
  const sections: string[] = [sectionTitle('USAGE BY ORIGIN', report.agentDir, ctx)]
  if (report.aggregation.byOrigin.length === 0) {
    sections.push(dim('No assistant turns recorded yet.', ctx))
    return sections.join('\n')
  }
  sections.push(renderOriginTable(report.aggregation.byOrigin, ctx))
  return sections.join('\n')
}

// Single source of truth for the origin breakdown table used by both the
// summary view and the dedicated `usage origin` subcommand. Matches the
// column shape of renderTotalsTable's other callers (byDay, byModel) plus
// one extra column for session count — deliberately plain numbers rather
// than a proportional bar, since the Cost column already lets the eye sort
// rows by spend and an extra "share of max" bar adds no information that
// isn't already in the report.
function renderOriginTable(byOrigin: readonly OriginUsage[], ctx: RenderCtx): string {
  const rows = byOrigin.map((o) => ({
    label: renderOriginLabel(o.originKind, ctx),
    totals: o as UsageTotals,
    extra: String(o.sessionCount),
    extraTruncatable: false,
  }))
  return renderTotalsTable(rows, ctx, {
    extraHeader: 'Sessions',
    total: totalOfRows(rows),
  })
}

// Glyph + colored label for each origin kind. The glyphs are chosen to be
// instantly readable in a dense table: ▶ for TUI (interactive), ⏱ for cron
// (time-triggered), # for channel (chat-room sigil), ↳ for subagent (child),
// ? for unknown. ASCII fallbacks are not provided — the codebase already
// requires unicode for `…` `●` `✓` etc. on other commands.
function renderOriginLabel(kind: OriginKind, ctx: RenderCtx): string {
  switch (kind) {
    case 'tui':
      return `${color('cyan', '▶', ctx)} ${'tui'}`
    case 'cron':
      return `${color('magenta', '⏱', ctx)} ${'cron'}`
    case 'channel':
      return `${color('green', '#', ctx)} ${'channel'}`
    case 'subagent':
      return `${color('yellow', '↳', ctx)} ${'subagent'}`
    case 'system':
      return `${color('blue', '⚙', ctx)} ${'system'}`
    case 'unknown':
      return `${dim('?', ctx)} ${dim('unknown', ctx)}`
  }
}

// Sparkline trend across the full byDay range, scaled to the row's max token
// count. Tokens (not cost) drive the chart because they're the load-bearing
// usage signal — model price changes and free-tier credits shouldn't flatten
// or distort the visible workload pattern. Returns null when there are fewer
// than 2 days (a single point conveys no trend information). The 8-level
// Unicode block scale `▁▂▃▄▅▆▇█` lets us pack ~80 days into a one-line glance
// — wider than any table-based view could fit at terminal widths under ~160
// columns.
const SPARK_GLYPHS = '▁▂▃▄▅▆▇█'

function renderDailyTrend(byDay: readonly { date: string; totalTokens: number }[], ctx: RenderCtx): string | null {
  if (byDay.length < 2) return null
  const tokens = byDay.map((d) => d.totalTokens)
  const max = tokens.reduce((m, t) => Math.max(m, t), 0)
  if (max <= 0) return null
  const spark = tokens
    .map((t) => {
      const idx = Math.min(SPARK_GLYPHS.length - 1, Math.max(0, Math.round((t / max) * (SPARK_GLYPHS.length - 1))))
      return SPARK_GLYPHS[idx]!
    })
    .join('')
  const first = byDay[0]!.date
  const last = byDay[byDay.length - 1]!.date
  return `${dim('Trend (tokens):', ctx)} ${color('cyan', spark, ctx)}  ${dim(`${first} → ${last}`, ctx)}`
}

function renderDaily(report: UsageReport, ctx: RenderCtx, limit: number | undefined): string {
  const days = limit !== undefined ? report.aggregation.byDay.slice(-limit) : report.aggregation.byDay
  if (days.length === 0) return dim('No usage in range.', ctx)
  const rows = days.map((d) => ({ label: dim(d.date, ctx), totals: d as UsageTotals }))
  return [
    sectionTitle(`USAGE BY DAY`, report.agentDir, ctx),
    renderTotalsTable(rows, ctx, { total: totalOfRows(rows) }),
  ].join('\n')
}

function renderSessions(report: UsageReport, ctx: RenderCtx, limit: number): string {
  const sessions = report.aggregation.bySession.slice(0, limit)
  if (sessions.length === 0) return dim('No sessions in range.', ctx)
  const rows = sessions.map((s) => {
    const firstModel = s.models[0]
    const extra = s.models.length > 1 ? `${s.models.length} models` : modelIdFromKey(firstModel)
    const originGlyph = originGlyphOnly(s.originKind, ctx)
    return {
      label: `${originGlyph}  ${color('magenta', s.sessionId.slice(0, 12), ctx)}  ${dim(isoDay(s.firstAt), ctx)}`,
      totals: s as UsageTotals,
      extra,
      extraTruncatable: s.models.length === 1,
    }
  })
  return [
    sectionTitle(`USAGE BY SESSION`, report.agentDir, ctx, `(top ${limit} by cost)`),
    renderTotalsTable(rows, ctx, { extraHeader: 'Model', total: totalOfRows(rows) }),
  ].join('\n')
}

function originGlyphOnly(kind: OriginKind, ctx: RenderCtx): string {
  switch (kind) {
    case 'tui':
      return color('cyan', '▶', ctx)
    case 'cron':
      return color('magenta', '⏱', ctx)
    case 'channel':
      return color('green', '#', ctx)
    case 'subagent':
      return color('yellow', '↳', ctx)
    case 'system':
      return color('blue', '⚙', ctx)
    case 'unknown':
      return dim('?', ctx)
  }
}

function renderModels(report: UsageReport, ctx: RenderCtx, limit: number | undefined): string {
  const models = limit !== undefined ? report.aggregation.byModel.slice(0, limit) : report.aggregation.byModel
  if (models.length === 0) return dim('No models in range.', ctx)
  const rows = models.map((m) => ({
    label: colorModelLabel(m, ctx),
    modelId: m.model,
    totals: m as UsageTotals,
  }))
  return [
    sectionTitle(`USAGE BY MODEL`, report.agentDir, ctx),
    renderTotalsTable(rows, ctx, { total: totalOfRows(rows) }),
  ].join('\n')
}

function sectionTitle(title: string, agentDir: string, ctx: RenderCtx, suffix?: string): string {
  const t = header(title, ctx)
  const path = dim(`— ${agentDir}`, ctx)
  return suffix !== undefined ? `${t} ${dim(suffix, ctx)} ${path}` : `${t} ${path}`
}

function colorModelLabel(m: ModelUsage, ctx: RenderCtx): string {
  return `${dim(`${m.provider}/`, ctx)}${m.model}`
}

function modelIdFromKey(key: string | undefined): string {
  if (key === undefined) return ''
  const slash = key.indexOf('/')
  return slash === -1 ? key : key.slice(slash + 1)
}

type Row = {
  label: string
  totals: UsageTotals
  extra?: string
  // When truncation kicks in on a model-bearing row, drop the `provider/`
  // prefix from `label` rather than ellipsizing into the prefix. Set by the
  // model and session renderers; date/day rows leave it undefined.
  modelId?: string
  extraTruncatable?: boolean
}

// 2 spaces between columns, matches the existing alignTable join.
const COL_GAP = 2
// Floor below which truncation would erase too much context to be useful.
// "kimi-k2-instr…" at 14 chars still tells you which model family it is.
const MIN_ITEM_WIDTH = 14
const ELLIPSIS = '…'

// Sum of rendered rows. Tokscale-style "Total" footer: always represents
// what the user sees on screen, not lifetime totals across rows that were
// sliced/filtered out.
function totalOfRows(rows: Row[]): UsageTotals {
  const acc: UsageTotals = {
    messageCount: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: 0,
  }
  for (const r of rows) {
    acc.messageCount += r.totals.messageCount
    acc.input += r.totals.input
    acc.output += r.totals.output
    acc.cacheRead += r.totals.cacheRead
    acc.cacheWrite += r.totals.cacheWrite
    acc.totalTokens += r.totals.totalTokens
    acc.cost += r.totals.cost
  }
  return acc
}

function renderTotalsTable(
  rows: Row[],
  ctx: RenderCtx,
  opts: { extraHeader?: string; total?: UsageTotals } = {},
): string {
  const hasExtra = opts.extraHeader !== undefined
  const headers = ['Item', 'Msgs', 'In', 'Out', 'Sent', 'Cache %', 'Cost', ...(hasExtra ? [opts.extraHeader!] : [])]

  const dataCells: string[][] = rows.map((r) => [
    r.label,
    String(r.totals.messageCount),
    formatTokens(r.totals.input),
    formatTokens(r.totals.output),
    formatTokens(r.totals.input + r.totals.cacheRead),
    formatCacheHitRate(r.totals.input, r.totals.cacheRead),
    formatCost(r.totals.cost),
    ...(hasExtra ? [r.extra ?? ''] : []),
  ])

  const totalCells: string[] | undefined =
    opts.total !== undefined
      ? [
          'Total',
          String(opts.total.messageCount),
          formatTokens(opts.total.input),
          formatTokens(opts.total.output),
          formatTokens(opts.total.input + opts.total.cacheRead),
          formatCacheHitRate(opts.total.input, opts.total.cacheRead),
          formatCost(opts.total.cost),
          ...(hasExtra ? [''] : []),
        ]
      : undefined

  const itemColIdx = 0
  const extraColIdx = hasExtra ? headers.length - 1 : -1

  const widthRows = totalCells !== undefined ? [headers, ...dataCells, totalCells] : [headers, ...dataCells]
  const naturalWidths = computeNaturalWidths(widthRows)
  const fixedWidth =
    naturalWidths.reduce((a, b) => a + b, 0) -
    naturalWidths[itemColIdx]! -
    (extraColIdx === -1 ? 0 : naturalWidths[extraColIdx]!) +
    COL_GAP * (naturalWidths.length - 1)
  const elasticBudget = Math.max(0, ctx.terminalWidth - fixedWidth)

  let itemBudget: number
  let extraBudget: number
  if (extraColIdx === -1) {
    itemBudget = Math.max(MIN_ITEM_WIDTH, elasticBudget)
  } else {
    // Split the elastic budget between Item and Extra columns by their natural
    // widths, then clamp each to the MIN_ITEM_WIDTH floor.
    const itemNatural = naturalWidths[itemColIdx]!
    const extraNatural = naturalWidths[extraColIdx]!
    const total = itemNatural + extraNatural
    if (total === 0) {
      itemBudget = MIN_ITEM_WIDTH
      extraBudget = MIN_ITEM_WIDTH
    } else {
      itemBudget = Math.max(MIN_ITEM_WIDTH, Math.floor((elasticBudget * itemNatural) / total))
      extraBudget = Math.max(MIN_ITEM_WIDTH, elasticBudget - itemBudget)
    }
  }

  const truncatedBody = rows.map((r, rowIdx) => {
    const cells = [...dataCells[rowIdx]!]
    cells[itemColIdx] = fitItemCell(cells[itemColIdx]!, r, itemBudget, ctx)
    if (extraColIdx !== -1) {
      const allow = r.extraTruncatable !== false
      cells[extraColIdx] = allow ? truncateTail(cells[extraColIdx]!, extraBudget, ctx) : cells[extraColIdx]!
    }
    return cells
  })

  const table = totalCells !== undefined ? [headers, ...truncatedBody, totalCells] : [headers, ...truncatedBody]
  return alignTable(table, ctx, totalCells !== undefined ? { totalRowIdx: table.length - 1 } : {})
}

function fitItemCell(label: string, row: Row, budget: number, ctx: RenderCtx): string {
  const visible = stripAnsi(label).length
  if (visible <= budget) return label
  // Model row: try dropping `provider/` first; if the bare model id still
  // doesn't fit, ellipsize it. Falls through to a plain tail truncation for
  // anything else. The bare model id has no embedded ANSI so truncateTail
  // is safe on it.
  if (row.modelId !== undefined && row.modelId.length > 0) {
    if (row.modelId.length <= budget) return row.modelId
    return truncateTail(row.modelId, budget, ctx)
  }
  return truncateTail(label, budget, ctx)
}

function truncateTail(text: string, budget: number, ctx: RenderCtx): string {
  const plain = stripAnsi(text)
  if (plain.length <= budget) return text
  if (budget <= 1) return colorEllipsis(ctx)
  // The colored labels we render do not interleave ANSI sequences in the
  // middle of visible characters — coloring is always wrap-the-whole-cell
  // or wrap-a-prefix. For the truncation path we slice the plain text and
  // re-color uniformly, which keeps the math honest.
  return `${plain.slice(0, budget - 1)}${colorEllipsis(ctx)}`
}

function colorEllipsis(ctx: RenderCtx): string {
  return dim(ELLIPSIS, ctx)
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

function alignTable(table: string[][], ctx: RenderCtx, opts: { totalRowIdx?: number } = {}): string {
  if (table.length === 0) return ''
  const widths = computeNaturalWidths(table)
  const lines: string[] = []
  table.forEach((row, idx) => {
    const cells = row.map((cell, c) => {
      const pad = widths[c]! - stripAnsi(cell).length
      return c === 0 ? cell + ' '.repeat(pad) : ' '.repeat(pad) + cell
    })
    const line = cells.join('  ')
    if (idx === 0) {
      lines.push(color('cyan', line, ctx))
    } else if (opts.totalRowIdx !== undefined && idx === opts.totalRowIdx) {
      lines.push(color('yellow', bold(line, ctx), ctx))
    } else {
      lines.push(line)
    }
  })
  return lines.join('\n')
}

function header(text: string, ctx: RenderCtx): string {
  return bold(text, ctx)
}

function bold(text: string, ctx: RenderCtx): string {
  return color('bold', text, ctx)
}

function dim(text: string, ctx: RenderCtx): string {
  return color('dim', text, ctx)
}

function color(modifier: StyleFormat, text: string, ctx: RenderCtx): string {
  if (!ctx.useColor) return text
  return styled(modifier, text)
}

// ANSI escape sequences would inflate column widths and break alignment under
// --no-color piping; strip before measuring.
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, '')
}
