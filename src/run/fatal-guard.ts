// Process-level crash guard for the container stage. The incident: a Webex KMS
// request rejected 30s AFTER `listener.on('error')` already fired, so it escaped
// the adapter as an `unhandledRejection` — which Bun terminates the process on
// by default, taking Slack/Discord/cron/TUI/websocket down with one flaky dep.
//
// The guard NEVER calls `process.exit`. Policy (see `classifyFatalError`) is
// conservative so "never crash" does not become "pretend the process is healthy":
// a KNOWN channel-dependency `unhandledRejection` degrades just that channel; an
// `uncaughtException` or UNKNOWN `unhandledRejection` requests a supervised
// container restart (corrupt state is safer replaced than swallowed) while
// continuing best-effort until the host replaces us — it still never self-exits.
// Restart requests are rate-limited so a per-tick fault can't hammer the daemon.

export type FatalGuardKind = 'unhandledRejection' | 'uncaughtException'

export type FatalGuardDecision =
  | { action: 'continue'; reason: string; scope?: string }
  | { action: 'restart'; reason: string; scope?: string }

export type FatalGuardLogger = {
  warn: (msg: string) => void
  error: (msg: string) => void
}

export type FatalGuardOptions = {
  logger?: FatalGuardLogger
  // Ask the host daemon to bounce this container. Returns ok=false (never
  // throws) when no host control endpoint is configured — the guard then logs
  // and continues degraded rather than exiting.
  requestRestart?: (reason: string) => Promise<{ ok: boolean; reason?: string }>
  // Called for a `continue` decision carrying a channel scope, so the channel
  // can be visibly marked degraded (e.g. log/status) instead of silently
  // swallowing the error.
  onDegrade?: (scope: string, reason: string) => void
  // Called synchronously for an undefined-state failure, before replacement
  // control is contacted. Readiness must drop immediately: a managed file ACK
  // only proves the request was published, not that a controller acted on it.
  onReplacementPending?: () => void
  now?: () => number
  // Minimum spacing between restart requests. A fault re-firing on every event
  // loop tick must not spam the host daemon. Default 60s.
  restartMinIntervalMs?: number
}

export type FatalGuard = {
  // Exposed for deterministic tests: invoke the policy without emitting a real
  // process event. Production paths go through the installed listeners.
  handle: (kind: FatalGuardKind, error: unknown) => void
}

const DEFAULT_RESTART_MIN_INTERVAL_MS = 60_000

const consoleLogger: FatalGuardLogger = {
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
}

// One process gets exactly one pair of OS-level listeners no matter how many
// callers install a guard (tests, `typeclaw compose`, an embedding host). Each
// caller's handler is refcounted into this set and receives every event; the
// listeners are attached on the first install and detached when the last
// disposer runs. A per-caller `process.on` would otherwise stack N copies that
// all fire on one rejection and survive a single `dispose()`.
type Installed = {
  handlers: Set<(kind: FatalGuardKind, error: unknown) => void>
  onUnhandledRejection: (reason: unknown) => void
  onUncaughtException: (error: unknown) => void
}
let shared: Installed | null = null

