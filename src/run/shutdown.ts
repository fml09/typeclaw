export type ShutdownDeadline = { unref?: () => void }

export type RuntimeShutdownHandlerOptions = {
  markStopping: () => void
  prepareHandoff: () => Promise<void>
  stop: () => Promise<void>
  exit?: (code: number) => void
  deadlineMs?: number
  setDeadline?: (callback: () => void, delayMs: number) => ShutdownDeadline
  clearDeadline?: (deadline: ShutdownDeadline) => void
  log?: (message: string) => void
}

const DEFAULT_SHUTDOWN_DEADLINE_MS = 8_000

// One owner for the supervised-runtime SIGTERM sequence. Readiness changes in
// the signal's synchronous turn; continuation state is persisted before any
// teardown can destroy its live-session inputs; process exit remains bounded.
export function createRuntimeShutdownHandler(options: RuntimeShutdownHandlerOptions): () => void {
  const exit = options.exit ?? process.exit
  const setDeadline = options.setDeadline ?? ((callback, delayMs) => setTimeout(callback, delayMs) as ShutdownDeadline)
  const clearDeadline = options.clearDeadline ?? ((deadline) => clearTimeout(deadline as ReturnType<typeof setTimeout>))
  const log = options.log ?? ((message: string) => console.warn(message))
  let shuttingDown = false

  return (): void => {
    if (shuttingDown) return
    shuttingDown = true
    options.markStopping()
    const deadline = setDeadline(() => exit(0), options.deadlineMs ?? DEFAULT_SHUTDOWN_DEADLINE_MS)
    deadline.unref?.()

    void (async () => {
      try {
        await options.prepareHandoff()
      } catch (err) {
        log(`[run] shutdown handoff failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      try {
        await options.stop()
      } catch (err) {
        log(`[run] shutdown teardown failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      clearDeadline(deadline)
      exit(0)
    })()
  }
}
