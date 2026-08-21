import { styled } from '@/shared'

import type { DoctorReport, ReportEntry, Severity } from './types'

export type FormatOptions = { useColor?: boolean; verbose?: boolean }

type ColorFn = (s: string) => string
type Palette = {
  bold: ColorFn
  dim: ColorFn
  green: ColorFn
  yellow: ColorFn
  red: ColorFn
  cyan: ColorFn
  gray: ColorFn
}

const identity: ColorFn = (s) => s
const NO_PALETTE: Palette = {
  bold: identity,
  dim: identity,
  green: identity,
  yellow: identity,
  red: identity,
  cyan: identity,
  gray: identity,
}

const COLOR_PALETTE: Palette = {
  bold: (s) => styled('bold', s),
  dim: (s) => styled('dim', s),
  green: (s) => styled('green', s),
  yellow: (s) => styled('yellow', s),
  red: (s) => styled('red', s),
  cyan: (s) => styled('cyan', s),
  gray: (s) => styled('gray', s),
}

export function formatReport(report: DoctorReport, opts: FormatOptions = {}): string {
  const verbose = opts.verbose ?? false
  const useColor = opts.useColor ?? false
  const p: Palette = useColor ? COLOR_PALETTE : NO_PALETTE

  const lines: string[] = []
  lines.push(`${p.bold('typeclaw doctor')}  ${p.dim(report.cwd)}`)
  lines.push('')

  const byCategory = groupByCategory(report.entries)
  for (const [category, entries] of byCategory) {
    const worst = worstSeverity(entries.map((e) => e.status))
    lines.push(`${categoryBox(worst, p)} ${p.bold(category)}`)
    for (const entry of entries) {
      lines.push(`    ${markerForEntry(entry, p)} ${entry.message}${describeOriginSuffix(entry, p)}`)
      if (verbose) {
        for (const detail of entry.details ?? []) {
          lines.push(`      ${p.dim('•')} ${p.dim(detail)}`)
        }
      }
      if (entry.fix !== undefined) {
        const tag = entry.fix.canAutoFix ? p.cyan('→ Fix (auto):') : p.cyan('→ Fix:')
        lines.push(`      ${tag} ${entry.fix.description}`)
      }
    }
    lines.push('')
  }

  lines.push(summaryLine(report, p))
  return lines.join('\n').replace(/\n+$/, '\n').trimEnd()
}

export function formatJson(report: DoctorReport): string {
  return JSON.stringify(report, null, 2)
}

function groupByCategory(entries: ReportEntry[]): Map<string, ReportEntry[]> {
  const m = new Map<string, ReportEntry[]>()
  for (const entry of entries) {
    const arr = m.get(entry.category)
    if (arr) arr.push(entry)
    else m.set(entry.category, [entry])
  }
  return m
}

function worstSeverity(statuses: Severity[]): Severity {
  if (statuses.some((s) => s === 'error')) return 'error'
  if (statuses.some((s) => s === 'warning')) return 'warning'
  if (statuses.some((s) => s === 'info')) return 'info'
  if (statuses.every((s) => s === 'skipped')) return 'skipped'
  return 'ok'
}

function categoryBox(status: Severity, p: Palette): string {
  switch (status) {
    case 'ok':
      return p.green('[✓]')
    case 'warning':
      return p.yellow('[!]')
    case 'error':
      return p.red('[✗]')
    case 'skipped':
      return p.dim('[-]')
    case 'info':
      return p.cyan('[i]')
  }
}

function markerForEntry(entry: ReportEntry, p: Palette): string {
  switch (entry.status) {
    case 'ok':
      return p.green('✓')
    case 'warning':
      return p.yellow('!')
    case 'error':
      return p.red('✗')
    case 'skipped':
      return p.dim('-')
    case 'info':
      return p.cyan('i')
  }
}

function describeOriginSuffix(entry: ReportEntry, p: Palette): string {
  const name = entry.pluginName ? `${entry.name} [plugin:${entry.pluginName}]` : entry.name
  return ` ${p.dim(`(${name})`)}`
}

function summaryLine(report: DoctorReport, p: Palette): string {
  const { ok, warning, error, info, skipped } = report.summary
  const parts: string[] = []
  parts.push(`${ok} ok`)
  if (warning > 0) parts.push(p.yellow(`${warning} warning${warning === 1 ? '' : 's'}`))
  if (error > 0) parts.push(p.red(`${error} error${error === 1 ? '' : 's'}`))
  if (info > 0) parts.push(p.dim(`${info} info`))
  if (skipped > 0) parts.push(p.dim(`${skipped} skipped`))

  const headLine = `${p.bold('Summary:')} ${parts.join(', ')}`
  if (report.ok) {
    return `${p.green('●')} ${headLine}`
  }
  return `${p.red('●')} ${headLine}`
}
