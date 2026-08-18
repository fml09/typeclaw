import type { Unsubscribe } from '@/stream'

export type TunnelProvider = 'external' | 'cloudflare-quick' | 'cloudflare-named'

export type TunnelFor = { kind: 'channel'; name: string } | { kind: 'manual' }

export type TunnelConfig = {
  name: string
  provider: TunnelProvider
  for: TunnelFor
  externalUrl?: string
  upstreamPort?: number
  // cloudflare-named only: the public hostname configured in the Cloudflare
  // dashboard (e.g. `https://agent.example.com`). typeclaw uses it verbatim
  // for `tunnel-url-changed` events and CLI display; cloudflared itself
  // learns the hostname → upstream mapping from the dashboard at runtime, so
  // the value here must mirror what the user typed in `Public Hostname`. If
  // the two drift, traffic stops flowing but typeclaw still reports the
  // stale URL — there is no programmatic way to detect this without hitting
  // Cloudflare's API, which we deliberately don't do.
  hostname?: string
  // cloudflare-named only: name of an env var (set in the agent's `.env`)
  // that holds the tunnel token printed by the Cloudflare dashboard when the
  // tunnel was created. The token itself never lives in typeclaw.json — only
  // the env-var name does. The container reads `process.env[tokenEnv]` at
  // tunnel start. Missing/empty values fail the start with a clear message
  // pointing at the env var name.
  tokenEnv?: string
}

export type TunnelStatus = 'stopped' | 'starting' | 'healthy' | 'unhealthy' | 'permanently-failed'

export type TunnelState = {
  name: string
  provider: TunnelProvider
  for: TunnelFor
  url: string | null
  status: TunnelStatus
  lastUrlAt: number | null
  detail: string
}

export type TunnelProviderHandle = {
  start: () => Promise<void>
  stop: () => Promise<void>
  snapshot: () => TunnelState
  tail: () => string[]
  subscribeToState: (cb: TunnelStateSubscriber) => Unsubscribe
  subscribeToLogs: (cb: TunnelLogSubscriber) => Unsubscribe
}

export type TunnelStateSubscriber = (state: TunnelState) => void

export type TunnelLogSubscriber = (line: string) => void

export type TunnelUrlChangedPayload = {
  kind: 'tunnel-url-changed'
  tunnelName: string
  url: string
  for: TunnelFor
  rotatedAt: string
}
