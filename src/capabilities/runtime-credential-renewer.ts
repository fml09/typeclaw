import { containerNameFromCwd } from '@/container'
import { type RenewalMethod, renewCurrentAccount } from '@/secrets/kakao-renewal'
import { type KeyStore, createKeyStore, defaultKeyStoreDir } from '@/secrets/keys'

const DEFAULT_TICK_INTERVAL_MS = 60 * 60 * 1000

export type RuntimeRenewableAdapter = 'kakaotalk'

export type RuntimeCredentialRotation = {
  adapter: RuntimeRenewableAdapter
  accountId: string
  method: RenewalMethod
}

export type RuntimeCredentialRenewerStartOptions = {
  shouldRenew: (adapter: RuntimeRenewableAdapter) => boolean
  onCredentialRotated: (rotation: RuntimeCredentialRotation) => Promise<void>
}

export interface RuntimeCredentialRenewer {
  // Starts the periodic loop and waits for its initial check. Waiting is a
  // boot-time credential barrier: a stale token is refreshed before channel
  // adapters capture credentials from disk.
  start(options: RuntimeCredentialRenewerStartOptions): Promise<void>
  // Stops future ticks and drains a write already in flight so shutdown never
  // interrupts an atomic secrets.json credential rotation.
  stop(): Promise<void>
}

export type RuntimeCredentialRenewalLogger = {
  info: (message: string) => void
  warn: (message: string) => void
  error: (message: string) => void
}

export type ManagedRuntimeCredentialRenewerOptions = {
  agentDir: string
  tickIntervalMs?: number
  renewalIdentity?: string
  keyStore?: KeyStore
  renew?: typeof renewCurrentAccount
  logger?: RuntimeCredentialRenewalLogger
  schedule?: (fn: () => void, intervalMs: number) => { stop: () => void }
}

const consoleLogger: RuntimeCredentialRenewalLogger = {
  info: (message) => console.info(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
}

// Managed deployments have no hostd process, so the foreground runtime owns
// this single-Agent renewal loop. The actual credential mutation remains in
// renewCurrentAccount, which locks and atomically rewrites secrets.json. The
// loop only owns timing, single-flight behavior, and applying a landed token to
// the live adapter through the callback supplied by src/run/index.ts.
export function createManagedRuntimeCredentialRenewer(
  options: ManagedRuntimeCredentialRenewerOptions,
): RuntimeCredentialRenewer {
  const intervalMs = options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS
  const renewalIdentity = options.renewalIdentity ?? containerNameFromCwd(options.agentDir)
  const keyStore = options.keyStore ?? createKeyStore({ keysDir: defaultKeyStoreDir() })
  const renew = options.renew ?? renewCurrentAccount
  const logger = options.logger ?? consoleLogger
  const schedule =
    options.schedule ??
    ((fn: () => void, ms: number) => {
      const handle = setInterval(fn, ms)
      return { stop: () => clearInterval(handle) }
    })

  let active = false
  let handle: { stop: () => void } | null = null
  let hooks: RuntimeCredentialRenewerStartOptions | null = null
  let inFlight: Promise<void> | null = null
  let rerunPending = false
  let pendingRotation: RuntimeCredentialRotation | null = null

  const applyPendingRotation = async (): Promise<boolean> => {
    const rotation = pendingRotation
    const currentHooks = hooks
    if (!active || rotation === null || currentHooks === null) return true
    try {
      await currentHooks.onCredentialRotated(rotation)
      if (active && pendingRotation === rotation) pendingRotation = null
      logger.info(
        `[credential-renewal] ${rotation.adapter} credential applied account=${rotation.accountId} method=${rotation.method}`,
      )
      return true
    } catch (err) {
      logger.error(
        `[credential-renewal] ${rotation.adapter} credential apply failed account=${rotation.accountId}: ${describeError(err)}`,
      )
      return false
    }
  }

  const runTick = async (): Promise<void> => {
    const currentHooks = hooks
    if (!active || currentHooks === null || !currentHooks.shouldRenew('kakaotalk')) return

    // A token can already be fresh on disk while its prior adapter reload
    // failed. Retry that application before deciding that freshness means the
    // tick has no work; otherwise a single stop failure would strand the live
    // adapter on the old token until the next five-day renewal.
    if (!(await applyPendingRotation())) return

    logger.info('[credential-renewal] kakaotalk renewal check started')
    try {
      const result = await renew({
        containerName: renewalIdentity,
        agentDir: options.agentDir,
        keyStore,
      })
      if (result.kind === 'skipped') {
        const age = result.ageMs === undefined ? '' : ` age=${Math.round(result.ageMs / 3_600_000)}h`
        logger.info(`[credential-renewal] kakaotalk renewal skipped reason=${result.reason}${age}`)
        return
      }
      if (result.kind === 'reauth_required') {
        logger.error(
          `[credential-renewal] kakaotalk reauthentication required account=${result.account_id} reason=${result.reason}: ${result.message}`,
        )
        return
      }
      if (result.kind === 'transient_failure') {
        logger.warn(
          `[credential-renewal] kakaotalk renewal transient failure account=${result.account_id}: ${result.reason}`,
        )
        return
      }

      logger.info(
        `[credential-renewal] kakaotalk credential renewed account=${result.account_id} method=${result.method} previous_updated_at=${result.previousUpdatedAt}`,
      )
      pendingRotation = {
        adapter: 'kakaotalk',
        accountId: result.account_id,
        method: result.method,
      }
      if (active) await applyPendingRotation()
    } catch (err) {
      logger.error(`[credential-renewal] kakaotalk renewal error: ${describeError(err)}`)
    }
  }

  const scheduleTick = (): Promise<void> => {
    if (!active) return Promise.resolve()
    if (inFlight !== null) {
      rerunPending = true
      return inFlight
    }
    const promise = (async () => {
      do {
        rerunPending = false
        await runTick()
      } while (active && rerunPending)
    })().finally(() => {
      if (inFlight === promise) inFlight = null
      rerunPending = false
    })
    inFlight = promise
    return promise
  }

  return {
    async start(startOptions): Promise<void> {
      if (active) return await (inFlight ?? Promise.resolve())
      active = true
      hooks = startOptions
      handle = schedule(() => {
        void scheduleTick()
      }, intervalMs)
      await scheduleTick()
    },

    async stop(): Promise<void> {
      if (!active && inFlight === null) return
      active = false
      handle?.stop()
      handle = null
      rerunPending = false
      await inFlight
      hooks = null
      pendingRotation = null
    },
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
