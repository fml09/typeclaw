import { describe, expect, test } from 'bun:test'

import type { DiscordGatewayInteractionEvent } from 'agent-messenger/discordbot'

import {
  ackInteraction,
  buildInteractionAck,
  DISCORD_SLASH_COMMAND_TYPE_CHAT_INPUT,
  parseInteractionAsCommand,
  registerCommands,
  synthesizeCommandText,
} from './discord-bot-slash-commands'

function makeInteraction(overrides: Partial<DiscordGatewayInteractionEvent> = {}): DiscordGatewayInteractionEvent {
  return {
    type: 'INTERACTION_CREATE',
    id: 'i-1',
    application_id: 'app-1',
    token: 'tok-abc',
    channel_id: 'c1',
    guild_id: 'g1',
    member: { user: { id: 'u-alice' } },
    data: { name: 'stop', type: DISCORD_SLASH_COMMAND_TYPE_CHAT_INPUT },
    ...overrides,
  }
}

describe('parseInteractionAsCommand', () => {
  const known = new Set(['stop'])

  test('parses a guild CHAT_INPUT /stop into a discord-bot ChannelKey', () => {
    const result = parseInteractionAsCommand(makeInteraction(), known)
    expect(result.kind).toBe('parsed')
    if (result.kind !== 'parsed') return
    expect(result.command).toEqual({
      name: 'stop',
      key: { adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: null },
      invokerId: 'u-alice',
      interactionId: 'i-1',
      interactionToken: 'tok-abc',
    })
  })

  test('carries a canonical thread parent from the interaction channel object', () => {
    const event = makeInteraction({
      channel_id: '100000000000000001',
      guild_id: '100000000000000002',
    }) as DiscordGatewayInteractionEvent & {
      channel: { id: string; type: number; parent_id: string }
    }
    event.channel = {
      id: '100000000000000001',
      type: 11,
      parent_id: '100000000000000003',
    }

    const result = parseInteractionAsCommand(event, known)

    expect(result.kind).toBe('parsed')
    if (result.kind !== 'parsed') return
    expect(result.command.parentChat).toBe('100000000000000003')
  })

  test('does not trust malformed or non-thread interaction parent metadata', () => {
    const event = makeInteraction() as DiscordGatewayInteractionEvent & {
      channel: { type: number; parent_id: string }
    }
    event.channel = { type: 0, parent_id: '100000000000000003' }
    expect(parseInteractionAsCommand(event, known)).not.toHaveProperty('command.parentChat')

    event.channel = { type: 11, parent_id: 'not-a-snowflake' }
    expect(parseInteractionAsCommand(event, known)).not.toHaveProperty('command.parentChat')
  })

  test('does not trust thread metadata for another channel or without a guild', () => {
    const event = makeInteraction({
      channel_id: '100000000000000001',
      guild_id: '100000000000000002',
    }) as DiscordGatewayInteractionEvent & {
      channel: { id: string; type: number; parent_id: string }
    }
    event.channel = {
      id: '100000000000000009',
      type: 11,
      parent_id: '100000000000000003',
    }
    expect(parseInteractionAsCommand(event, known)).not.toHaveProperty('command.parentChat')

    event.guild_id = undefined
    event.channel.id = '100000000000000001'
    expect(parseInteractionAsCommand(event, known)).not.toHaveProperty('command.parentChat')
  })

  test('DM interaction (no guild_id) maps workspace to @dm and reads user.id', () => {
    const result = parseInteractionAsCommand(
      makeInteraction({ guild_id: undefined, member: undefined, user: { id: 'u-bob', username: 'bob' } }),
      known,
    )
    expect(result.kind).toBe('parsed')
    if (result.kind !== 'parsed') return
    expect(result.command.key.workspace).toBe('@dm')
    expect(result.command.invokerId).toBe('u-bob')
  })

  test('lowercases the command name (Discord normalizes server-side but be defensive)', () => {
    const result = parseInteractionAsCommand(
      makeInteraction({ data: { name: 'STOP', type: DISCORD_SLASH_COMMAND_TYPE_CHAT_INPUT } }),
      known,
    )
    expect(result.kind).toBe('parsed')
    if (result.kind !== 'parsed') return
    expect(result.command.name).toBe('stop')
  })

  test('ignores non-CHAT_INPUT interactions (USER/MESSAGE context menus)', () => {
    const result = parseInteractionAsCommand(makeInteraction({ data: { name: 'stop', type: 2 } }), known)
    expect(result).toEqual({ kind: 'ignore', reason: 'not-application-command' })
  })

  test('ignores interactions whose name we never registered', () => {
    const result = parseInteractionAsCommand(
      makeInteraction({ data: { name: 'unknown', type: DISCORD_SLASH_COMMAND_TYPE_CHAT_INPUT } }),
      known,
    )
    expect(result).toEqual({ kind: 'ignore', reason: 'unknown-command' })
  })

  test('ignores interactions with no resolvable invoker (defensive — Discord guarantees one)', () => {
    const result = parseInteractionAsCommand(makeInteraction({ member: undefined, user: undefined }), known)
    expect(result).toEqual({ kind: 'ignore', reason: 'no-invoker' })
  })

  test('ignores interactions with no channel_id (defensive — should not happen)', () => {
    const result = parseInteractionAsCommand(makeInteraction({ channel_id: undefined }), known)
    expect(result).toEqual({ kind: 'ignore', reason: 'no-channel' })
  })

  test('drops button/modal/autocomplete (data missing the application-command shape)', () => {
    const result = parseInteractionAsCommand(makeInteraction({ data: undefined }), known)
    expect(result).toEqual({ kind: 'ignore', reason: 'not-application-command' })
  })
})

