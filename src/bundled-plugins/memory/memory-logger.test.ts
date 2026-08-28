import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { RunSession, SubagentContext } from '@/plugin'
import { formatLocalDate } from '@/shared'

import { advanceWatermarkTool, appendTool } from './append-tool'
import { findEntryTool } from './find-entry-tool'
import {
  createMemoryLoggerSubagent,
  isMemoryLoggerPayload,
  MEMORY_LOGGER_SYSTEM_PROMPT,
  type MemoryLoggerLogger,
  memoryLoggerSubagent,
  type MemoryLoggerPayload,
} from './memory-logger'
import { streamFilePath } from './paths'
import { parseReference } from './references/frontmatter'
import { storeReferenceTool } from './references/store-reference-tool'
import { readEvents } from './stream-io'

const silentLogger: MemoryLoggerLogger = { info: () => {}, warn: () => {}, error: () => {} }
const silentSubagent = createMemoryLoggerSubagent({ logger: silentLogger })

function fragment(source: string, entry: string, id = `f-${entry}`): string {
  return `${JSON.stringify({ type: 'fragment', id, ts: '2026-05-16T12:00:00.000Z', source, entry, topic: 'T', body: 'B' })}\n`
}

function watermark(source: string, entry: string, id = `w-${entry}`): string {
  return `${JSON.stringify({ type: 'watermark', id, ts: '2026-05-16T12:00:00.000Z', source, entry })}\n`
}

function makeAgentDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'memory-agent-'))
  mkdirSync(join(root, 'memory'))
  mkdirSync(join(root, 'memory', 'streams'))
  mkdirSync(join(root, 'sessions'))
  return root
}

async function invokeWith(
  payload: MemoryLoggerPayload,
  agentDir: string,
): Promise<{ runSessionCalls: { userPrompt: string | undefined }[] }> {
  const calls: { userPrompt: string | undefined }[] = []
  const runSession: RunSession = async (override) => {
    calls.push({ userPrompt: override?.userPrompt })
  }
  const ctx: SubagentContext<MemoryLoggerPayload> = {
    userPrompt: '',
    agentDir,
    payload,
  }
  await silentSubagent.handler!(ctx, runSession)
  return { runSessionCalls: calls }
}

describe('isMemoryLoggerPayload', () => {
  test('accepts a valid payload', () => {
    expect(
      isMemoryLoggerPayload({
        parentSessionId: 'ses_abc',
        parentTranscriptPath: '/path/to/file.jsonl',
        agentDir: '/path/to/agent',
      }),
    ).toBe(true)
  })

  test('accepts a payload with channel origin context', () => {
    expect(
      isMemoryLoggerPayload({
        parentSessionId: 'ses_abc',
        parentTranscriptPath: '/path/to/file.jsonl',
        agentDir: '/path/to/agent',
        origin: {
          kind: 'channel',
          adapter: 'slack-bot',
          workspace: 'T123',
          workspaceName: 'Acme',
          chat: 'C456',
          chatName: 'infra',
          thread: '171234.0001',
          lastInboundAuthorId: 'U1',
          participants: [
            {
              authorId: 'U1',
              authorName: 'Neo',
              firstMessageAt: 1000,
              lastMessageAt: 2000,
              messageCount: 2,
            },
          ],
        },
      }),
    ).toBe(true)
  })

  test('rejects when fields are missing', () => {
    expect(isMemoryLoggerPayload({})).toBe(false)
    expect(isMemoryLoggerPayload({ parentSessionId: '', parentTranscriptPath: 'b', agentDir: 'c' })).toBe(false)
  })
})

