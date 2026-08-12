import { describe, expect, test } from 'bun:test'

import { SubagentCoalescer, subagentCoalesceKey } from '@/agent/subagents'
import { createReviewerSubagent, reviewerPayloadSchema } from '@/bundled-plugins/reviewer/reviewer'

import { acquireSubagentCoalesceLease } from './subagent-coalescing'

const identity = {
  repo: 'acme/widgets',
  pullRequest: 42,
  headSha: 'a'.repeat(40),
  reviewKind: 'review' as const,
}

function reviewer() {
  const plugin = createReviewerSubagent()
  return {
    systemPrompt: plugin.systemPrompt,
    payloadSchema: plugin.payloadSchema,
    inFlightKey: plugin.inFlightKey,
  }
}

function payload(requestId: string) {
  return reviewerPayloadSchema.parse({ requestId, reviewIdentity: identity })
}

describe('acquireSubagentCoalesceLease', () => {
  test('same parent suppresses direct dispatch while an equivalent tool or stream key is held', () => {
    const coalescer = new SubagentCoalescer()
    const subagent = reviewer()
    const heldKey = subagentCoalesceKey({
      subagentName: 'reviewer',
      payload: payload('bg_tool'),
      fallbackKey: 'bg_tool',
      inFlightKey: subagent.inFlightKey,
      parentSessionId: 'ses_parent',
    })
    coalescer.tryAcquire(heldKey)

    const direct = acquireSubagentCoalesceLease({
      coalescer,
      subagentName: 'reviewer',
      subagent,
      payload: payload('direct'),
      parentSessionId: 'ses_parent',
    })

    expect(direct).toBeNull()
  })

  test('identical reviewer identities remain independent across parent sessions', () => {
    const coalescer = new SubagentCoalescer()
    const subagent = reviewer()
    const first = acquireSubagentCoalesceLease({
      coalescer,
      subagentName: 'reviewer',
      subagent,
      payload: payload('direct-a'),
      parentSessionId: 'ses_a',
    })
    const second = acquireSubagentCoalesceLease({
      coalescer,
      subagentName: 'reviewer',
      subagent,
      payload: payload('direct-b'),
      parentSessionId: 'ses_b',
    })

    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    first?.release()
    second?.release()
  })

  test('parentless scheduler and direct dispatch remain process-wide', () => {
    const coalescer = new SubagentCoalescer()
    const subagent = reviewer()
    const first = acquireSubagentCoalesceLease({
      coalescer,
      subagentName: 'reviewer',
      subagent,
      payload: payload('scheduler'),
    })
    const duplicate = acquireSubagentCoalesceLease({
      coalescer,
      subagentName: 'reviewer',
      subagent,
      payload: payload('direct'),
    })

    expect(first).not.toBeNull()
    expect(duplicate).toBeNull()
    first?.release()
  })
})
