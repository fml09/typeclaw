import { Long } from 'bson'

export const KAKAO_REACTION_ACTION_METHOD = 'ACTION'
export const KAKAO_REWRITE_MESSAGE_METHOD = 'REWRITE'
export const KAKAO_LIKE_REACTION_TYPE = 1

export type KakaoLocoPacket = {
  statusCode: number
  body: Record<string, unknown>
}

export type KakaoLocoConnection = {
  sendPacket: (method: string, body: Record<string, unknown>) => Promise<KakaoLocoPacket>
}

export type KakaoLocoSession = {
  getConnection: () => KakaoLocoConnection | null
}

export type KakaoLocoClient = {
  acquireSession?: () => Promise<KakaoLocoSession>
}

export function buildKakaoReactionBody(chatId: string, logId: string, reactionType: number): Record<string, unknown> {
  return {
    chatId: parseKakaoId(chatId, 'chatId'),
    logId: parseKakaoId(logId, 'logId'),
    type: reactionType,
  }
}

export function buildKakaoRewriteBody(chatId: string, logId: string, text: string): Record<string, unknown> {
  return {
    chatId: parseKakaoId(chatId, 'chatId'),
    logId: parseKakaoId(logId, 'logId'),
    msg: text,
    type: 1,
  }
}

export async function sendKakaoReaction(
  client: KakaoLocoClient,
  chatId: string,
  logId: string,
  reactionType = KAKAO_LIKE_REACTION_TYPE,
): Promise<KakaoLocoPacket> {
  const connection = await acquireKakaoConnection(client)
  return await connection.sendPacket(KAKAO_REACTION_ACTION_METHOD, buildKakaoReactionBody(chatId, logId, reactionType))
}

export async function rewriteKakaoMessage(
  client: KakaoLocoClient,
  chatId: string,
  logId: string,
  text: string,
): Promise<KakaoLocoPacket> {
  const connection = await acquireKakaoConnection(client)
  return await connection.sendPacket(KAKAO_REWRITE_MESSAGE_METHOD, buildKakaoRewriteBody(chatId, logId, text))
}

export function kakaoMutationStatusCode(packet: KakaoLocoPacket): number {
  const bodyStatus = packet.body.status
  return typeof bodyStatus === 'number' && bodyStatus !== 0 ? bodyStatus : packet.statusCode
}

async function acquireKakaoConnection(client: KakaoLocoClient): Promise<KakaoLocoConnection> {
  if (client.acquireSession === undefined) {
    throw new Error('installed agent-messenger SDK does not expose the KakaoTalk LOCO session')
  }
  const session = await client.acquireSession()
  const connection = session.getConnection()
  if (connection === null) throw new Error('KakaoTalk LOCO session is not connected')
  return connection
}

function parseKakaoId(value: string, name: string): Long {
  if (!/^\d+$/.test(value)) throw new Error(`KakaoTalk ${name} must be a decimal integer`)
  const parsed = Long.fromString(value)
  if (parsed.isZero()) throw new Error(`KakaoTalk ${name} must be greater than zero`)
  return parsed
}