describe('MEMORY_LOGGER_SYSTEM_PROMPT', () => {
  test('declares the append tool fragment input schema', () => {
    expect(MEMORY_LOGGER_SYSTEM_PROMPT).toContain('{topic, body, source, entry, latestEntryId}')
    expect(MEMORY_LOGGER_SYSTEM_PROMPT).toContain('you never write raw JSON')
  })

  test('requires every fragment to be evidence-anchored and self-contained', () => {
    const lower = MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toContain('self-contained')
    expect(lower).toMatch(/anchored to evidence|anchor.*evidence|evidence.*anchor/)
  })

  test('frames both over-writing and under-writing as failure modes', () => {
    expect(MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()).toContain('over-writing')
    expect(MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()).toContain('under-writing')
  })

  test('declares a "when in doubt, SKIP" capture philosophy biased toward low fragment counts', () => {
    const lower = MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toContain('when in doubt, skip')
    expect(lower).toMatch(/zero or one fragment|recurrence|skipping costs nothing/)
  })

  test('lists chat-mechanical anti-patterns explicitly so the subagent stops recording them', () => {
    const lower = MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toContain('conversational mechanics')
    expect(lower).toContain('group-chat membership events')
    expect(lower).toMatch(/single-occurrence|one event produces at most one fragment/)
  })

  test('captures a user correction even when memory may already know it, in any language', () => {
    expect(MEMORY_LOGGER_SYSTEM_PROMPT).toContain('EVEN IF it sounds like something memory may already know')
    expect(MEMORY_LOGGER_SYSTEM_PROMPT).toContain('cannot inspect `memory/topics/`')
    // multi-language, not English cue phrases (per AGENTS.md)
    const lower = MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toContain('language-independent')
    expect(lower).toMatch(/korean|japanese|chinese|arabic/)
  })

  test('declares durable facts about non-user people as a capture-worthy category', () => {
    const lower = MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toContain('collaborator/contact facts')
    expect(lower).toContain('active-participant status')
    expect(lower).toMatch(/role|responsibility/)
    expect(lower).toMatch(/working preference|communication preference|coordination/)
    expect(lower).toMatch(/routing|coordinate|address|interpret/)
  })

  test('encourages compact identity capture for active participants even without a stated role', () => {
    const lower = MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toMatch(/actively participates.*recurring presence.*multiple messages.*back-and-forth/s)
    expect(lower).toMatch(
      /capture one compact identity fragment.*even if they did not state a durable role or preference/s,
    )
    expect(lower).toContain('a stated role/preference strengthens the fragment but is no longer required')
    expect(lower).not.toContain('this is not a contact database')
  })

  test('keeps a person introduction to one compact fragment instead of one-per-attribute', () => {
    expect(MEMORY_LOGGER_SYSTEM_PROMPT).toMatch(/one compact fragment/i)
    expect(MEMORY_LOGGER_SYSTEM_PROMPT).toMatch(/do not split .*"new participant".*"reaction"/is)
  })

  test('guards people capture against group-chat poisoning by requiring user/owner or self-described sourcing', () => {
    const lower = MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toMatch(/third-party facts must come from the user\/owner|describing their own role/)
    expect(lower).toMatch(/reputational claims about another|one participant's reputational claims/)
  })

  test('qualifies social-graph trivia so operationally-relevant people facts are no longer blanket-skipped', () => {
    const lower = MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toContain('who knows whom')
    expect(lower).toMatch(/capture a person fact when it records an active participant's compact identity/)
    expect(lower).toMatch(/or when it changes how the agent should later route to/)
  })

  test('demonstrates active-participant identity capture in a non-English (Korean) example', () => {
    expect(MEMORY_LOGGER_SYSTEM_PROMPT).toContain('민준이 이 대화에서 여러 번 답하고 배포 메모 확인을 요청했다')
    expect(MEMORY_LOGGER_SYSTEM_PROMPT).toMatch(/in any language/i)
  })

  test('keeps the anti-personality guard while allowing active-participant identity', () => {
    const lower = MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toContain('personality observations')
    expect(lower).toContain('vibes')
    expect(lower).toContain('impressions of people')
    expect(lower).toMatch(/not as a character sketch or one-off impression/)
  })

  test('declares durable channel/environment facts as a capture-worthy situation-memory category', () => {
    const lower = MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toContain('stable channel/environment facts')
    expect(lower).toMatch(/purpose|role in the team/)
    expect(lower).toMatch(/routing convention|urgency expectation|communication norm/)
    expect(lower).toMatch(/interpretation|routing|response style|prioritization/)
  })

  test('excludes live re-derivable channel context from the channel/environment category', () => {
    const lower = MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toContain('exclude live re-derivable context')
    expect(lower).toMatch(/adapter\/workspace\/chat\/thread/)
    expect(lower).toMatch(/participant list/)
    expect(lower).toMatch(/membership churn/)
  })

  test('keeps a channel-environment capture to one compact fragment instead of one-per-attribute', () => {
    expect(MEMORY_LOGGER_SYSTEM_PROMPT).toMatch(/one environment convention.*one compact fragment/is)
    expect(MEMORY_LOGGER_SYSTEM_PROMPT).toMatch(/do not split channel name, purpose, urgency, and routing/i)
  })

  test('guards channel conventions against becoming standing orders (context, not authorization)', () => {
    const lower = MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toMatch(/channel convention is context only, not authorization/)
    expect(lower).toMatch(/standing order/)
    expect(lower).toMatch(/bypass permissions|override explicit user\/project\/system guards/)
  })

  test('demonstrates channel/environment capture in a non-English (Korean) example', () => {
    expect(MEMORY_LOGGER_SYSTEM_PROMPT).toContain('#배포-공지')
    expect(MEMORY_LOGGER_SYSTEM_PROMPT).toMatch(/people and channel\/environment facts alike, in any language/i)
    expect(MEMORY_LOGGER_SYSTEM_PROMPT).toMatch(/Mina joined #incidents|Slack thread 172/)
  })

  test('qualifies the membership-events anti-pattern so durable channel purpose is no longer blanket-skipped', () => {
    const lower = MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toContain('group-chat membership events')
    expect(lower).toMatch(/invitations, joins, leaves/)
    expect(lower).toMatch(/durable, evidenced channel purpose\/convention/)
  })

  test('qualifies the re-derivable-facts anti-pattern to distinguish live context from a learned environment belief', () => {
    const lower = MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toMatch(/live channel context/)
    expect(lower).toMatch(/not re-derivable merely because the current turn names the channel/)
  })

  test('does not require fragments to articulate a future behavior change', () => {
    expect(MEMORY_LOGGER_SYSTEM_PROMPT).toMatch(
      /does(n't| not) need to articulate.*future agent|no.*Implication.*not required|implication is obvious/i,
    )
  })

  test('forbids turning memories into proactive duties', () => {
    const lower = MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toContain('memory is context, not authorization')
    expect(lower).toContain('must not create self-executing jobs')
    expect(lower).toContain('never use it to authorize action without a current user request')
  })

  test('names dreaming as the consolidation/filter step that runs after capture', () => {
    expect(MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()).toContain('dreaming')
  })

  test('teaches the subagent to respect the optional Stream line cursor when present', () => {
    expect(MEMORY_LOGGER_SYSTEM_PROMPT).toMatch(/Stream line cursor:/)
    expect(MEMORY_LOGGER_SYSTEM_PROMPT).toMatch(/offset=N\+1/i)
  })

  test("does not direct the subagent to read memory/topics/ — cross-shard reasoning is dreaming's concern", () => {
    // Positive prohibition is present.
    expect(MEMORY_LOGGER_SYSTEM_PROMPT).toMatch(/you do not read `memory\/topics\/`|do not read memory\/topics\//i)
    // No imperative instructing the subagent TO read topics (matches "Read memory/topics/" or
    // "read memory/topics/ and ..." style instructions, regardless of leading capitalization).
    expect(MEMORY_LOGGER_SYSTEM_PROMPT).not.toMatch(/(?:^|[^a-z])Read `?memory\/topics\/`?/m)
    expect(MEMORY_LOGGER_SYSTEM_PROMPT).not.toMatch(/read `?memory\/topics\/`? (?:and|first|to)/i)
  })

  test('declares a watermark contract that handles the zero-fragment case', () => {
    expect(MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()).toContain('watermark')
  })

  test('declares latestEntryId as the watermark argument instead of a raw marker', () => {
    expect(MEMORY_LOGGER_SYSTEM_PROMPT).toContain('latestEntryId')
    expect(MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()).toContain('you no longer emit a separate watermark marker')
  })

  test('forbids stamping every fragment with the same "latest evaluated" entry id (the momo bug)', () => {
    const lower = MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toMatch(/per-fragment|each fragment.*own entry|do not stamp every fragment/i)
  })

  test('explains that fragment entry= is the evidence anchor, not the latest evaluated entry', () => {
    expect(MEMORY_LOGGER_SYSTEM_PROMPT).toMatch(/anchors.*evidence|specific.*entry that anchors/i)
  })

  test('explains that latestEntryId is the latest evaluated entry, regardless of fragment anchors', () => {
    const lower = MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toMatch(/latest.*entry.*evaluated|regardless.*anchored/i)
  })

  test('documents the zero-fragments watermark-advance path', () => {
    const lower = MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toContain('zero-fragments path')
    expect(lower).toContain('watermark-advance tool')
  })

  test('forbids quoting credential values verbatim and explains why', () => {
    const lower = MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toMatch(/never quote secret values|never quote credential values/i)
    expect(lower).toContain('rotation')
    expect(lower).toContain('force-committed to git')
  })

  test('shows allowed vs forbidden secret-handling examples', () => {
    expect(MEMORY_LOGGER_SYSTEM_PROMPT).toMatch(/Allowed:.*GH_TOKEN/s)
    expect(MEMORY_LOGGER_SYSTEM_PROMPT).toMatch(/Forbidden:.*GH_TOKEN=/s)
  })

  test('warns the subagent that the append tool enforces the secret-handling rule', () => {
    expect(MEMORY_LOGGER_SYSTEM_PROMPT).toMatch(/append.*refuse.*credential|append.*refuse.*recognizable/i)
  })

  test('warns about the append-tool dedup rule (content-equality, not marker-equality)', () => {
    const lower = MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toMatch(/byte-equivalent|content-equality|same daily stream/)
    expect(lower).toMatch(/refuse.*fragment|reject.*fragment/)
  })

  test('teaches the subagent to use find_entry to jump past the watermark instead of scrolling from line 1', () => {
    const lower = MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toContain('find_entry')
    expect(lower).toMatch(/before .*read|use find_entry before|find_entry.*then.*read/)
  })

  test('explains the read tool truncates large files so scrolling from line 1 is expensive', () => {
    expect(MEMORY_LOGGER_SYSTEM_PROMPT).toMatch(/truncat\w+.*(50 ?KB|2000 lines)/i)
  })

  test('forbids re-emitting the input watermark id as the new watermark id', () => {
    const lower = MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toMatch(/never write the same watermark id|advance the watermark|move forward each run/)
  })

  test('defines an explicit stop trigger for when reads are exhausted', () => {
    const lower = MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toMatch(/end of (the )?(file|transcript)|reached the end|no (more|further) (content|lines|entries)/)
    expect(lower).toMatch(/stop reading|do not (call )?`?read`? again|stop calling read/)
  })

  test('forbids re-reading the same offset when a read returns nothing new', () => {
    const lower = MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toMatch(/empty|nothing new|no new (content|lines|entries)|same (chunk|content|slice|offset)/)
    expect(lower).toMatch(/do not re-?read|do not retry|do not repeat the (same )?read|never re-?read/)
  })

  test('ties the hard stop to find_entry totalLines, not to a read-call count', () => {
    const lower = MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toMatch(/`find_entry` gives you `totallines=t` up front, so you always know the last line/)
    expect(lower).toMatch(
      /the hard stop is `totallines`: a long transcript may legitimately need many `read` chunks to reach it/,
    )
    expect(lower).not.toMatch(/more than a handful of (?:reads|times)/)
  })
})

describe('memoryLoggerSubagent', () => {
  test('declares the memory-logger system prompt', () => {
    expect(memoryLoggerSubagent.systemPrompt).toBe(MEMORY_LOGGER_SYSTEM_PROMPT)
  })

  test('declares one built-in tool (read) and four custom tools (find_entry, append, store_reference, watermark advance)', () => {
    expect(memoryLoggerSubagent.tools).toBeDefined()
    expect(memoryLoggerSubagent.tools!.length).toBe(1)
    expect(memoryLoggerSubagent.customTools).toBeDefined()
    expect(memoryLoggerSubagent.customTools!.length).toBe(4)
    const descriptions = memoryLoggerSubagent.customTools!.map((t) => t.description)
    expect(descriptions.some((d) => d.includes('Locate a session-transcript entry'))).toBe(true)
    expect(descriptions.some((d) => d.includes('Append a memory fragment'))).toBe(true)
    expect(descriptions.some((d) => d.includes('Advance the daily-stream watermark'))).toBe(true)
    expect(descriptions.some((d) => d.includes('store_reference'))).toBe(true)
  })
  test('declares transcript and session identifiers as non-file operands', () => {
    expect(findEntryTool.fileOperands).toEqual({ input: ['path'], nonFile: ['entryId'] })
    expect(advanceWatermarkTool.fileOperands).toEqual({ nonFile: ['source', 'latestEntryId'] })
  })

  test('declares a defensive tool-result byte budget on the read tool so a malfunctioning find_entry cannot cause unbounded chunked reads', () => {
    expect(memoryLoggerSubagent.toolResultBudget).toBeDefined()
    expect(memoryLoggerSubagent.toolResultBudget!.maxTotalBytes).toBeGreaterThanOrEqual(64 * 1024)
    expect(memoryLoggerSubagent.toolResultBudget!.maxTotalBytes).toBeLessThanOrEqual(1024 * 1024)
  })

  test('budgets ONLY the read tool so the append / find_entry recovery path stays open after exhaustion', () => {
    expect([...memoryLoggerSubagent.toolResultBudget!.toolNames]).toEqual(['read'])
  })

  test('exhausted-budget message tells the subagent to exit silently when no transcript content was read (never invent a watermark)', () => {
    const msg = memoryLoggerSubagent.toolResultBudget!.exhaustedMessage!(256 * 1024, 256 * 1024)
    expect(msg).toContain('exit immediately')
    expect(msg).toContain('WITHOUT writing a watermark')
    expect(msg).toContain('Do not invent or reuse a watermark id')
  })

  test("runs on the 'fast' profile so it does not share the slow default model a researcher saturates", () => {
    expect(memoryLoggerSubagent.profile).toBe('fast')
  })

  test('declares an inFlightKey that keys on agentDir (so two concurrent sessions for the same agent serialize)', () => {
    expect(memoryLoggerSubagent.inFlightKey).toBeDefined()
    const key = memoryLoggerSubagent.inFlightKey!({
      parentSessionId: 'ses_abc',
      parentTranscriptPath: '/x',
      agentDir: '/agents/momo',
    })
    expect(key).toBe('/agents/momo')
  })

  test('two payloads from different sessions of the same agent produce the same inFlightKey', () => {
    const keyA = memoryLoggerSubagent.inFlightKey!({
      parentSessionId: 'ses_a',
      parentTranscriptPath: '/x',
      agentDir: '/agents/momo',
    })
    const keyB = memoryLoggerSubagent.inFlightKey!({
      parentSessionId: 'ses_b',
      parentTranscriptPath: '/y',
      agentDir: '/agents/momo',
    })
    expect(keyA).toBe(keyB)
  })

  test('two payloads from the same session of different agents produce different inFlightKeys', () => {
    const keyA = memoryLoggerSubagent.inFlightKey!({
      parentSessionId: 'ses_x',
      parentTranscriptPath: '/x',
      agentDir: '/agents/momo',
    })
    const keyB = memoryLoggerSubagent.inFlightKey!({
      parentSessionId: 'ses_x',
      parentTranscriptPath: '/x',
      agentDir: '/agents/dolsoe',
    })
    expect(keyA).not.toBe(keyB)
  })

  test('handler builds an initial prompt mentioning transcript, session id, and stream file', async () => {
    const agentDir = makeAgentDir()
    const transcript = join(agentDir, 'sessions', 'ses_abc.jsonl')
    writeFileSync(transcript, '')

    const { runSessionCalls } = await invokeWith(
      { parentSessionId: 'ses_abc', parentTranscriptPath: transcript, agentDir },
      agentDir,
    )

    expect(runSessionCalls).toHaveLength(1)
    const prompt = runSessionCalls[0]!.userPrompt!
    expect(prompt).toContain(transcript)
    expect(prompt).toContain('ses_abc')
    expect(prompt).toMatch(/memory[/\\]streams[/\\]\d{4}-\d{2}-\d{2}\.jsonl/)
  })

  test('handler includes channel location and participants in the initial prompt', async () => {
    const agentDir = makeAgentDir()
    const transcript = join(agentDir, 'sessions', 'ses_abc.jsonl')
    writeFileSync(transcript, '')

    const { runSessionCalls } = await invokeWith(
      {
        parentSessionId: 'ses_abc',
        parentTranscriptPath: transcript,
        agentDir,
        origin: {
          kind: 'channel',
          adapter: 'slack-bot',
          workspace: 'T123',
          workspaceName: 'Acme',
          chat: 'C456',
          chatName: 'infra',
          thread: '171234.0001',
          lastInboundAuthorId: 'U1',
          participants: [
            {
              authorId: 'U1',
              authorName: 'Neo',
              firstMessageAt: 1000,
              lastMessageAt: 2000,
              messageCount: 2,
            },
          ],
        },
      },
      agentDir,
    )

    const prompt = runSessionCalls[0]!.userPrompt!
    expect(prompt).toContain('Conversation context:')
    expect(prompt).toContain('- Adapter: slack-bot')
    expect(prompt).toContain('- Workspace: Acme (T123)')
    expect(prompt).toContain('- Chat: infra (C456)')
    expect(prompt).toContain('- Thread: 171234.0001')
    expect(prompt).toContain('- Last inbound author: U1')
    expect(prompt).toContain('Neo (U1); messages=2')
  })

  test('handler includes the watermark when one exists in the daily stream', async () => {
    const agentDir = makeAgentDir()
    const transcript = join(agentDir, 'sessions', 'ses_abc.jsonl')
    writeFileSync(transcript, '')
    const today = formatLocalDate()
    writeFileSync(join(agentDir, 'memory', 'streams', `${today}.jsonl`), fragment('ses_abc', 'watermrk'))

    const { runSessionCalls } = await invokeWith(
      { parentSessionId: 'ses_abc', parentTranscriptPath: transcript, agentDir },
      agentDir,
    )

    expect(runSessionCalls[0]!.userPrompt!).toContain('watermrk')
  })

  test("handler picks up YESTERDAY'S watermark when today's stream is missing (midnight-rollover case)", async () => {
    const agentDir = makeAgentDir()
    const transcript = join(agentDir, 'sessions', 'ses_abc.jsonl')
    writeFileSync(transcript, '')
    const today = formatLocalDate()
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const yyyy = yesterday.getFullYear()
    const mm = String(yesterday.getMonth() + 1).padStart(2, '0')
    const dd = String(yesterday.getDate()).padStart(2, '0')
    const yesterdayName = `${yyyy}-${mm}-${dd}.jsonl`
    expect(yesterdayName).not.toBe(`${today}.jsonl`)
    writeFileSync(
      join(agentDir, 'memory', 'streams', yesterdayName),
      [fragment('ses_abc', 'yesterday-morning'), watermark('ses_abc', 'yesterday-evening')].join(''),
    )

    const { runSessionCalls } = await invokeWith(
      { parentSessionId: 'ses_abc', parentTranscriptPath: transcript, agentDir },
      agentDir,
    )

    const prompt = runSessionCalls[0]!.userPrompt!
    expect(prompt).toContain('yesterday-evening')
    expect(prompt).not.toContain('Watermark: none')
  })

  test('handler instructs the subagent to pass latestEntryId or use the watermark-advance tool', async () => {
    const agentDir = makeAgentDir()
    const transcript = join(agentDir, 'sessions', 'ses_abc.jsonl')
    writeFileSync(transcript, '')

    const { runSessionCalls } = await invokeWith(
      { parentSessionId: 'ses_abc', parentTranscriptPath: transcript, agentDir },
      agentDir,
    )

    const prompt = runSessionCalls[0]!.userPrompt!
    expect(prompt).toContain('latestEntryId')
    expect(prompt).toContain('watermark-advance tool')
    expect(prompt).toContain('ses_abc')
  })

  test('handler instructs the subagent that each fragment carries its own evidence-anchor entry id', async () => {
    const agentDir = makeAgentDir()
    const transcript = join(agentDir, 'sessions', 'ses_abc.jsonl')
    writeFileSync(transcript, '')

    const { runSessionCalls } = await invokeWith(
      { parentSessionId: 'ses_abc', parentTranscriptPath: transcript, agentDir },
      agentDir,
    )

    const prompt = runSessionCalls[0]!.userPrompt!
    expect(prompt.toLowerCase()).toMatch(/per-fragment provenance|specific transcript entry that anchors/i)
  })

  test("handler does NOT instruct the subagent to read memory/topics/ — that is dreaming's concern", async () => {
    const agentDir = makeAgentDir()
    const transcript = join(agentDir, 'sessions', 'ses_abc.jsonl')
    writeFileSync(transcript, '')

    const { runSessionCalls } = await invokeWith(
      { parentSessionId: 'ses_abc', parentTranscriptPath: transcript, agentDir },
      agentDir,
    )

    const prompt = runSessionCalls[0]!.userPrompt!
    expect(prompt).not.toContain(join(agentDir, 'memory', 'topics'))
    expect(prompt).not.toMatch(/(?:^|[^a-z])Read `?memory\/topics\/`?/m)
    expect(prompt).not.toMatch(/read `?memory\/topics\/`? (?:and|first|to)/i)
  })

  test('handler emits Stream line cursor line when streamLineCursor is in the payload', async () => {
    const agentDir = makeAgentDir()
    const transcript = join(agentDir, 'sessions', 'ses_abc.jsonl')
    writeFileSync(transcript, '')

    const { runSessionCalls } = await invokeWith(
      { parentSessionId: 'ses_abc', parentTranscriptPath: transcript, agentDir, streamLineCursor: 7 },
      agentDir,
    )

    const prompt = runSessionCalls[0]!.userPrompt!
    expect(prompt).toMatch(/Stream line cursor: 7/)
    expect(prompt).toMatch(/offset=8/)
  })

  test('handler omits Stream line cursor line when payload has no streamLineCursor', async () => {
    const agentDir = makeAgentDir()
    const transcript = join(agentDir, 'sessions', 'ses_abc.jsonl')
    writeFileSync(transcript, '')

    const { runSessionCalls } = await invokeWith(
      { parentSessionId: 'ses_abc', parentTranscriptPath: transcript, agentDir },
      agentDir,
    )

    const prompt = runSessionCalls[0]!.userPrompt!
    expect(prompt).not.toMatch(/Stream line cursor:/)
  })

  test('handler indicates "no prior watermark" when none exists', async () => {
    const agentDir = makeAgentDir()
    const transcript = join(agentDir, 'sessions', 'ses_abc.jsonl')
    writeFileSync(transcript, '')

    const { runSessionCalls } = await invokeWith(
      { parentSessionId: 'ses_abc', parentTranscriptPath: transcript, agentDir },
      agentDir,
    )

    expect(runSessionCalls[0]!.userPrompt!.toLowerCase()).toMatch(/no.*watermark|no prior|first time|begin/)
  })

  test('handler emits a [memory-logger] start log line with parentSessionId and watermark on every run', async () => {
    const agentDir = makeAgentDir()
    const transcript = join(agentDir, 'sessions', 'ses_abc.jsonl')
    writeFileSync(transcript, '')

    const logs: string[] = []
    const subagent = createMemoryLoggerSubagent({
      logger: { info: (m) => logs.push(m), warn: () => {}, error: () => {} },
    })
    const runSession: RunSession = async () => {}
    const ctx: SubagentContext<MemoryLoggerPayload> = {
      userPrompt: '',
      agentDir,
      payload: { parentSessionId: 'ses_abc', parentTranscriptPath: transcript, agentDir },
    }
    await subagent.handler!(ctx, runSession)

    const startLog = logs.find((l) => l.startsWith('[memory-logger] ses_abc start'))
    expect(startLog).toBeDefined()
    expect(startLog!).toContain('watermark=none')
    expect(logs.some((l) => l.startsWith('[memory-logger] ses_abc done'))).toBe(true)
  })

  test('handler emits a [memory-logger] warn log line and rethrows when runSession fails', async () => {
    const agentDir = makeAgentDir()
    const transcript = join(agentDir, 'sessions', 'ses_abc.jsonl')
    writeFileSync(transcript, '')

    const warnings: string[] = []
    const subagent = createMemoryLoggerSubagent({
      logger: { info: () => {}, warn: (m) => warnings.push(m), error: () => {} },
    })
    const runSession: RunSession = async () => {
      throw new Error('LLM blew up')
    }
    const ctx: SubagentContext<MemoryLoggerPayload> = {
      userPrompt: '',
      agentDir,
      payload: { parentSessionId: 'ses_abc', parentTranscriptPath: transcript, agentDir },
    }
    await expect(subagent.handler!(ctx, runSession)).rejects.toThrow('LLM blew up')
    expect(warnings.some((m) => m.includes('[memory-logger] ses_abc') && m.includes('LLM blew up'))).toBe(true)
  })

  test('creates memory/streams/ on first write if absent', async () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'memory-agent-'))
    mkdirSync(join(agentDir, 'memory'))
    mkdirSync(join(agentDir, 'sessions'))
    const transcript = join(agentDir, 'sessions', 'ses_abc.jsonl')
    writeFileSync(transcript, '')

    const runSession: RunSession = async () => {
      await appendTool.execute(
        {
          topic: 'Test',
          body: 'Test body',
          source: 'ses_abc',
          entry: 'entry_1',
          latestEntryId: 'entry_1',
        },
        {
          signal: undefined,
          sessionId: 'test',
          agentDir,
          logger: { info: () => {}, warn: () => {}, error: () => {} },
        },
      )
    }
    const ctx: SubagentContext<MemoryLoggerPayload> = {
      userPrompt: '',
      agentDir,
      payload: { parentSessionId: 'ses_abc', parentTranscriptPath: transcript, agentDir },
    }
    await silentSubagent.handler!(ctx, runSession)

    const today = formatLocalDate()
    expect(existsSync(join(agentDir, 'memory', 'streams'))).toBe(true)
    expect(existsSync(join(agentDir, 'memory', 'streams', `${today}.jsonl`))).toBe(true)
  })

  test('run can store a verbatim reference and append a fragment citing it', async () => {
    const agentDir = makeAgentDir()
    const sql = 'SELECT * FROM users WHERE id = 1'
    const transcript = join(agentDir, 'sessions', 'ses_abc.jsonl')
    writeFileSync(
      transcript,
      `${JSON.stringify({ id: 'entry_sql', role: 'user', text: `remember this query verbatim: ${sql}` })}\n`,
    )

    const runSession: RunSession = async () => {
      const stored = await storeReferenceTool.execute(
        { title: 'User lookup query', body: sql, origin: 'episode', tags: [] },
        toolCtx(agentDir),
      )
      const slug = (stored.details as { slug: string }).slug
      await appendTool.execute(
        {
          topic: 'verbatim reference stored',
          body: 'The user explicitly asked to remember the user lookup SQL query verbatim.',
          source: 'ses_abc',
          entry: 'entry_sql',
          latestEntryId: 'entry_sql',
          references: [slug],
        },
        toolCtx(agentDir),
      )
    }
    const ctx: SubagentContext<MemoryLoggerPayload> = {
      userPrompt: '',
      agentDir,
      payload: { parentSessionId: 'ses_abc', parentTranscriptPath: transcript, agentDir },
    }

    await silentSubagent.handler!(ctx, runSession)

    const referenceText = readFileSync(join(agentDir, 'memory', 'references', 'user-lookup-query.md'), 'utf8')
    expect(parseReference(referenceText).body).toBe(sql)
    const events = await readEvents(streamFilePath(agentDir, formatLocalDate()))
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'fragment',
        topic: 'verbatim reference stored',
        references: ['user-lookup-query'],
      }),
    )
  })

  test('the wired append tool drops a hallucinated reference slug while keeping the real one', async () => {
    const agentDir = makeAgentDir()
    const wiredStore = silentSubagent.customTools!.find((t) => t.description.startsWith('store_reference:'))!
    const wiredAppend = silentSubagent.customTools!.find((t) => t.description.startsWith('Append a memory fragment'))!

    const stored = await wiredStore.execute(
      { title: 'Lookup query', body: 'SELECT 1', origin: 'episode', tags: [] },
      toolCtx(agentDir),
    )
    const slug = (stored.details as { slug: string }).slug

    await wiredAppend.execute(
      {
        topic: 'verbatim reference stored',
        body: 'Stored the lookup query.',
        source: 'ses_abc',
        entry: 'entry_sql',
        latestEntryId: 'entry_sql',
        references: [slug, 'typeclaw-pr-998-invented', ''],
      },
      toolCtx(agentDir),
    )

    const events = await readEvents(streamFilePath(agentDir, formatLocalDate()))
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'fragment', topic: 'verbatim reference stored', references: [slug] }),
    )
  })

  test('the default exported memoryLoggerSubagent still has a handler (back-compat)', () => {
    expect(memoryLoggerSubagent.handler).toBeDefined()
  })
})

function toolCtx(agentDir: string) {
  return {
    signal: undefined,
    sessionId: 'test',
    agentDir,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }
}
