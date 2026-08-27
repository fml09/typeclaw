export const CHANNEL_PROGRESS_INITIAL_TEXT = 'Processing…'
export const CHANNEL_PROGRESS_THINKING_TEXT = 'Thinking…'
export const CHANNEL_PROGRESS_WRITING_TEXT = 'Writing the response…'
export const CHANNEL_PROGRESS_WORKING_TEXT = 'Working…'
export const CHANNEL_PROGRESS_REVIEWING_TEXT = 'Reviewing the result…'
export const CHANNEL_PROGRESS_FAILURE_TEXT = 'I could not finish this response.'

// Progress messages are intentionally coarse. Raw thinking deltas can contain
// private reasoning, credentials, or prompt material, so they never cross the
// channel boundary. Only lifecycle phases are exposed.
export function progressTextForEvent(event: unknown): string | null {
  if (!isRecord(event)) return null

  if (event.type === 'tool_execution_start') return CHANNEL_PROGRESS_WORKING_TEXT
  if (event.type === 'tool_execution_end') return CHANNEL_PROGRESS_REVIEWING_TEXT
  if (event.type !== 'message_update' || !isRecord(event.assistantMessageEvent)) return null

  switch (event.assistantMessageEvent.type) {
    case 'thinking_delta':
      return CHANNEL_PROGRESS_THINKING_TEXT
    case 'text_delta':
      return CHANNEL_PROGRESS_WRITING_TEXT
    default:
      return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
