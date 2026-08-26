import { styled } from '@/shared'

import type { DreamCategory, DreamEntry, DreamEntryDetail } from './types'

export type RenderOptions = { color: boolean }

type ColorName = 'dim' | 'cyan' | 'green' | 'yellow' | 'magenta' | 'gray'

function tint(opts: RenderOptions, color: ColorName, text: string): string {
  if (!opts.color) return text
  return styled(color, text)
}

const CATEGORY_LABELS: Record<DreamCategory, string> = {
  fragments: 'frag',
  skills: 'skill',
  'watermarks-only': 'watermarks',
  snapshot: 'snapshot',
  other: 'other',
}

export function renderListRow(entry: DreamEntry, opts: RenderOptions): string {
  const emoji = entry.emoji ?? '·'
  const sha = tint(opts, 'cyan', entry.shortSha)
  const date = tint(opts, 'dim', formatShortDate(entry.committedAt))
  const when = tint(opts, 'dim', `(${formatRelative(entry.committedAt)})`)
  const summary = entry.summary ?? entry.subject
  const badges = renderCategoryBadges(entry.categories, opts)
  const head = `${emoji}  ${sha}  ${date} ${when}  ${summary}`
  return badges.length > 0 ? `${head}  ${badges}` : head
}

function renderCategoryBadges(categories: DreamCategory[], opts: RenderOptions): string {
  if (categories.length === 0) return ''
  const meaningful = categories.filter((c) => c !== 'other')
  const shown = meaningful.length > 0 ? meaningful : categories
  const labels = shown.map((c) => CATEGORY_LABELS[c])
  return tint(opts, 'magenta', labels.map((l) => `[${l}]`).join(' '))
}

export function renderDetail(entry: DreamEntry, opts: RenderOptions): string {
  const lines: string[] = []
  const emoji = entry.emoji ?? '·'
  lines.push(`${emoji}  ${entry.subject}`)
  lines.push(
    tint(
      opts,
      'dim',
      `${entry.shortSha} · ${formatTimestamp(entry.committedAt)} · ${formatRelative(entry.committedAt)}`,
    ),
  )

  const detail = entry.detail
  if (detail === undefined) {
    lines.push('', tint(opts, 'dim', '(no detail loaded)'))
    return lines.join('\n')
  }

  renderFragments(lines, detail, opts)
  renderTopics(lines, detail, opts)
  renderSkills(lines, detail, opts)

  if (detail.stateChanged) lines.push('', tint(opts, 'dim', 'state: .dreaming-state.json advanced'))
  for (const warning of detail.parseWarnings) lines.push(tint(opts, 'yellow', `⚠ ${warning}`))

  if (isQuietDream(detail)) {
    lines.push('', tint(opts, 'dim', 'No fragments promoted, no shards changed this run.'))
  }
  return lines.join('\n')
}

function renderFragments(lines: string[], detail: DreamEntryDetail, opts: RenderOptions): void {
  if (detail.addedFragments.length === 0) return
  lines.push('', section(opts, `fragments folded in (${detail.addedFragments.length})`))
  for (const f of detail.addedFragments) {
    const id = tint(opts, 'dim', `${f.streamDate ?? '????'}#${f.id}`)
    const topic = f.topic !== null ? tint(opts, 'magenta', ` [${f.topic}]`) : ''
    lines.push(`• ${id}${topic}`)
    if (f.bodyPreview !== null) lines.push(`    ${tint(opts, 'gray', `"${f.bodyPreview}"`)}`)
  }
}

function renderTopics(lines: string[], detail: DreamEntryDetail, opts: RenderOptions): void {
  if (detail.changedTopics.length === 0) return
  lines.push('', section(opts, `topic shards changed (${detail.changedTopics.length})`))
  for (const t of detail.changedTopics) {
    const counts =
      t.additions !== null && t.deletions !== null ? tint(opts, 'dim', ` (+${t.additions} −${t.deletions})`) : ''
    lines.push(`${statusGlyph(t.status, opts)} ${t.slug}${counts}`)
  }
}

function renderSkills(lines: string[], detail: DreamEntryDetail, opts: RenderOptions): void {
  if (detail.createdSkills.length === 0) return
  lines.push('', section(opts, `skills distilled (${detail.createdSkills.length})`))
  for (const s of detail.createdSkills)
    lines.push(`${tint(opts, 'green', '✦')} ${s.name}  ${tint(opts, 'dim', s.path)}`)
}

export function toJsonShape(entry: DreamEntry): Record<string, unknown> {
  const base: Record<string, unknown> = {
    sha: entry.sha,
    shortSha: entry.shortSha,
    committedAt: entry.committedAt,
    subject: entry.subject,
    isDreamCommit: entry.isDreamCommit,
    summary: entry.summary,
    emoji: entry.emoji,
    categories: entry.categories,
  }
  if (entry.detail !== undefined) base.detail = entry.detail
  return base
}

function isQuietDream(detail: DreamEntryDetail): boolean {
  return detail.addedFragments.length === 0 && detail.changedTopics.length === 0 && detail.createdSkills.length === 0
}

function section(opts: RenderOptions, label: string): string {
  return tint(opts, 'dim', `── ${label} ──`)
}

function statusGlyph(status: string, opts: RenderOptions): string {
  if (status === 'added') return tint(opts, 'green', '✚ added   ')
  if (status === 'modified') return tint(opts, 'yellow', '✎ modified')
  if (status === 'deleted') return tint(opts, 'dim', '✖ deleted ')
  if (status === 'renamed') return tint(opts, 'cyan', '→ renamed ')
  return '? unknown '
}

function formatRelative(iso: string): string {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return iso
  const diff = Date.now() - ms
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

function formatTimestamp(iso: string): string {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return iso
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function formatShortDate(iso: string): string {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return iso
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
