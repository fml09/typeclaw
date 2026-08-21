import type { DiscordGatewayInteractionEvent } from 'agent-messenger/discordbot'

import type { ChannelKey } from '@/channels/types'

import { describeError } from '../describe-error'
import { discordThreadRoom } from './discord-bot-thread-room'
import { isDiscordSnowflake } from './discord-id'

const DISCORD_API_BASE = 'https://discord.com/api/v10'

// CHAT_INPUT is the only Discord application-command type that maps to the
// existing text-prefix command registry. USER (2) and MESSAGE (3) are
// right-click context-menu surfaces with no /name args equivalent — we don't
// register them and we drop their interactions.
const APPLICATION_COMMAND_TYPE_CHAT_INPUT = 1

// type 4 = CHANNEL_MESSAGE_WITH_SOURCE; flag 64 = EPHEMERAL (only the invoker
// sees it). Ephemeral keeps /stop replies out of the channel transcript.
// Discord drops the interaction with "This interaction failed" if we don't
// ack within ~3 seconds.
const INTERACTION_CALLBACK_TYPE_CHANNEL_MESSAGE_WITH_SOURCE = 4
const INTERACTION_MESSAGE_FLAG_EPHEMERAL = 64
export const DISCORD_INTERACTION_ACK_BUDGET_MS = 3000

export type DiscordCommandDeclaration = {
  name: string
  description: string
}

export type RegisterCommandsArgs = {
  token: string
  applicationId: string
  commands: readonly DiscordCommandDeclaration[]
  fetchImpl?: typeof fetch
}

export type RegisterCommandsResult = { ok: true } | { ok: false; error: string }

