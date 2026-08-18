import type { Unsubscribe } from '@/stream'

import { createLogRing, type LogLineSubscriber, type LogRing } from '../log-ring'
import { extractQuickTunnelUrl } from '../quick-url-parser'
import type { TunnelConfig, TunnelProviderHandle, TunnelState, TunnelStateSubscriber } from '../types'
import { isUpstreamReachable, type UpstreamProbe } from '../upstream-probe'
import { isBinaryNotFound, MISSING_BINARY_DETAIL } from './cloudflared-binary'

const DEFAULT_BINARY = 'cloudflared'
const DEFAULT_RESTART_BACKOFF_MS = [1_000, 2_000, 4_000, 10_000, 30_000]
const DEFAULT_MAX_FAILURES_WITHOUT_URL = 10
const DEFAULT_STOP_GRACE_MS = 5_000
const DEFAULT_UPSTREAM_RECHECK_MS = 2_000

export type CloudflareQuickProviderOptions = {
  config: TunnelConfig
  upstreamPort: number
  onUrlChange: (url: string) => void
  binary?: string
  restartBackoffMs?: number[]
  maxConsecutiveFailuresWithoutUrl?: number
  stopGraceMs?: number
  probeUpstream?: UpstreamProbe
  upstreamRecheckMs?: number
}

export type CloudflareQuickProviderHandle = TunnelProviderHandle & {
  tail: () => string[]
  subscribeToLogs: (cb: LogLineSubscriber) => Unsubscribe
}