export function installFatalGuard(options: FatalGuardOptions = {}): { guard: FatalGuard; dispose: () => void } {
  const logger = options.logger ?? consoleLogger
  const now = options.now ?? Date.now
  const restartMinIntervalMs = options.restartMinIntervalMs ?? DEFAULT_RESTART_MIN_INTERVAL_MS
  let lastRestartRequestAt: number | null = null

  const markDegraded = (scope: string, reason: string): void => {
    try {
      options.onDegrade?.(scope, reason)
    } catch (degradeErr) {
      logger.warn(`[fatal-guard] onDegrade(${scope}) threw: ${describeError(degradeErr)}`)
    }
  }

  const handle = (kind: FatalGuardKind, error: unknown): void => {
    // The guard body must never throw — a throwing handler re-enters the very
    // failure mode it exists to contain. Everything is wrapped, with a bare
    // console.error as the last-resort fallback.
    try {
      const decision = classifyFatalError(kind, error)
      const detail = describeError(error)
      logger.error(
        `[fatal-guard] ${kind}: ${decision.reason}${decision.scope !== undefined ? ` scope=${decision.scope}` : ''} action=${decision.action} :: ${detail}`,
      )

      if (decision.action === 'continue') {
        if (decision.scope !== undefined) {
          markDegraded(decision.scope, decision.reason)
        }
        return
      }

      try {
        options.onReplacementPending?.()
      } catch (pendingErr) {
        logger.warn(`[fatal-guard] onReplacementPending threw: ${describeError(pendingErr)}`)
      }
      requestRestart(decision.reason)
    } catch (handlerErr) {
      try {
        console.error(`[fatal-guard] handler failed: ${describeError(handlerErr)}`)
      } catch {
        // Nothing left to do; swallowing here is the whole point.
      }
    }
  }

  const requestRestart = (reason: string): void => {
    if (options.requestRestart === undefined) {
      logger.warn(`[fatal-guard] restart requested (${reason}) but no host control endpoint; continuing degraded`)
      markDegraded('runtime', `${reason}; replacement control is unavailable`)
      return
    }
    const at = now()
    if (lastRestartRequestAt !== null && at - lastRestartRequestAt < restartMinIntervalMs) {
      logger.warn(`[fatal-guard] restart requested (${reason}) but rate-limited; continuing degraded`)
      markDegraded('runtime', `${reason}; replacement request was rate-limited`)
      return
    }
    lastRestartRequestAt = at
    void options
      .requestRestart(reason)
      .then((result) => {
        if (result.ok) {
          logger.warn(`[fatal-guard] container restart requested: ${reason}`)
        } else {
          logger.warn(
            `[fatal-guard] container restart unavailable (${result.reason ?? 'unknown'}); continuing degraded`,
          )
          markDegraded('runtime', `${reason}; replacement unavailable: ${result.reason ?? 'unknown'}`)
        }
      })
      .catch((restartErr) => {
        logger.warn(`[fatal-guard] container restart request threw: ${describeError(restartErr)}; continuing degraded`)
        markDegraded('runtime', `${reason}; replacement request threw: ${describeError(restartErr)}`)
      })
  }

  if (shared === null) {
    const onUnhandledRejection = (reason: unknown): void => {
      for (const h of shared?.handlers ?? []) h('unhandledRejection', reason)
    }
    const onUncaughtException = (error: unknown): void => {
      for (const h of shared?.handlers ?? []) h('uncaughtException', error)
    }
    shared = { handlers: new Set(), onUnhandledRejection, onUncaughtException }
    process.on('unhandledRejection', onUnhandledRejection)
    process.on('uncaughtException', onUncaughtException)
  }
  shared.handlers.add(handle)

  let disposed = false
  const dispose = (): void => {
    if (disposed || shared === null) return
    disposed = true
    shared.handlers.delete(handle)
    if (shared.handlers.size === 0) {
      process.off('unhandledRejection', shared.onUnhandledRejection)
      process.off('uncaughtException', shared.onUncaughtException)
      shared = null
    }
  }

  return { guard: { handle }, dispose }
}

// Conservative by design. Only errors with positive evidence that they came
// from a known external channel dependency are recovered in place; everything
// else escalates to a supervised restart. Broad rules ("any Error with a code",
// "any network error") are intentionally avoided — they would mask real bugs.
export function classifyFatalError(kind: FatalGuardKind, error: unknown): FatalGuardDecision {
  if (kind === 'uncaughtException') {
    // A synchronous throw that reached the top of the stack means an unknown
    // code path is in an undefined state. Replace, don't swallow.
    return { action: 'restart', reason: 'uncaught exception' }
  }

  const scope = recognizeExternalChannelDependency(error)
  if (scope !== null) {
    return { action: 'continue', scope, reason: `${scope} async dependency rejection` }
  }

  return { action: 'restart', reason: 'unknown unhandled rejection' }
}

// Returns the channel scope to degrade when the rejection carries evidence of
// an external channel SDK, else null. Matches on structured error codes first,
// then on stack/module provenance — protocol/diagnostic tokens emitted by the
// libraries themselves, so English-literal matching is correct here (these are
// not natural-language user text).
function recognizeExternalChannelDependency(error: unknown): string | null {
  const code = errorCode(error)
  // Webex KMS (encryption key service) rejections: the incident's exact shape.
  // The `WebexListener` emits an 'error' event for connection failures, but a
  // KMS request that times out 30s later rejects a detached internal promise
  // that never reaches that event.
  if (code === 'KMS_ERROR') return 'webex'

  const haystack = errorProvenance(error).toLowerCase()
  if (haystack.includes('webex-message-handler') || haystack.includes('agent-messenger/webex')) return 'webex'

  // Other agent-messenger channel SDKs (slack/discord/telegram/line/kakaotalk).
  // Same containment rationale: one channel's escaped async rejection must not
  // take the whole agent down. Generic `agent-messenger/...` provenance maps to
  // a `channel` scope since the specific platform isn't always recoverable.
  if (haystack.includes('agent-messenger')) return 'channel'

  return null
}

function errorCode(error: unknown): string | null {
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const code = (error as { code: unknown }).code
    if (typeof code === 'string') return code
  }
  return null
}

function errorProvenance(error: unknown): string {
  if (error instanceof Error) {
    return `${error.stack ?? ''}\n${error.message}`
  }
  if (error !== null && typeof error === 'object') {
    const stack = 'stack' in error ? String((error as { stack: unknown }).stack ?? '') : ''
    const message = 'message' in error ? String((error as { message: unknown }).message ?? '') : ''
    return `${stack}\n${message}`
  }
  return String(error)
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = errorCode(error)
    return `${error.name}: ${error.message}${code !== null ? ` (code=${code})` : ''}`
  }
  return String(error)
}
