import { describe, expect, it } from 'bun:test'

import type { ReviewThreadResolveRequest } from '@/channels/types'

import { createGithubReviewThreadResolver, listUnresolvedSelfReviewThreads } from './review-thread-resolver'

type ThreadFixture = {
  id: string
  isResolved: boolean
  rootCommentId: number
  rootAuthorLogin: string
  rootAuthorType?: 'Bot' | 'User'
  path?: string | null
  line?: number | null
  rootBody?: string
}

type Page = { threads: ThreadFixture[]; hasNextPage: boolean; endCursor: string | null }

const threadsPayload = (page: Page) => ({
  data: {
    repository: {
      pullRequest: {
        reviewThreads: {
          pageInfo: { hasNextPage: page.hasNextPage, endCursor: page.endCursor },
          nodes: page.threads.map((t) => ({
            id: t.id,
            isResolved: t.isResolved,
            path: t.path ?? null,
            line: t.line ?? null,
            comments: {
              nodes: [
                {
                  databaseId: t.rootCommentId,
                  body: t.rootBody,
                  author: { __typename: t.rootAuthorType ?? 'Bot', login: t.rootAuthorLogin },
                },
              ],
            },
          })),
        },
      },
    },
  },
})

// One fetch fake for the single /graphql endpoint: it returns successive
// `pages` for query calls and a fixed success/error for the mutation, while
// recording every request body so tests can assert what ran and in what order.
function fakeGraphql(options: {
  pages: Page[]
  resolveResponse?: { status: number; body?: unknown }
  seen?: { mutations: string[]; queryCount: number }
}) {
  let pageIndex = 0
  return Object.assign(
    async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { query: string; variables: Record<string, unknown> }
      if (body.query.includes('resolveReviewThread(input')) {
        if (options.seen) options.seen.mutations.push(String(body.variables.threadId))
        const r = options.resolveResponse ?? {
          status: 200,
          body: {
            data: { resolveReviewThread: { thread: { id: String(body.variables.threadId), isResolved: true } } },
          },
        }
        return new Response(JSON.stringify(r.body ?? {}), { status: r.status })
      }
      if (options.seen) options.seen.queryCount += 1
      const page = options.pages[Math.min(pageIndex, options.pages.length - 1)]
      pageIndex += 1
      return new Response(JSON.stringify(threadsPayload(page!)), { status: 200 })
    },
    { preconnect: () => {} },
  )
}

const req = (
  rootCommentId: number,
  overrides: Partial<ReviewThreadResolveRequest> = {},
): ReviewThreadResolveRequest => ({
  adapter: 'github',
  workspace: 'acme/widgets',
  chat: 'pr:585',
  rootCommentId: String(rootCommentId),
  ...overrides,
})

const resolverFor = (fetchImpl: typeof fetch, selfLogin: string | null = 'bot[bot]') =>
  createGithubReviewThreadResolver({ token: async () => 'tok', selfLogin: () => selfLogin, fetchImpl })

