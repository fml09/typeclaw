import type { Unsubscribe } from '@/stream'

import { createLogRing, type LogLineSubscriber, type LogRing } from '../log-ring'
import type { TunnelConfig, TunnelProviderHandle, TunnelState, TunnelStateSubscriber } from '../types'
import { isBinaryNotFound, MISSING_BINARY_DETAIL } from './cloudflared-binary'

const DEFAULT_BINARY = 'cloudflared'
const DEFAULT_RESTART_BACKOFF_MS = [1_000, 2_000, 4_000, 10_000, 30_000]
const DEFAULT_MAX_CONSECUTIVE_CRASHES = 10
const DEFAULT_STOP_GRACE_MS = 5_000

export type CloudflareNamedProviderOptions = {
  config: TunnelConfig
  onUrlChange: (url: string) => void
  // Token resolver. Production wiring reads `process.env[config.tokenEnv]`;
  // the resolver is parameterized so tests can inject a value without poking
  // global env. Returning `undefined` (or empty string) at any call fails the
  // start with a clear error pointing at the env-var name.
  resolveToken: () => string | undefined
  binary?: string
  restartBackoffMs?: number[]
  maxConsecutiveCrashes?: number
  stopGraceMs?: number
}

export type CloudflareNamedProviderHandle = TunnelProviderHandle & {
  tail: () => string[]
  subscribeToLogs: (cb: LogLineSubscriber) => Unsubscribe
}

export function createCloudflareNamedProvider(options: CloudflareNamedProviderOptions): CloudflareNamedProviderHandle {
  const { config, onUrlChange, resolveToken } = options
  if (config.provider !== 'cloudflare-named') {
    throw new Error(`createCloudflareNamedProvider: provider must be 'cloudflare-named', got '${config.provider}'`)
  }
  const hostname = config.hostname
  if (hostname === undefined || hostname.trim() === '') {
    throw new Error(`tunnel '${config.name}' (cloudflare-named): hostname is required`)
  }
  const tokenEnv = config.tokenEnv
  if (tokenEnv === undefined || tokenEnv.trim() === '') {
    throw new Error(`tunnel '${config.name}' (cloudflare-named): tokenEnv is required`)
  }

  const binary = options.binary ?? DEFAULT_BINARY
  const restartBackoffMs = options.restartBackoffMs ?? DEFAULT_RESTART_BACKOFF_MS
  const maxConsecutiveCrashes = options.maxConsecutiveCrashes ?? DEFAULT_MAX_CONSECUTIVE_CRASHES
  const stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS
  const logs = createLogRing()
  const state: TunnelState = {
    name: config.name,
    provider: 'cloudflare-named',
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
  let consecutiveCrashes = 0

  function setStatus(status: TunnelState['status'], detail: string): void {
    state.status = status
    state.detail = detail
    const snapshot = { ...state }
    for (const subscriber of stateSubscribers) subscriber(snapshot)
  }

  async function launch(): Promise<void> {
    if (!started || stopping) return

    const token = resolveToken()
    if (token === undefined || token.trim() === '') {
      // Bad config rather than a transient process crash: the user-facing fix
      // is editing `.env`, not waiting for backoff. Flip straight to
      // permanently-failed so `tunnel status` makes the cause obvious and we
      // don't waste retries spawning a cloudflared we know will reject the
      // missing token.
      setStatus('permanently-failed', `env var ${tokenEnv} is unset or empty; set it in .env and restart`)
      return
    }

    setStatus('starting', 'starting cloudflared')
    let spawned: Bun.Subprocess<'ignore', 'ignore', 'pipe'>
    try {
      spawned = Bun.spawn([binary, 'tunnel', '--no-autoupdate', 'run', '--token', token], {
        stdout: 'ignore',
        stderr: 'pipe',
      })
    } catch (err) {
      if (isBinaryNotFound(err)) {
        setStatus('permanently-failed', MISSING_BINARY_DETAIL)
        return
      }
      throw err
    }
    proc = spawned

    // Mark healthy on the FIRST stderr line. cloudflared with a valid token
    // prints registration progress to stderr within ~1s of start; a process
    // that exits before printing anything is almost certainly a token/network
    // failure. Healthy != "traffic flowing" — only Cloudflare's edge knows
    // that — but it's the strongest signal available locally and matches the
    // quick provider's "saw something on stderr" health model.
    //
    // Deliberately does NOT reset `consecutiveCrashes`. A process that prints
    // one line of stderr then crashes is a tight crash loop (bad token,
    // network down, cloudflared bug); the counter must trip the cap. The
    // counter resets on operator action (`stop()` then `start()` again) or
    // on `typeclaw restart`, not on stderr noise.
    let sawFirstLine = false
    void pumpStderr(spawned.stderr, logs, () => {
      if (sawFirstLine) return
      sawFirstLine = true
      setStatus('healthy', 'cloudflared started')
    })

    void spawned.exited.then((code) => {
      if (proc !== spawned) return
      proc = null
      if (!started || stopping) return
      handleExit(code)
    })
  }

  function handleExit(code: number): void {
    consecutiveCrashes += 1
    if (consecutiveCrashes >= maxConsecutiveCrashes) {
      setStatus(
        'permanently-failed',
        `cloudflared exited ${code}; retry cap reached after ${consecutiveCrashes} consecutive crashes`,
      )
      return
    }

    setStatus('unhealthy', `cloudflared exited ${code}; restarting`)
    const delay = restartBackoffMs[Math.min(consecutiveCrashes - 1, restartBackoffMs.length - 1)] ?? 30_000
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
      consecutiveCrashes = 0
      // The URL is known from config, not from cloudflared. Emit it
      // synchronously so subscribers (channel adapters, tunnel-bridge) wire
      // up immediately, regardless of whether cloudflared comes up healthy.
      // For named tunnels, the URL is bound to the dashboard config — even
      // if the local process is unhealthy, the hostname is the right value
      // to surface in `tunnel-url-changed` events.
      state.url = hostname
      state.lastUrlAt = Date.now()
      onUrlChange(hostname)
      await launch()
    },
    async stop(): Promise<void> {
      if (!started && proc === null) return
      started = false
      stopping = true
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
