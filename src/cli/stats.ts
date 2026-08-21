import { defineCommand } from 'citty'

import { type ContainerStats, type DockerExec, resolveController } from '@/container'
import { findAgentDir } from '@/init'
import { styled } from '@/shared'

import { type DockerPreflightResult, preflightDocker, printDockerGuidance } from './docker-preflight'

export const statsCommand = defineCommand({
  meta: {
    name: 'stats',
    description: 'show the agent container resource usage: cpu, memory, pids (host stage)',
  },
  async run() {
    await runStats()
  },
})

export type RunStatsDeps = {
  cwd?: string
  preflight?: () => Promise<DockerPreflightResult>
  exec?: DockerExec
  write?: (text: string) => void
  onDockerUnavailable?: (failure: Extract<DockerPreflightResult, { ok: false }>) => void
}

export async function runStats(deps: RunStatsDeps = {}): Promise<void> {
  const cwd = deps.cwd ?? findAgentDir(process.cwd()) ?? process.cwd()

  const preflight = await (deps.preflight ?? preflightDocker)()
  if (!preflight.ok) {
    ;(deps.onDockerUnavailable ?? defaultOnDockerUnavailable)(preflight)
    return
  }

  const container = await resolveController().stats({ cwd, exec: deps.exec })

  const useColor = Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined
  const write = deps.write ?? ((text: string) => process.stdout.write(text))
  write(`${formatStats({ cwd, container }, { useColor })}\n`)
}

function defaultOnDockerUnavailable(failure: Extract<DockerPreflightResult, { ok: false }>): never {
  printDockerGuidance(failure)
  process.exit(1)
}

export type StatsReport = {
  cwd: string
  container: ContainerStats
}

export type FormatOptions = { useColor?: boolean }

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

export function formatStats(report: StatsReport, opts: FormatOptions = {}): string {
  const useColor = opts.useColor ?? false
  const p: Palette = useColor ? COLOR_PALETTE : NO_PALETTE

  const container = report.container
  const lines: string[] = []
  lines.push(`${p.bold('Container')}  ${container.containerName}`)
  lines.push(row('cwd', report.cwd))
  lines.push(row('image', container.imageTag))

  if (container.kind === 'missing') {
    lines.push(row('state', p.dim('missing')))
    return lines.join('\n')
  }

  if (container.kind === 'stopped') {
    lines.push(row('state', p.yellow('stopped')))
    return lines.join('\n')
  }

  lines.push(row('state', `${p.green('running')}${formatUptime(container.startedAt, p)}`))
  lines.push('')
  lines.push(row('cpu', p.cyan(container.cpuPercent)))
  lines.push(row('memory', `${p.cyan(container.memUsage)} ${p.dim(`(${container.memPercent})`)}`))
  lines.push(row('pids', p.cyan(container.pids)))
  return lines.join('\n')
}

function formatUptime(startedAt: string | null, p: Palette): string {
  if (startedAt === null) return ''
  const started = Date.parse(startedAt)
  if (Number.isNaN(started)) return ''
  const elapsedMs = Date.now() - started
  if (elapsedMs < 0) return ''
  return ` ${p.dim(`up ${formatDuration(elapsedMs)}`)}`
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

function row(label: string, value: string): string {
  return `  ${label.padEnd(8)}${value}`
}
