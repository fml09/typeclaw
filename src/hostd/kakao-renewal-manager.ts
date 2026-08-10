import {
  renewCurrentAccount,
  type AttemptLoginFn,
  type RefreshOAuthTokenFn,
  type RenewalMethod,
} from '@/secrets/kakao-renewal'
import { createKeyStore, type KeyStore } from '@/secrets/keys'

import { keysDir } from './paths'

const DEFAULT_TICK_INTERVAL_MS = 24 * 60 * 60 * 1000

export type KakaoRenewalCallbacks = {
  start: (input: KakaoRenewalStartInput) => void
  stop: (containerName: string) => Promise<void>
  drain: () => Promise<void>
}

export type KakaoRenewalStartInput = {
  containerName: string
  cwd: string
}

export type KakaoRenewalLogEvent =
  | { kind: 'kakao-renewal-tick-start'; containerName: string }
  | { kind: 'kakao-renewal-tick-skipped'; containerName: string; reason: string; ageMs?: number }
  | {
      kind: 'kakao-renewal-tick-ok'
      containerName: string
      accountId: string
      previousUpdatedAt: string
      method?: RenewalMethod
    }
  | {
      kind: 'kakao-renewal-tick-reauth-required'
      containerName: string
      accountId: string
      reason: string
      message: string
    }
  | { kind: 'kakao-renewal-tick-transient-failure'; containerName: string; accountId: string; reason: string }
  | { kind: 'kakao-renewal-tick-error'; containerName: string; error: string }
  | { kind: 'kakao-renewal-restart-scheduled'; containerName: string; accountId: string }
  | { kind: 'kakao-renewal-restart-failed'; containerName: string; accountId: string; reason: string }

export type KakaoRenewalManagerOptions = {
  onLog?: (event: KakaoRenewalLogEvent) => void
  tickIntervalMs?: number
  keyStoreFactory?: () => KeyStore
  attemptLogin?: AttemptLoginFn
  refreshOAuthToken?: RefreshOAuthTokenFn
  schedule?: (fn: () => void, intervalMs: number) => { stop: () => void }
  // Invoked after a successful renewal so the host can hot-reload the adapter
  // and the in-memory LOCO client picks up the fresh tokens. Production falls
  // back to recreating the container only when the reload transport fails;
  // tests can observe the callback via a fake.
  onRenewalOk?: (input: { containerName: string; cwd: string; accountId: string }) => Promise<void>
  // Optional predicate: only start the renewal cron for containers whose
  // `typeclaw.json` actually has a `channels.kakaotalk` block. Without this,
  // every typeclaw agent on the host emits daily `no_account` skip logs.
  shouldRenew?: (input: KakaoRenewalStartInput) => boolean
}