// Bulk-overwrite is idempotent — Discord replaces the entire registered set
// with whatever the body declares, so re-running `typeclaw start` with the
// same commands is a no-op server-side. Global (vs. per-guild) registration
// avoids the bot-needs-to-know-its-guilds bootstrap, at the cost of
// Discord's documented up-to-1-hour propagation for new commands. Text-
// prefix /stop continues to work the entire time, so the propagation
// window doesn't regress existing behavior.
//
// CAUTION: this PUT replaces ALL global commands on the application with the
// declared list. Sharing the bot application with another integration that
// also registers global commands would delete those commands. Don't share
// the application; TypeClaw owns the application's command set.
export async function registerCommands(args: RegisterCommandsArgs): Promise<RegisterCommandsResult> {
  const fetchImpl = args.fetchImpl ?? fetch
  const body = args.commands.map((cmd) => ({
    name: cmd.name,
    description: cmd.description,
    type: APPLICATION_COMMAND_TYPE_CHAT_INPUT,
  }))
  try {
    const res = await fetchImpl(`${DISCORD_API_BASE}/applications/${encodeURIComponent(args.applicationId)}/commands`, {
      method: 'PUT',
      headers: { Authorization: `Bot ${args.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return { ok: false, error: `http ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}` }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: describeError(err) }
  }
}

export type ParsedSlashCommand = {
  name: string
  key: ChannelKey
  parentChat?: string
  invokerId: string
  interactionId: string
  interactionToken: string
}

export type ParseInteractionResult =
  | { kind: 'parsed'; command: ParsedSlashCommand }
  | { kind: 'ignore'; reason: 'not-application-command' | 'unknown-command' | 'no-invoker' | 'no-channel' }

export function parseInteractionAsCommand(
  event: DiscordGatewayInteractionEvent,
  knownCommands: ReadonlySet<string>,
): ParseInteractionResult {
  const data = event.data as { name?: string; type?: number } | undefined
  if (!data || data.type !== APPLICATION_COMMAND_TYPE_CHAT_INPUT) {
    return { kind: 'ignore', reason: 'not-application-command' }
  }
  const name = typeof data.name === 'string' ? data.name.toLowerCase() : ''
  if (name === '' || !knownCommands.has(name)) {
    return { kind: 'ignore', reason: 'unknown-command' }
  }
  // Guild interactions carry the invoker in member.user.id; DM interactions
  // carry it in user.id. Exactly one is present.
  const member = event.member as { user?: { id?: string } } | undefined
  const invokerId = member?.user?.id ?? event.user?.id ?? ''
  if (invokerId === '') {
    return { kind: 'ignore', reason: 'no-invoker' }
  }
  if (typeof event.channel_id !== 'string' || event.channel_id === '') {
    return { kind: 'ignore', reason: 'no-channel' }
  }
  // Mirror discord-bot-classify: DM workspace is '@dm', threads are stored
  // as their channel id in `chat` with `thread: null` (Discord treats threads
  // as channels; interaction.channel_id is the thread id when the user
  // invoked from a thread).
  const workspace = typeof event.guild_id === 'string' && event.guild_id !== '' ? event.guild_id : '@dm'
  const parentChat = interactionParentChat(event)
  return {
    kind: 'parsed',
    command: {
      name,
      key: { adapter: 'discord-bot', workspace, chat: event.channel_id, thread: null },
      ...(parentChat !== undefined ? { parentChat } : {}),
      invokerId,
      interactionId: event.id,
      interactionToken: event.token,
    },
  }
}

type RawDiscordInteractionEvent = DiscordGatewayInteractionEvent & {
  channel?: { id?: string; type?: number; parent_id?: string | null }
}

function interactionParentChat(event: DiscordGatewayInteractionEvent): string | undefined {
  const channel = (event as RawDiscordInteractionEvent).channel
  if (
    channel === undefined ||
    !isDiscordSnowflake(event.guild_id ?? '') ||
    !isDiscordSnowflake(event.channel_id ?? '') ||
    channel.id !== event.channel_id
  )
    return undefined
  const parentChat = discordThreadRoom(channel)?.parentChat
  return parentChat !== undefined && isDiscordSnowflake(parentChat) ? parentChat : undefined
}

// Content is required even when there's nothing to stop, because Discord
// rejects empty CHANNEL_MESSAGE_WITH_SOURCE responses.
export function buildInteractionAck(content: string): {
  type: number
  data: { content: string; flags: number }
} {
  return {
    type: INTERACTION_CALLBACK_TYPE_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content, flags: INTERACTION_MESSAGE_FLAG_EPHEMERAL },
  }
}

export type AckInteractionArgs = {
  interactionId: string
  interactionToken: string
  content: string
  fetchImpl?: typeof fetch
}

export type AckInteractionResult = { ok: true } | { ok: false; error: string }

// Interaction acks must NOT carry the bot token — the interaction token in
// the URL is the only credential Discord expects on this endpoint, and
// adding Authorization sometimes triggers a 401.
//
// Errors are scrubbed before being returned: a thrown network error from
// fetch may include the full request URL (including the interaction token,
// which is a short-lived credential) in its message string depending on
// the runtime. We surface only the error class to avoid leaking the token
// into logs.
export async function ackInteraction(args: AckInteractionArgs): Promise<AckInteractionResult> {
  const fetchImpl = args.fetchImpl ?? fetch
  const body = buildInteractionAck(args.content)
  try {
    const res = await fetchImpl(
      `${DISCORD_API_BASE}/interactions/${encodeURIComponent(args.interactionId)}/${encodeURIComponent(args.interactionToken)}/callback`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    )
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return { ok: false, error: `http ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}` }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: `network error: ${sanitizeErrorName(err)}` }
  }
}

// Returns the error class name without the message, so callers can log the
// failure mode without leaking URLs/tokens that some runtimes embed in
// error.message (e.g. Node's "fetch failed: TypeError: fetch failed,
// cause: Error: ... https://discord.com/api/v10/interactions/123/<token>/callback").
function sanitizeErrorName(err: unknown): string {
  if (err instanceof Error) return err.name
  return typeof err === 'string' ? 'string error' : 'unknown error'
}

export function synthesizeCommandText(name: string): string {
  return `/${name}`
}

export const DISCORD_SLASH_COMMAND_TYPE_CHAT_INPUT = APPLICATION_COMMAND_TYPE_CHAT_INPUT
