import type { TunnelConfig, TunnelProviderHandle, TunnelState, TunnelStateSubscriber } from '../types'

export type ExternalProviderOptions = {
  config: TunnelConfig
  onUrlChange: (url: string) => void
}

export function createExternalProvider(options: ExternalProviderOptions): TunnelProviderHandle {
  const { config, onUrlChange } = options
  if (config.provider !== 'external') {
    throw new Error(`createExternalProvider: provider must be 'external', got '${config.provider}'`)
  }
  const url = config.externalUrl
  if (url === undefined || url.trim() === '') {
    throw new Error(`tunnel '${config.name}' (external): externalUrl is required`)
  }

  let started = false
  const state: TunnelState = {
    name: config.name,
    provider: 'external',
    for: config.for,
    url: null,
    status: 'stopped',
    lastUrlAt: null,
    detail: '',
  }
  const stateSubscribers = new Set<TunnelStateSubscriber>()

  function setStatus(status: TunnelState['status']): void {
    state.status = status
    const snapshot = { ...state }
    for (const subscriber of stateSubscribers) subscriber(snapshot)
  }

  return {
    async start(): Promise<void> {
      if (started) return
      started = true
      state.url = url
      state.lastUrlAt = Date.now()
      setStatus('healthy')
      onUrlChange(url)
    },
    async stop(): Promise<void> {
      if (!started) return
      started = false
      setStatus('stopped')
    },
    snapshot(): TunnelState {
      return { ...state }
    },
    tail(): string[] {
      return []
    },
    subscribeToState(cb: TunnelStateSubscriber): () => void {
      stateSubscribers.add(cb)
      return () => {
        stateSubscribers.delete(cb)
      }
    },
    subscribeToLogs(): () => void {
      return () => {}
    },
  }
}