// Per-container daily renewal tick. Mirrors portbroker-manager.ts: hostd calls
// start() on register and stop() on deregister, and the manager owns timer
// lifecycle plus the actual renewal work. The keystore lives on the host
// (~/.typeclaw/keys/<name>.key), unreachable from inside the container —
// that's load-bearing for encryption.ts's threat model.
export function createKakaoRenewalManager(opts: KakaoRenewalManagerOptions = {}): KakaoRenewalCallbacks {
  const intervalMs = opts.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS
  const keyStore = (opts.keyStoreFactory ?? (() => createKeyStore({ keysDir: keysDir() })))()
  const log = opts.onLog ?? (() => {})
  const schedule =
    opts.schedule ??
    ((fn: () => void, ms: number) => {
      const handle = setInterval(fn, ms)
      return { stop: () => clearInterval(handle) }
    })

  const timers = new Map<string, { stop: () => void }>()
  // Track the latest registration input per container so a re-register
  // arriving during an in-flight tick can both (a) prevent the in-flight tick
  // from acting on stale cwd, and (b) trigger a fresh tick once the in-flight
  // one finishes. The Map's value is the most recent input.
  const latestInput = new Map<string, KakaoRenewalStartInput>()
  // Track in-flight tick promises per container so stop()/drain() can await
  // them. Without this, daemon shutdown abandons an in-flight renewal HTTPS
  // request mid-write.
  const inFlight = new Map<string, Promise<void>>()
  // Pending immediate-tick request: set when start() is called while a tick
  // is in flight, so we re-fire one tick after the in-flight settles.
  const pendingRerun = new Set<string>()

  const runTick = async (input: KakaoRenewalStartInput): Promise<void> => {
    log({ kind: 'kakao-renewal-tick-start', containerName: input.containerName })
    try {
      const result = await renewCurrentAccount({
        containerName: input.containerName,
        agentDir: input.cwd,
        keyStore,
        ...(opts.attemptLogin ? { attemptLogin: opts.attemptLogin } : {}),
        ...(opts.refreshOAuthToken ? { refreshOAuthToken: opts.refreshOAuthToken } : {}),
      })
      if (result.kind === 'skipped') {
        log({
          kind: 'kakao-renewal-tick-skipped',
          containerName: input.containerName,
          reason: result.reason,
          ...(result.ageMs !== undefined ? { ageMs: result.ageMs } : {}),
        })
      } else if (result.kind === 'ok') {
        log({
          kind: 'kakao-renewal-tick-ok',
          containerName: input.containerName,
          accountId: result.account_id,
          previousUpdatedAt: result.previousUpdatedAt,
          method: result.method,
        })
        // A tick that started before stop()/drain() (deregister, shutdown) or
        // before a re-register with a different cwd can finish the slow renewal
        // here. Restarting a container that is no longer the current
        // registration would resurrect a just-deregistered agent or fight a
        // shutdown, so skip onRenewalOk unless this container+cwd is still the
        // live registration. Matches webex-renewal-manager's guard.
        const current = latestInput.get(input.containerName)
        if (opts.onRenewalOk && current?.cwd === input.cwd) {
          log({
            kind: 'kakao-renewal-restart-scheduled',
            containerName: input.containerName,
            accountId: result.account_id,
          })
          try {
            await opts.onRenewalOk({
              containerName: input.containerName,
              cwd: input.cwd,
              accountId: result.account_id,
            })
          } catch (err) {
            log({
              kind: 'kakao-renewal-restart-failed',
              containerName: input.containerName,
              accountId: result.account_id,
              reason: err instanceof Error ? err.message : String(err),
            })
          }
        }
      } else if (result.kind === 'reauth_required') {
        log({
          kind: 'kakao-renewal-tick-reauth-required',
          containerName: input.containerName,
          accountId: result.account_id,
          reason: result.reason,
          message: result.message,
        })
      } else {
        log({
          kind: 'kakao-renewal-tick-transient-failure',
          containerName: input.containerName,
          accountId: result.account_id,
          reason: result.reason,
        })
      }
    } catch (err) {
      // Defensive: renewCurrentAccount's contract is to return a structured
      // result, but a malformed secrets.json or a disk error could surface
      // here. Log and move on — the next tick retries.
      log({
        kind: 'kakao-renewal-tick-error',
        containerName: input.containerName,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // Single-flight per container: dedupe overlapping ticks, but if a new
  // tick request arrives while one is in flight, queue ONE rerun so the new
  // registration's cwd (or a manual nudge) gets a chance after the in-flight
  // settles. The Promise stored in inFlight resolves only after any queued
  // rerun also completes, so stop()/drain() awaiting inFlight is enough to
  // observe a quiescent manager.
  const scheduleTick = (containerName: string): Promise<void> => {
    const existing = inFlight.get(containerName)
    if (existing) {
      pendingRerun.add(containerName)
      return existing
    }
    const promise = (async () => {
      // Loop until no rerun was queued during this tick, so the LAST input
      // recorded for the container is the one we end on. This handles the
      // re-register-while-in-flight + cwd-change case described in the
      // pendingRerun comment above.
      while (true) {
        const input = latestInput.get(containerName)
        if (!input) return
        await runTick(input)
        if (!pendingRerun.has(containerName)) return
        pendingRerun.delete(containerName)
      }
    })().finally(() => {
      inFlight.delete(containerName)
      pendingRerun.delete(containerName)
    })
    inFlight.set(containerName, promise)
    return promise
  }

  return {
    start(input: KakaoRenewalStartInput): void {
      // Tear down any prior registration for this container BEFORE the
      // shouldRenew gate. The daemon calls start() on every registration, so a
      // container that had Kakao can re-register to a non-Kakao cwd; if we
      // returned early without clearing, the old timer would keep ticking and a
      // post-login restart guard would still match the stale cwd. Clearing
      // latestInput also makes an in-flight tick's onRenewalOk re-check fail.
      const existing = timers.get(input.containerName)
      if (existing) {
        existing.stop()
        timers.delete(input.containerName)
      }
      latestInput.delete(input.containerName)

      if (opts.shouldRenew && !opts.shouldRenew(input)) return

      latestInput.set(input.containerName, input)
      const handle = schedule(() => {
        void scheduleTick(input.containerName)
      }, intervalMs)
      timers.set(input.containerName, handle)
      void scheduleTick(input.containerName)
    },

    // Must NOT await the in-flight tick: a successful tick runs onRenewalOk →
    // hostdRestart → container stop() → deregister RPC → handleDeregister →
    // kakaoRenewal.stop(), so awaiting inFlight here waits on the very tick that
    // is parked waiting for this restart — a self-deadlock that wedges the
    // daemon's per-container serial chain forever. Clearing latestInput (not the
    // await) is what fails the tick's onRenewalOk guard; drain() still awaits.
    stop(containerName: string): Promise<void> {
      const handle = timers.get(containerName)
      if (handle) {
        timers.delete(containerName)
        handle.stop()
      }
      latestInput.delete(containerName)
      return Promise.resolve()
    },

    async drain(): Promise<void> {
      for (const [, handle] of timers) handle.stop()
      timers.clear()
      // Clear latestInput AFTER awaiting in-flight: the onRenewalOk guard reads
      // latestInput, so clearing first would suppress the restart of a tick that
      // is mid-login when drain() runs. drain() is shutdown — it waits for that
      // work to finish rather than dropping it.
      const promises = Array.from(inFlight.values())
      await Promise.allSettled(promises)
      latestInput.clear()
    },
  }
}