describe('github review-thread resolver', () => {
  it('resolves a thread the bot authored once the author addressed it', async () => {
    const seen = { mutations: [] as string[], queryCount: 0 }
    const resolve = resolverFor(
      fakeGraphql({
        pages: [
          {
            threads: [{ id: 'PRRT_1', isResolved: false, rootCommentId: 100, rootAuthorLogin: 'bot[bot]' }],
            hasNextPage: false,
            endCursor: null,
          },
        ],
        seen,
      }),
    )

    const result = await resolve(req(100))

    expect(result.ok).toBe(true)
    expect(seen.mutations).toEqual(['PRRT_1'])
  })

  it('resolves the bot App thread when GraphQL reports the bare slug and self-login carries [bot]', async () => {
    // given: a Bot author named by bare slug while getSelf returns slug[bot]
    const seen = { mutations: [] as string[], queryCount: 0 }
    const resolve = resolverFor(
      fakeGraphql({
        pages: [
          {
            threads: [
              {
                id: 'PRRT_BOT',
                isResolved: false,
                rootCommentId: 100,
                rootAuthorLogin: 'typeey',
                rootAuthorType: 'Bot',
              },
            ],
            hasNextPage: false,
            endCursor: null,
          },
        ],
        seen,
      }),
      'typeey[bot]',
    )

    // when
    const result = await resolve(req(100))

    // then
    expect(result.ok).toBe(true)
    expect(seen.mutations).toEqual(['PRRT_BOT'])
  })

  it('refuses a human User whose login equals the bot slug (no suffix-strip across User authors)', async () => {
    // given: a human User `typeey` whose login collides with the App slug, self-login `typeey[bot]`
    const seen = { mutations: [] as string[], queryCount: 0 }
    const resolve = resolverFor(
      fakeGraphql({
        pages: [
          {
            threads: [
              {
                id: 'PRRT_USER',
                isResolved: false,
                rootCommentId: 150,
                rootAuthorLogin: 'typeey',
                rootAuthorType: 'User',
              },
            ],
            hasNextPage: false,
            endCursor: null,
          },
        ],
        seen,
      }),
      'typeey[bot]',
    )

    // when
    const result = await resolve(req(150))

    // then
    expect(result).toEqual({
      ok: false,
      error: 'refusing to resolve thread authored by @typeey (not @typeey[bot])',
      code: 'not-author',
    })
    expect(seen.mutations).toEqual([])
  })

  it('refuses to resolve a thread authored by a human', async () => {
    const seen = { mutations: [] as string[], queryCount: 0 }
    const resolve = resolverFor(
      fakeGraphql({
        pages: [
          {
            threads: [
              {
                id: 'PRRT_2',
                isResolved: false,
                rootCommentId: 200,
                rootAuthorLogin: 'octocat',
                rootAuthorType: 'User',
              },
            ],
            hasNextPage: false,
            endCursor: null,
          },
        ],
        seen,
      }),
    )

    const result = await resolve(req(200))

    expect(result).toEqual({
      ok: false,
      error: 'refusing to resolve thread authored by @octocat (not @bot[bot])',
      code: 'not-author',
    })
    expect(seen.mutations).toEqual([])
  })

  it('reports already-resolved without re-running the mutation', async () => {
    const seen = { mutations: [] as string[], queryCount: 0 }
    const resolve = resolverFor(
      fakeGraphql({
        pages: [
          {
            threads: [{ id: 'PRRT_3', isResolved: true, rootCommentId: 300, rootAuthorLogin: 'bot[bot]' }],
            hasNextPage: false,
            endCursor: null,
          },
        ],
        seen,
      }),
    )

    const result = await resolve(req(300))

    expect(result).toEqual({ ok: true, alreadyResolved: true })
    expect(seen.mutations).toEqual([])
  })

  it('serializes concurrent close-outs on one thread so only the leader mutates', async () => {
    // given: a live thread whose state flips once the mutation lands, so a
    // follower that looks it up AFTER the leader observes it already resolved
    const state = { resolved: false, mutations: 0 }
    const fetchImpl = Object.assign(
      async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { query: string }
        if (body.query.includes('resolveReviewThread(input')) {
          state.mutations += 1
          state.resolved = true
          return new Response(
            JSON.stringify({ data: { resolveReviewThread: { thread: { id: 'PRRT_C', isResolved: true } } } }),
            { status: 200 },
          )
        }
        return new Response(
          JSON.stringify(
            threadsPayload({
              threads: [{ id: 'PRRT_C', isResolved: state.resolved, rootCommentId: 700, rootAuthorLogin: 'bot[bot]' }],
              hasNextPage: false,
              endCursor: null,
            }),
          ),
          { status: 200 },
        )
      },
      { preconnect: () => {} },
    )
    const resolve = resolverFor(fetchImpl)

    // when: two sessions close the same thread out at the same time
    const [first, second] = await Promise.all([resolve(req(700)), resolve(req(700))])

    // then: exactly one mutation ran and the follower reports the no-op, so the
    // caller suppresses its duplicate acknowledgement
    expect(state.mutations).toBe(1)
    expect([first, second].filter((r) => r.ok && r.alreadyResolved !== true)).toHaveLength(1)
    expect([first, second].filter((r) => r.ok && r.alreadyResolved === true)).toHaveLength(1)
  })

  it('releases the per-thread lock when a resolve throws', async () => {
    let calls = 0
    const fetchImpl = Object.assign(
      async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { query: string }
        calls += 1
        if (calls === 1) throw new Error('boom')
        if (body.query.includes('resolveReviewThread(input')) {
          return new Response(
            JSON.stringify({ data: { resolveReviewThread: { thread: { id: 'PRRT_L', isResolved: true } } } }),
            { status: 200 },
          )
        }
        return new Response(
          JSON.stringify(
            threadsPayload({
              threads: [{ id: 'PRRT_L', isResolved: false, rootCommentId: 800, rootAuthorLogin: 'bot[bot]' }],
              hasNextPage: false,
              endCursor: null,
            }),
          ),
          { status: 200 },
        )
      },
      { preconnect: () => {} },
    )
    const resolve = resolverFor(fetchImpl)

    const failed = await resolve(req(800))
    const recovered = await resolve(req(800))

    expect(failed.ok).toBe(false)
    expect(recovered.ok).toBe(true)
  })

  it('paginates past the first page to find a thread that sits later', async () => {
    const seen = { mutations: [] as string[], queryCount: 0 }
    const resolve = resolverFor(
      fakeGraphql({
        pages: [
          {
            threads: [{ id: 'PRRT_A', isResolved: false, rootCommentId: 1, rootAuthorLogin: 'bot[bot]' }],
            hasNextPage: true,
            endCursor: 'cursor1',
          },
          {
            threads: [{ id: 'PRRT_TARGET', isResolved: false, rootCommentId: 999, rootAuthorLogin: 'bot[bot]' }],
            hasNextPage: false,
            endCursor: null,
          },
        ],
        seen,
      }),
    )

    const result = await resolve(req(999))

    expect(result.ok).toBe(true)
    expect(seen.queryCount).toBe(2)
    expect(seen.mutations).toEqual(['PRRT_TARGET'])
  })

  it('reports no-match when no thread matches the root comment id', async () => {
    const resolve = resolverFor(
      fakeGraphql({
        pages: [
          {
            threads: [{ id: 'PRRT_X', isResolved: false, rootCommentId: 1, rootAuthorLogin: 'bot[bot]' }],
            hasNextPage: false,
            endCursor: null,
          },
        ],
      }),
    )

    const result = await resolve(req(404))

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('no-match')
  })

  it('fails when the mutation does not report isResolved', async () => {
    const resolve = resolverFor(
      fakeGraphql({
        pages: [
          {
            threads: [{ id: 'PRRT_5', isResolved: false, rootCommentId: 500, rootAuthorLogin: 'bot[bot]' }],
            hasNextPage: false,
            endCursor: null,
          },
        ],
        resolveResponse: {
          status: 200,
          body: { data: { resolveReviewThread: { thread: { id: 'PRRT_5', isResolved: false } } } },
        },
      }),
    )

    const result = await resolve(req(500))

    expect(result.ok).toBe(false)
  })

  it('refuses when self-login is not yet resolved', async () => {
    const resolve = resolverFor(fakeGraphql({ pages: [{ threads: [], hasNextPage: false, endCursor: null }] }), null)

    const result = await resolve(req(1))

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('transient')
  })

  it('rejects a malformed chat key as a hard failure (not non-blocking)', async () => {
    const resolve = resolverFor(fakeGraphql({ pages: [{ threads: [], hasNextPage: false, endCursor: null }] }))

    const result = await resolve(req(1, { chat: 'issue:5' }))

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('transient')
  })

  it('rejects non-decimal and unsafe root comment ids without listing threads', async () => {
    const seen = { mutations: [] as string[], queryCount: 0 }
    const resolve = resolverFor(fakeGraphql({ pages: [{ threads: [], hasNextPage: false, endCursor: null }], seen }))

    for (const bad of ['', '1e2', '0x10', '9007199254740993', ' 12']) {
      const result = await resolve(req(0, { rootCommentId: bad }))
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.code).toBe('transient')
    }
    expect(seen.queryCount).toBe(0)
    expect(seen.mutations).toEqual([])
  })

  it('does not resolve when the matched thread has no root comment data', async () => {
    const seen = { mutations: [] as string[], queryCount: 0 }
    const fetchImpl = Object.assign(
      async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { query: string; variables: Record<string, unknown> }
        if (body.query.includes('resolveReviewThread(input')) {
          seen.mutations.push(String(body.variables.threadId))
          return new Response(
            JSON.stringify({ data: { resolveReviewThread: { thread: { id: 'x', isResolved: true } } } }),
            { status: 200 },
          )
        }
        seen.queryCount += 1
        return new Response(
          JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [{ id: 'PRRT_EMPTY', isResolved: false, comments: { nodes: [] } }],
                  },
                },
              },
            },
          }),
          { status: 200 },
        )
      },
      { preconnect: () => {} },
    )
    const resolve = resolverFor(fetchImpl)

    const result = await resolve(req(700))

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('no-match')
    expect(seen.mutations).toEqual([])
  })
})

