import { describe, expect, test } from 'bun:test'

import {
  CHANNEL_PROGRESS_COMPLETE_TEXT,
  CHANNEL_PROGRESS_FAILURE_TEXT,
  CHANNEL_PROGRESS_INITIAL_TEXT,
  CHANNEL_PROGRESS_LOG_MAX_ENTRIES,
  CHANNEL_PROGRESS_REVIEWING_TEXT,
  CHANNEL_PROGRESS_THINKING_TEXT,
  CHANNEL_PROGRESS_WORKING_TEXT,
  CHANNEL_PROGRESS_WRITING_TEXT,
  progressEditRetryDelayMs,
  progressTextForEvent,
  renderProgressText,
  toolNameForEvent,
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

describe('progress phase texts', () => {
  test('every phase text carries an emoji prefix so phases read as chat status lines', () => {
    // Kakao renders each MODIFYMSG as a message event; the emoji prefix keeps
    // the coarse phase texts readable when they surface as distinct bubbles.
    for (const text of [
      CHANNEL_PROGRESS_INITIAL_TEXT,
      CHANNEL_PROGRESS_THINKING_TEXT,
      CHANNEL_PROGRESS_WRITING_TEXT,
      CHANNEL_PROGRESS_WORKING_TEXT,
      CHANNEL_PROGRESS_REVIEWING_TEXT,
      CHANNEL_PROGRESS_COMPLETE_TEXT,
      CHANNEL_PROGRESS_FAILURE_TEXT,
    ]) {
      expect(/\p{Extended_Pictographic}/u.test(text)).toBe(true)
    }
  })
})

describe('progressEditRetryDelayMs', () => {
  test('doubles from the 1.5s base per consecutive failure and caps at 12s', () => {
    expect(progressEditRetryDelayMs(1, () => 0.5)).toBe(1500)
    expect(progressEditRetryDelayMs(2, () => 0.5)).toBe(3000)
    expect(progressEditRetryDelayMs(3, () => 0.5)).toBe(6000)
    expect(progressEditRetryDelayMs(4, () => 0.5)).toBe(12000)
    expect(progressEditRetryDelayMs(9, () => 0.5)).toBe(12000)
  })

  test('applies ±25% jitter around the backoff step', () => {
    expect(progressEditRetryDelayMs(1, () => 0)).toBe(1125)
    expect(progressEditRetryDelayMs(1, () => 1)).toBe(1875)
  })
})

describe('toolNameForEvent', () => {
  test('extracts the tool name from execution starts only', () => {
    expect(toolNameForEvent({ type: 'tool_execution_start', toolName: 'bash', args: { command: 'secret' } })).toBe(
      'bash',
    )
    expect(toolNameForEvent({ type: 'tool_execution_end', toolName: 'bash' })).toBeNull()
    expect(toolNameForEvent({ type: 'message_update' })).toBeNull()
    expect(toolNameForEvent(null)).toBeNull()
  })
})

describe('renderProgressText', () => {
  test('keeps the phase as the headline when no tool has run', () => {
    expect(renderProgressText(CHANNEL_PROGRESS_THINKING_TEXT, [])).toBe(CHANNEL_PROGRESS_THINKING_TEXT)
  })

  test('renders recent tool names as log lines under the phase', () => {
    expect(renderProgressText(CHANNEL_PROGRESS_WORKING_TEXT, ['bash', 'read'])).toBe(
      `${CHANNEL_PROGRESS_WORKING_TEXT}\n· bash\n· read`,
    )
  })

  test('windows the log to the most recent entries', () => {
    const log = Array.from({ length: 10 }, (_, i) => `tool${i}`)
    const rendered = renderProgressText(CHANNEL_PROGRESS_WORKING_TEXT, log)
    expect(rendered).toContain(`· tool${9}`)
    expect(rendered).not.toContain(`· tool${10 - CHANNEL_PROGRESS_LOG_MAX_ENTRIES - 1}`)
  })
})