export function createCloudflareQuickProvider(options: CloudflareQuickProviderOptions): CloudflareQuickProviderHandle {
  const { config, upstreamPort, onUrlChange } = options
  if (config.provider !== 'cloudflare-quick') {
    throw new Error(`createCloudflareQuickProvider: provider must be 'cloudflare-quick', got '${config.provider}'`)
  }
  if (!Number.isInteger(upstreamPort) || upstreamPort < 1 || upstreamPort > 65535) {
    throw new Error(`tunnel '${config.name}' (cloudflare-quick): upstreamPort must be a valid TCP port`)
  }

  const binary = options.binary ?? DEFAULT_BINARY
  const restartBackoffMs = options.restartBackoffMs ?? DEFAULT_RESTART_BACKOFF_MS
  const maxConsecutiveFailuresWithoutUrl = options.maxConsecutiveFailuresWithoutUrl ?? DEFAULT_MAX_FAILURES_WITHOUT_URL
  const stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS
  const probeUpstream = options.probeUpstream ?? isUpstreamReachable
  const upstreamRecheckMs = options.upstreamRecheckMs ?? DEFAULT_UPSTREAM_RECHECK_MS
  const logs = createLogRing()
  const state: TunnelState = {
    name: config.name,
    provider: 'cloudflare-quick',
    for: config.for,
    url: null,
    status: 'stopped',
    lastUrlAt: null,
    detail: '',
  }
  const stateSubscribers = new Set<TunnelStateSubscriber>()

  let started = false
  let stopping = false
  let proc: ReturnType<typeof Bun.spawn> | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let recheckTimer: ReturnType<typeof setTimeout> | null = null
  let restartFailuresWithoutUrl = 0
  let attemptEmittedUrl = false
  let broadcastedUrl: string | null = null
  // Identifies the current live cloudflared attempt. Bumped on every launch, on
  // process exit, and on stop. A probe captures the generation it was started
  // under; if the process exits (into restart backoff) or the tunnel is stopped
  // while a probe is in flight, the resolved probe sees a stale generation and
  // bails — so it can never mark a dead process's tunnel healthy.
  let launchGeneration = 0

  function setStatus(status: TunnelState['status'], detail: string): void {
    state.status = status
    state.detail = detail
    const snapshot = { ...state }
    for (const subscriber of stateSubscribers) subscriber(snapshot)
  }

  function clearRecheckTimer(): void {
    if (recheckTimer !== null) {
      clearTimeout(recheckTimer)
      recheckTimer = null
    }
  }

  // cloudflared emits the URL once, but the upstream service may still be
  // booting. We broadcast the URL immediately (channel adapters need it) yet
  // gate `healthy` on a real upstream probe, re-checking on an interval so the
  // status flips to healthy the moment the service comes up — and surfaces a
  // 502-explaining detail until then.
  async function onQuickUrl(url: string, generation: number): Promise<void> {
    if (generation !== launchGeneration) return
    attemptEmittedUrl = true
    restartFailuresWithoutUrl = 0
    state.url = url
    state.lastUrlAt = Date.now()
    if (broadcastedUrl !== url) {
      broadcastedUrl = url
      onUrlChange(url)
    }
    await reprobeUpstream(generation)
  }

  async function reprobeUpstream(generation: number): Promise<void> {
    if (generation !== launchGeneration || !started || stopping || state.url === null) return
    const reachable = await probeUpstream(upstreamPort)
    if (generation !== launchGeneration || !started || stopping || state.url === null) return
    if (reachable) {
      setStatus('healthy', 'quick tunnel URL emitted; upstream reachable')
      clearRecheckTimer()
      return
    }
    setStatus(
      'unhealthy',
      `quick tunnel URL emitted but upstream 127.0.0.1:${upstreamPort} is not reachable (requests will 502)`,
    )
    clearRecheckTimer()
    recheckTimer = setTimeout(() => {
      recheckTimer = null
      void reprobeUpstream(generation)
    }, upstreamRecheckMs)
  }

  async function launch(): Promise<void> {
    if (!started || stopping) return

    const generation = ++launchGeneration
    attemptEmittedUrl = false
    setStatus('starting', 'starting cloudflared')
    let spawned: Bun.Subprocess<'ignore', 'ignore', 'pipe'>
    try {
      spawned = Bun.spawn(
        [binary, 'tunnel', '--url', `http://127.0.0.1:${upstreamPort}`, '--no-autoupdate', '--metrics', '127.0.0.1:0'],
        { stdout: 'ignore', stderr: 'pipe' },
      )
    } catch (err) {
      if (isBinaryNotFound(err)) {
        setStatus('permanently-failed', MISSING_BINARY_DETAIL)
        return
      }
      throw err
    }
    proc = spawned

    void pumpStderr(spawned.stderr, logs, (line) => {
      const url = extractQuickTunnelUrl(line)
      if (url === null) return
      void onQuickUrl(url, generation)
    })

    void spawned.exited.then((code) => {
      if (proc !== spawned) return
      proc = null
      if (!started || stopping) return
      handleExit(code)
    })
  }

  function handleExit(code: number): void {
    launchGeneration += 1
    clearRecheckTimer()
    if (!attemptEmittedUrl) restartFailuresWithoutUrl += 1
    if (restartFailuresWithoutUrl >= maxConsecutiveFailuresWithoutUrl) {
      setStatus('permanently-failed', `cloudflared exited ${code}; retry cap reached before URL emission`)
      return
    }

    setStatus('unhealthy', `cloudflared exited ${code}; restarting`)
    const delay = restartBackoffMs[Math.min(restartFailuresWithoutUrl - 1, restartBackoffMs.length - 1)] ?? 30_000
    retryTimer = setTimeout(() => {
      retryTimer = null
      void launch()
    }, delay)
  }

  return {
    async start(): Promise<void> {
      if (started) return
      started = true
      stopping = false
      restartFailuresWithoutUrl = 0
      await launch()
    },
    async stop(): Promise<void> {
      if (!started && proc === null) return
      started = false
      stopping = true
      broadcastedUrl = null
      launchGeneration += 1
      clearRecheckTimer()
      if (retryTimer !== null) {
        clearTimeout(retryTimer)
        retryTimer = null
      }

      const running = proc
      proc = null
      if (running !== null) {
        running.kill('SIGTERM')
        await Promise.race([
          running.exited,
          sleep(stopGraceMs).then(() => {
            running.kill('SIGKILL')
            return running.exited
          }),
        ])
      }

      stopping = false
      setStatus('stopped', '')
    },
    snapshot(): TunnelState {
      return { ...state }
    },
    tail(): string[] {
      return logs.snapshot()
    },
    subscribeToState(cb: TunnelStateSubscriber): Unsubscribe {
      stateSubscribers.add(cb)
      return () => {
        stateSubscribers.delete(cb)
      }
    },
    subscribeToLogs(cb: LogLineSubscriber): Unsubscribe {
      return logs.subscribe(cb)
    },
  }
}

async function pumpStderr(
  stream: ReadableStream<Uint8Array> | null,
  logs: LogRing,
  onLine: (line: string) => void,
): Promise<void> {
  if (stream === null) return
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffered = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffered += decoder.decode(value, { stream: true })
      let newlineIndex = buffered.indexOf('\n')
      while (newlineIndex !== -1) {
        const line = buffered.slice(0, newlineIndex).replace(/\r$/, '')
        logs.append(line)
        onLine(line)
        buffered = buffered.slice(newlineIndex + 1)
        newlineIndex = buffered.indexOf('\n')
      }
    }
    buffered += decoder.decode()
    if (buffered !== '') {
      const line = buffered.replace(/\r$/, '')
      logs.append(line)
      onLine(line)
    }
  } finally {
    reader.releaseLock()
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