describe('listUnresolvedSelfReviewThreads', () => {
  const list = (fetchImpl: typeof fetch, selfLogin = 'bot[bot]') =>
    listUnresolvedSelfReviewThreads({
      token: 'tok',
      selfLogin,
      owner: 'acme',
      repo: 'widgets',
      prNumber: 585,
      fetchImpl,
    })

  it('returns only the bot-authored, still-unresolved threads', async () => {
    const fetchImpl = fakeGraphql({
      pages: [
        {
          threads: [
            { id: 'T_OPEN_BOT', isResolved: false, rootCommentId: 100, rootAuthorLogin: 'bot[bot]' },
            { id: 'T_RESOLVED_BOT', isResolved: true, rootCommentId: 101, rootAuthorLogin: 'bot[bot]' },
            {
              id: 'T_OPEN_HUMAN',
              isResolved: false,
              rootCommentId: 102,
              rootAuthorLogin: 'alice',
              rootAuthorType: 'User',
            },
          ],
          hasNextPage: false,
          endCursor: null,
        },
      ],
    })

    const result = await list(fetchImpl)

    expect(result).toEqual({
      ok: true,
      threads: [{ threadId: 'T_OPEN_BOT', rootCommentId: 100, path: null, line: null, snippet: null }],
    })
  })

  it('carries per-thread context (path, line, first-line snippet) when GraphQL reports it', async () => {
    const fetchImpl = fakeGraphql({
      pages: [
        {
          threads: [
            {
              id: 'T_CTX',
              isResolved: false,
              rootCommentId: 200,
              rootAuthorLogin: 'bot[bot]',
              path: 'src/api/auth.ts',
              line: 42,
              rootBody: 'This token never expires — set a TTL.\nMore detail on the next line.',
            },
          ],
          hasNextPage: false,
          endCursor: null,
        },
      ],
    })

    const result = await list(fetchImpl)

    expect(result).toEqual({
      ok: true,
      threads: [
        {
          threadId: 'T_CTX',
          rootCommentId: 200,
          path: 'src/api/auth.ts',
          line: 42,
          snippet: 'This token never expires — set a TTL.',
        },
      ],
    })
  })

  it('paginates across pages and aggregates self threads', async () => {
    const fetchImpl = fakeGraphql({
      pages: [
        {
          threads: [{ id: 'T1', isResolved: false, rootCommentId: 1, rootAuthorLogin: 'bot[bot]' }],
          hasNextPage: true,
          endCursor: 'cur1',
        },
        {
          threads: [{ id: 'T2', isResolved: false, rootCommentId: 2, rootAuthorLogin: 'bot[bot]' }],
          hasNextPage: false,
          endCursor: null,
        },
      ],
    })

    const result = await list(fetchImpl)

    expect(result).toEqual({
      ok: true,
      threads: [
        { threadId: 'T1', rootCommentId: 1, path: null, line: null, snippet: null },
        { threadId: 'T2', rootCommentId: 2, path: null, line: null, snippet: null },
      ],
    })
  })

  it('matches the App bot thread when GraphQL reports the bare slug and self-login carries [bot]', async () => {
    const fetchImpl = fakeGraphql({
      pages: [
        {
          threads: [
            { id: 'T_APP', isResolved: false, rootCommentId: 9, rootAuthorLogin: 'typeey', rootAuthorType: 'Bot' },
          ],
          hasNextPage: false,
          endCursor: null,
        },
      ],
    })

    const result = await list(fetchImpl, 'typeey[bot]')

    expect(result).toEqual({
      ok: true,
      threads: [{ threadId: 'T_APP', rootCommentId: 9, path: null, line: null, snippet: null }],
    })
  })

  it('returns an empty list when no bot-authored unresolved threads exist', async () => {
    const fetchImpl = fakeGraphql({
      pages: [
        {
          threads: [
            { id: 'T_HUMAN', isResolved: false, rootCommentId: 5, rootAuthorLogin: 'alice', rootAuthorType: 'User' },
          ],
          hasNextPage: false,
          endCursor: null,
        },
      ],
    })

    const result = await list(fetchImpl)

    expect(result).toEqual({ ok: true, threads: [] })
  })

  it('surfaces a transport error as ok:false', async () => {
    const fetchImpl = Object.assign(
      async (): Promise<Response> => {
        throw new Error('network down')
      },
      { preconnect: () => {} },
    )

    const result = await list(fetchImpl)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('network down')
  })
})
