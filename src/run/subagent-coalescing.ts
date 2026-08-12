import { type Subagent, SubagentCoalescer, subagentCoalesceKey } from '@/agent/subagents'

export type SubagentCoalesceLease = {
  key: string
  release: () => void
}

export function acquireSubagentCoalesceLease<P>(options: {
  coalescer: SubagentCoalescer
  subagentName: string
  subagent: Subagent<P> | undefined
  payload: P
  parentSessionId?: string
}): SubagentCoalesceLease | null {
  const key = subagentCoalesceKey({
    subagentName: options.subagentName,
    payload: options.payload,
    fallbackKey: options.subagentName,
    ...(options.subagent?.inFlightKey !== undefined ? { inFlightKey: options.subagent.inFlightKey } : {}),
    ...(options.parentSessionId !== undefined ? { parentSessionId: options.parentSessionId } : {}),
  })
  if (!options.coalescer.tryAcquire(key)) return null
  return { key, release: () => options.coalescer.release(key) }
}
