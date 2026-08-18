import type { Stream } from '@/stream'

import { createCloudflareNamedProvider } from './providers/cloudflare-named'
import { createCloudflareQuickProvider } from './providers/cloudflare-quick'
import { createExternalProvider } from './providers/external'
import type { TunnelConfig, TunnelProviderHandle, TunnelState, TunnelUrlChangedPayload } from './types'

export type TunnelManagerLogger = {
  info: (m: string) => void
  warn: (m: string) => void
  error: (m: string) => void
}

export type TunnelManagerOptions = {
  tunnels: TunnelConfig[]
  stream: Stream
  resolveChannelUpstreamPort?: (channelName: string) => number | null
  cloudflareQuickBinary?: string
  cloudflareNamedBinary?: string
  // Reads an env var by name. Defaults to `process.env[name]` in production.
  // Parameterized so tests can drive the named-provider token path without
  // poking global env and so the manager stays a pure function of its inputs.
  resolveEnv?: (name: string) => string | undefined
  logger?: TunnelManagerLogger
  // Reports isolated startup failures without turning them into boot failure.
  onDegrade?: (component: string, reason: string) => void
}

export type TunnelManager = {
  start: () => Promise<void>
  stop: () => Promise<void>
  snapshot: () => TunnelState[]
  urlFor: (tunnelName: string) => string | null
  tail: (tunnelName: string) => string[]
  subscribeToLogs: (tunnelName: string, cb: (line: string) => void) => () => void
}

const consoleLogger: TunnelManagerLogger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
}

export function createTunnelManager(options: TunnelManagerOptions): TunnelManager {
  const logger = options.logger ?? consoleLogger
  const handles = new Map<string, TunnelProviderHandle>()
  const degradedTunnels = new Set<string>()
  const resolveEnv = options.resolveEnv ?? ((name: string) => process.env[name])

  const reportDegraded = (state: TunnelState): void => {
    if (state.status !== 'unhealthy' && state.status !== 'permanently-failed') return
    if (degradedTunnels.has(state.name)) return
    degradedTunnels.add(state.name)
    options.onDegrade?.(`tunnel:${state.name}`, state.detail)
  }

  for (const config of options.tunnels) {
    const handle = buildProvider(
      config,
      options.resolveChannelUpstreamPort,
      (url) => publishUrlChange(options.stream, config, url, logger),
      options.cloudflareQuickBinary,
      options.cloudflareNamedBinary,
      resolveEnv,
    )
    handle.subscribeToState(reportDegraded)
    handles.set(config.name, handle)
  }

  return {
    async start(): Promise<void> {
      await Promise.all(
        Array.from(handles.values()).map(async (h) => {
          try {
            await h.start()
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err)
            const name = h.snapshot().name
            logger.error(`[tunnels] ${name}: start failed: ${reason}`)
            if (!degradedTunnels.has(name)) {
              degradedTunnels.add(name)
              options.onDegrade?.(`tunnel:${name}`, reason)
            }
          }
        }),
      )
    },
    async stop(): Promise<void> {
      await Promise.all(
        Array.from(handles.values()).map((h) =>
          h.stop().catch((err: unknown) => {
            logger.warn(
              `[tunnels] ${h.snapshot().name}: stop failed: ${err instanceof Error ? err.message : String(err)}`,
            )
          }),
        ),
      )
    },
    snapshot(): TunnelState[] {
      return Array.from(handles.values()).map((h) => h.snapshot())
    },
    urlFor(tunnelName: string): string | null {
      return handles.get(tunnelName)?.snapshot().url ?? null
    },
    tail(tunnelName: string): string[] {
      return handles.get(tunnelName)?.tail() ?? []
    },
    subscribeToLogs(tunnelName: string, cb: (line: string) => void): () => void {
      return handles.get(tunnelName)?.subscribeToLogs(cb) ?? (() => {})
    },
  }
}

function buildProvider(
  config: TunnelConfig,
  resolveChannelUpstreamPort: TunnelManagerOptions['resolveChannelUpstreamPort'],
  onUrlChange: (url: string) => void,
  cloudflareQuickBinary: string | undefined,
  cloudflareNamedBinary: string | undefined,
  resolveEnv: (name: string) => string | undefined,
): TunnelProviderHandle {
  switch (config.provider) {
    case 'external':
      return createExternalProvider({ config, onUrlChange })
    case 'cloudflare-quick':
      return createCloudflareQuickProvider({
        config,
        upstreamPort: resolveUpstreamPort(config, resolveChannelUpstreamPort),
        onUrlChange,
        binary: cloudflareQuickBinary,
      })
    case 'cloudflare-named':
      return createCloudflareNamedProvider({
        config,
        onUrlChange,
        resolveToken: () => (config.tokenEnv !== undefined ? resolveEnv(config.tokenEnv) : undefined),
        binary: cloudflareNamedBinary,
      })
  }
}

function resolveUpstreamPort(
  config: TunnelConfig,
  resolveChannelUpstreamPort: TunnelManagerOptions['resolveChannelUpstreamPort'],
): number {
  if (config.for.kind === 'manual') {
    if (config.upstreamPort === undefined) {
      throw new Error(`tunnel '${config.name}' (cloudflare-quick): upstreamPort is required for manual tunnels`)
    }
    return config.upstreamPort
  }

  const upstreamPort = resolveChannelUpstreamPort?.(config.for.name) ?? null
  if (upstreamPort === null) {
    throw new Error(
      `tunnel '${config.name}' (cloudflare-quick): no upstream port resolved for channel '${config.for.name}'`,
    )
  }
  return upstreamPort
}

function publishUrlChange(stream: Stream, config: TunnelConfig, url: string, logger: TunnelManagerLogger): void {
  const payload: TunnelUrlChangedPayload = {
    kind: 'tunnel-url-changed',
    tunnelName: config.name,
    url,
    for: config.for,
    rotatedAt: new Date().toISOString(),
  }
  stream.publish({ target: { kind: 'broadcast' }, payload })
  logger.info(`[tunnels] ${config.name}: URL set to ${url}`)
}
