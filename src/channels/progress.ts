export const CHANNEL_PROGRESS_INITIAL_TEXT = '⏳ Processing…'
export const CHANNEL_PROGRESS_THINKING_TEXT = '💭 Thinking…'
export const CHANNEL_PROGRESS_WRITING_TEXT = '✍️ Writing the response…'
export const CHANNEL_PROGRESS_WORKING_TEXT = '🛠️ Working…'
export const CHANNEL_PROGRESS_REVIEWING_TEXT = '🔍 Reviewing the result…'
export const CHANNEL_PROGRESS_COMPLETE_TEXT = '✅ Done.'
export const CHANNEL_PROGRESS_FAILURE_TEXT = '⚠️ I could not finish this response.'

// Base delay for the first progress-edit retry, doubling per consecutive
// failure (1.5s → 3s → 6s → 12s, capped). Kakao's MODIFYMSG rate-limits tight
// edit bursts with -303 and can drop the socket; the ladder keeps a flaky
// window from hammering the limiter, and the jitter keeps concurrent agents
// from re-syncing onto it.
export const PROGRESS_EDIT_RETRY_BASE_MS = 1500
export const PROGRESS_EDIT_RETRY_MAX_MS = 12_000

export function progressEditRetryDelayMs(consecutiveFailures: number, random: () => number = Math.random): number {
  const backoff = Math.min(
    PROGRESS_EDIT_RETRY_BASE_MS * 2 ** Math.max(0, consecutiveFailures - 1),
    PROGRESS_EDIT_RETRY_MAX_MS,
  )
  // ±25% jitter (0.75x–1.25x).
  return Math.round(backoff * (0.75 + random() * 0.5))
}

// Hermes-style work log: the phase line stays the headline, and the most
// recent tool executions render as `· <tool>` lines under it so the chat can
// watch the work happen. Tool NAMES only — args and results stay behind the
// boundary (see progressTextForEvent below).
export const CHANNEL_PROGRESS_LOG_MAX_ENTRIES = 4

export function toolNameForEvent(event: unknown): string | null {
  if (!isRecord(event)) return null
  if (event.type !== 'tool_execution_start') return null
  return typeof event.toolName === 'string' && event.toolName.length > 0 ? event.toolName : null
}

export function renderProgressText(phase: string, toolLog: readonly string[]): string {
  if (toolLog.length === 0) return phase
  return [phase, ...toolLog.slice(-CHANNEL_PROGRESS_LOG_MAX_ENTRIES).map((name) => `· ${name}`)].join('\n')
}

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
