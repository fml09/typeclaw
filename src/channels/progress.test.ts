import { describe, expect, test } from 'bun:test'

import {
  CHANNEL_PROGRESS_REVIEWING_TEXT,
  CHANNEL_PROGRESS_THINKING_TEXT,
  CHANNEL_PROGRESS_WORKING_TEXT,
  CHANNEL_PROGRESS_WRITING_TEXT,
  progressTextForEvent,
} from './progress'

describe('progressTextForEvent', () => {
  test('maps thinking deltas to a safe coarse status', () => {
    expect(
      progressTextForEvent({
        type: 'message_update',
        assistantMessageEvent: { type: 'thinking_delta', delta: 'secret' },
      }),
    ).toBe(CHANNEL_PROGRESS_THINKING_TEXT)
  })

  test('maps visible text deltas without exposing their content', () => {
    expect(
      progressTextForEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'answer' } }),
    ).toBe(CHANNEL_PROGRESS_WRITING_TEXT)
  })

  test('maps tool lifecycle events to coarse statuses', () => {
    expect(progressTextForEvent({ type: 'tool_execution_start', toolName: 'read', args: { path: 'secret' } })).toBe(
      CHANNEL_PROGRESS_WORKING_TEXT,
    )
    expect(progressTextForEvent({ type: 'tool_execution_end', toolName: 'read', result: 'ok', isError: false })).toBe(
      CHANNEL_PROGRESS_REVIEWING_TEXT,
    )
  })

  test('ignores unrelated and malformed events', () => {
    expect(
      progressTextForEvent({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', delta: '{}' } }),
    ).toBeNull()
    expect(progressTextForEvent({ type: 'tool_execution_end' })).toBe(CHANNEL_PROGRESS_REVIEWING_TEXT)
    expect(progressTextForEvent(null)).toBeNull()
  })
})
