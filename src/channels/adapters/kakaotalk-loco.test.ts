import { describe, expect, test } from 'bun:test'

import { Long } from 'bson'

import {
  buildKakaoReactionBody,
  buildKakaoRewriteBody,
  KAKAO_LIKE_REACTION_TYPE,
  KAKAO_REACTION_ACTION_METHOD,
  KAKAO_REWRITE_MESSAGE_METHOD,
  kakaoMutationStatusCode,
  rewriteKakaoMessage,
  sendKakaoReaction,
  type KakaoLocoClient,
  type KakaoLocoPacket,
} from './kakaotalk-loco'

type SentPacket = { method: string; body: Record<string, unknown> }

function fakeClient(response: KakaoLocoPacket = { statusCode: 0, body: {} }): {
  client: KakaoLocoClient
  sent: SentPacket[]
} {
  const sent: SentPacket[] = []
  return {
    client: {
      acquireSession: async () => ({
        getConnection: () => ({
          sendPacket: async (method, body) => {
            sent.push({ method, body })
            return response
          },
        }),
      }),
    },
    sent,
  }
}

describe('KakaoTalk local LOCO mutation bodies', () => {
  test('encodes full-width chat and log IDs as BSON Long values', () => {
    const body = buildKakaoReactionBody('459750513901477', '922337203685477000', KAKAO_LIKE_REACTION_TYPE)

    expect((body.chatId as Long).toString()).toBe('459750513901477')
    expect((body.logId as Long).toString()).toBe('922337203685477000')
    expect(body.type).toBe(1)
    expect(Object.keys(body).sort()).toEqual(['chatId', 'logId', 'type'])
  })

  test('builds the REWRITE text payload', () => {
    const body = buildKakaoRewriteBody('123', '456', 'edited')

    expect((body.chatId as Long).toString()).toBe('123')
    expect((body.logId as Long).toString()).toBe('456')
    expect(body).toMatchObject({ msg: 'edited', type: 1 })
  })

  test('rejects malformed or zero IDs before a packet can be sent', () => {
    expect(() => buildKakaoReactionBody('not-a-number', '2', 1)).toThrow('chatId must be a decimal integer')
    expect(() => buildKakaoRewriteBody('1', '0', 'edited')).toThrow('logId must be greater than zero')
  })
})

describe('KakaoTalk local LOCO mutation transport', () => {
  test('sends ACTION with the verified like reaction type', async () => {
    const { client, sent } = fakeClient()

    const packet = await sendKakaoReaction(client, '123', '456')

    expect(packet.statusCode).toBe(0)
    expect(sent).toEqual([
      {
        method: KAKAO_REACTION_ACTION_METHOD,
        body: { chatId: Long.fromString('123'), logId: Long.fromString('456'), type: 1 },
      },
    ])
  })

  test('sends REWRITE with the replacement text', async () => {
    const { client, sent } = fakeClient()

    await rewriteKakaoMessage(client, '123', '456', 'edited')

    expect(sent).toEqual([
      {
        method: KAKAO_REWRITE_MESSAGE_METHOD,
        body: { chatId: Long.fromString('123'), logId: Long.fromString('456'), msg: 'edited', type: 1 },
      },
    ])
  })

  test('prefers a non-zero body status over the packet status', () => {
    expect(kakaoMutationStatusCode({ statusCode: 0, body: { status: -203 } })).toBe(-203)
    expect(kakaoMutationStatusCode({ statusCode: -1, body: { status: 0 } })).toBe(-1)
  })

  test('fails clearly when the installed client does not expose a LOCO session', async () => {
    await expect(sendKakaoReaction({}, '123', '456')).rejects.toThrow(
      'installed agent-messenger SDK does not expose the KakaoTalk LOCO session',
    )
  })
})
