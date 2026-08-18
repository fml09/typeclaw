export type RuntimeHealthStatus = 'starting' | 'ready' | 'degraded' | 'replacing' | 'stopping'

export type RuntimeHealthSnapshot = {
  schemaVersion: 1
  status: RuntimeHealthStatus
  ready: boolean
  degraded: boolean
  degradedComponents: string[]
}

export interface RuntimeHealth {
  snapshot(): RuntimeHealthSnapshot
  markReady(): void
  markDegraded(component: string): void
  markReplacementPending(): void
  markStopping(): void
}

// Mutable boot-state owned by startAgent and exposed read-only through the
// server's health endpoints. Degradation is sticky for the process lifetime:
// becoming ready must not erase a component failure observed during startup.
export function createRuntimeHealth(): RuntimeHealth {
  let phase: 'starting' | 'ready' | 'replacing' | 'stopping' = 'starting'
  const degradedComponents = new Set<string>()

  return {
    snapshot(): RuntimeHealthSnapshot {
      const degraded = degradedComponents.size > 0
      const ready = phase === 'ready'
      const status: RuntimeHealthStatus =
        phase === 'stopping'
          ? 'stopping'
          : phase === 'replacing'
            ? 'replacing'
            : phase === 'starting'
              ? 'starting'
              : degraded
                ? 'degraded'
                : 'ready'
      return {
        schemaVersion: 1,
        status,
        ready,
        degraded,
        degradedComponents: [...degradedComponents].sort(),
      }
    },
    markReady(): void {
      // A fatal event can arrive during asynchronous startup. Once replacement
      // is pending, the tail of boot must not accidentally advertise ready.
      if (phase === 'starting') phase = 'ready'
    },
    markDegraded(component: string): void {
      if (component.length > 0) degradedComponents.add(component)
    },
    markReplacementPending(): void {
      if (phase !== 'stopping') phase = 'replacing'
    },
    markStopping(): void {
      phase = 'stopping'
    },
  }
}