describe('buildInteractionAck', () => {
  test('always emits ephemeral CHANNEL_MESSAGE_WITH_SOURCE', () => {
    expect(buildInteractionAck('Stopped.')).toEqual({
      type: 4,
      data: { content: 'Stopped.', flags: 64 },
    })
  })
})

describe('registerCommands', () => {
  test('PUTs the full set to /applications/{id}/commands with type=CHAT_INPUT', async () => {
    let captured: { url: string; init: RequestInit } | null = null
    const fetchImpl = (async (url: string, init: RequestInit) => {
      captured = { url, init }
      return new Response('', { status: 200 })
    }) as unknown as typeof fetch

    const result = await registerCommands({
      token: 'BOT_TOKEN',
      applicationId: 'app-42',
      commands: [{ name: 'stop', description: 'Abort the current turn' }],
      fetchImpl,
    })

    expect(result).toEqual({ ok: true })
    expect(captured).not.toBeNull()
    expect(captured!.url).toBe('https://discord.com/api/v10/applications/app-42/commands')
    expect(captured!.init.method).toBe('PUT')
    expect((captured!.init.headers as Record<string, string>)['Authorization']).toBe('Bot BOT_TOKEN')
    expect(JSON.parse(captured!.init.body as string)).toEqual([
      { name: 'stop', description: 'Abort the current turn', type: 1 },
    ])
  })

  test('returns ok:false on non-2xx with the status and a truncated body', async () => {
    const fetchImpl = (async () =>
      new Response('{"message":"Missing Access","code":50001}', { status: 403 })) as unknown as typeof fetch

    const result = await registerCommands({
      token: 'BOT_TOKEN',
      applicationId: 'app-42',
      commands: [{ name: 'stop', description: 'x' }],
      fetchImpl,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('http 403')
    expect(result.error).toContain('Missing Access')
  })

  test('returns ok:false on network error', async () => {
    const fetchImpl = (async () => {
      throw new Error('econnreset')
    }) as unknown as typeof fetch
    const result = await registerCommands({
      token: 'BOT_TOKEN',
      applicationId: 'app-42',
      commands: [{ name: 'stop', description: 'x' }],
      fetchImpl,
    })
    expect(result).toEqual({ ok: false, error: 'econnreset' })
  })
})

describe('ackInteraction', () => {
  test('POSTs to /interactions/{id}/{token}/callback without Authorization', async () => {
    let captured: { url: string; init: RequestInit } | null = null
    const fetchImpl = (async (url: string, init: RequestInit) => {
      captured = { url, init }
      return new Response('', { status: 204 })
    }) as unknown as typeof fetch

    const result = await ackInteraction({
      interactionId: 'i-7',
      interactionToken: 'tok-xyz',
      content: 'Stopped.',
      fetchImpl,
    })
    expect(result).toEqual({ ok: true })
    expect(captured).not.toBeNull()
    expect(captured!.url).toBe('https://discord.com/api/v10/interactions/i-7/tok-xyz/callback')
    const headers = (captured!.init.headers as Record<string, string>) ?? {}
    expect(headers['Authorization']).toBeUndefined()
    expect(headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(captured!.init.body as string)).toEqual({
      type: 4,
      data: { content: 'Stopped.', flags: 64 },
    })
  })

  test('returns ok:false on non-2xx', async () => {
    const fetchImpl = (async () =>
      new Response('{"message":"Unknown interaction","code":10062}', { status: 404 })) as unknown as typeof fetch

    const result = await ackInteraction({
      interactionId: 'i-7',
      interactionToken: 'expired',
      content: 'Stopped.',
      fetchImpl,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('http 404')
    expect(result.error).toContain('Unknown interaction')
  })

  test('encodes URL components so an exotic interaction token cannot escape the path', async () => {
    let capturedUrl = ''
    const fetchImpl = (async (url: string) => {
      capturedUrl = url
      return new Response('', { status: 204 })
    }) as unknown as typeof fetch

    await ackInteraction({
      interactionId: 'i-7',
      interactionToken: 'tok/with?special&chars',
      content: 'Stopped.',
      fetchImpl,
    })
    expect(capturedUrl).toContain('tok%2Fwith%3Fspecial%26chars')
    expect(capturedUrl).not.toContain('tok/with?')
  })

  test('sanitizes network-error messages so the interaction token never appears in the result', async () => {
    const fetchImpl = (async () => {
      throw new Error(
        'fetch failed: connect ECONNREFUSED https://discord.com/api/v10/interactions/i-7/tok-secret/callback',
      )
    }) as unknown as typeof fetch

    const result = await ackInteraction({
      interactionId: 'i-7',
      interactionToken: 'tok-secret',
      content: 'Stopped.',
      fetchImpl,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).not.toContain('tok-secret')
    expect(result.error).not.toContain('discord.com')
    expect(result.error).toContain('network error')
  })
})

describe('synthesizeCommandText', () => {
  test('prepends a single slash so router.executeCommand-by-name and router.route("/name") match', () => {
    expect(synthesizeCommandText('stop')).toBe('/stop')
  })
})
