import type { ReviewThreadResolveRequest, ReviewThreadResolveResult, ReviewThreadResolver } from '@/channels/types'

import { describeError } from '../../describe-error'
import type { GithubAuthContext } from './auth'
import { GITHUB_API_BASE, githubJsonHeaders } from './auth-pat'

const GRAPHQL_ENDPOINT = `${GITHUB_API_BASE}/graphql`

// One page of review threads. `first: 100` is the GraphQL max; a busy PR can
// carry more, so the resolver paginates until it matches the root comment id
// or exhausts the pages — stopping early on a 404-equivalent (thread absent)
// rather than fabricating a node id.
const THREADS_QUERY = `query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor}nodes{id isResolved path line comments(first:1){nodes{databaseId body author{__typename login}}}}}}}}`

const RESOLVE_MUTATION = `mutation($threadId:ID!){resolveReviewThread(input:{threadId:$threadId}){thread{id isResolved}}}`

type ReviewThreadNode = {
  id: string
  isResolved: boolean
  rootCommentId: number | null
  rootAuthorLogin: string | null
  rootAuthorIsBot: boolean
  path: string | null
  line: number | null
  rootBody: string | null
}

type ThreadLookup =
  | { kind: 'found'; thread: ReviewThreadNode }
  | { kind: 'absent' }
  | { kind: 'error'; result: ReviewThreadResolveResult & { ok: false } }

export function createGithubReviewThreadResolver(deps: {
  token: (context?: GithubAuthContext) => Promise<string>
  selfLogin: () => string | null
  fetchImpl?: typeof fetch
}): ReviewThreadResolver {
  const fetchImpl = deps.fetchImpl ?? fetch
  return async (req): Promise<ReviewThreadResolveResult> => {
    if (req.adapter !== 'github') {
      return { ok: false, error: `unknown adapter: ${req.adapter}`, code: 'unsupported' }
    }
    const target = parseTarget(req)
    if (target === null) {
      return {
        ok: false,
        error: `unparseable github review-thread target (chat=${req.chat}, root=${req.rootCommentId})`,
        code: 'transient',
      }
    }
    const selfLogin = deps.selfLogin()
    if (selfLogin === null) {
      return {
        ok: false,
        error: 'github self-identity not resolved; cannot verify thread authorship',
        code: 'transient',
      }
    }

    return await withThreadLock(threadLockKey(target), async () => {
      const token = await deps.token({ repoSlug: `${target.owner}/${target.repo}` })
      const lookup = await findThread(fetchImpl, token, target)
      if (lookup.kind === 'error') return lookup.result
      if (lookup.kind === 'absent') {
        return {
          ok: false,
          error: `no review thread rooted at comment ${target.rootCommentId} on ${req.chat}`,
          code: 'no-match',
        }
      }

      const thread = lookup.thread
      // The load-bearing guard: only the bot may resolve the bot's own thread.
      // Resolving a human reviewer's thread would erase their open question.
      if (!isSelfAuthor(thread, selfLogin)) {
        return {
          ok: false,
          error: `refusing to resolve thread authored by @${thread.rootAuthorLogin ?? 'unknown'} (not @${selfLogin})`,
          code: 'not-author',
        }
      }
      if (thread.isResolved) return { ok: true, alreadyResolved: true }

      return await runResolveMutation(fetchImpl, token, thread.id)
    })
  }
}

// `alreadyResolved` is only observable from the pre-mutation lookup, so two
// callers that each see the thread open would both mutate and both post an
// acknowledgement. Serializing per thread makes the follower's lookup run after
// the leader's mutation, so it observes `isResolved` and reports the no-op
// instead. Resolved state is never cached — GitHub stays the authority, which is
// what keeps this correct across processes and restarts.
const threadResolveLocks = new Map<string, Promise<void>>()

function threadLockKey(target: ResolveTarget): string {
  return `${target.owner}/${target.repo}#${target.prNumber}:${target.rootCommentId}`
}

// Deliberately NOT a bounded/evicting map: dropping an in-flight key would let a
// second caller enter the critical section concurrently and reopen the race this
// closes. Entries are deleted once their tail settles, so the map stays bounded
// by the number of resolves actually in flight.
function withThreadLock<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = threadResolveLocks.get(key) ?? Promise.resolve()
  const result = previous.then(run)
  const tail = result.then(
    () => undefined,
    () => undefined,
  )
  threadResolveLocks.set(key, tail)
  void tail.then(() => {
    if (threadResolveLocks.get(key) === tail) threadResolveLocks.delete(key)
  })
  return result
}

// A GitHub App's own login differs across the two APIs this guard straddles:
// REST `getSelf` returns `slug[bot]` (selfLogin) but GraphQL's `Bot` author node
// returns the bare `slug` (rootAuthorLogin). Strict `===` thus refused the App's
// OWN thread (production: "refusing to resolve thread authored by @typeey (not
// @typeey[bot])"). The bare-slug match is gated on the GraphQL author actually
// being a `Bot`: a human `User` can legitimately own the bare slug as a login
// (e.g. the user `typeey` exists alongside the App `typeey[bot]`), so a User
// author must still match `selfLogin` exactly — otherwise the suffix-strip would
// let the bot close a human reviewer's thread, defeating the guard above.
const BOT_LOGIN_SUFFIX = '[bot]'

function isSelfAuthor(thread: ReviewThreadNode, selfLogin: string): boolean {
  if (thread.rootAuthorLogin === null) return false
  if (thread.rootAuthorIsBot) {
    return normalizeBotLogin(thread.rootAuthorLogin) === normalizeBotLogin(selfLogin)
  }
  return thread.rootAuthorLogin === selfLogin
}

function normalizeBotLogin(login: string): string {
  return login.endsWith(BOT_LOGIN_SUFFIX) ? login.slice(0, -BOT_LOGIN_SUFFIX.length) : login
}

type ResolveTarget = { owner: string; repo: string; prNumber: number; rootCommentId: number }

function parseTarget(req: ReviewThreadResolveRequest): ResolveTarget | null {
  const [owner, repo, ...rest] = req.workspace.split('/')
  if (owner === undefined || owner === '' || repo === undefined || repo === '' || rest.length > 0) return null
  const prMatch = /^pr:(\d+)$/.exec(req.chat)
  if (prMatch === null) return null
  const prNumber = parseDecimalId(prMatch[1])
  const rootCommentId = parseDecimalId(req.rootCommentId)
  if (prNumber === null || rootCommentId === null) return null
  return { owner, repo, prNumber, rootCommentId }
}

// Strict decimal-id parse: `Number()` would coerce '' -> 0, '1e2' -> 100, and
// silently round ids past 2^53 (GitHub comment ids are large), any of which
// could match the WRONG thread. Demand a plain run of digits and a safe
// integer, so a malformed or oversized id fails closed (no resolution) rather
// than resolving a collided thread.
function parseDecimalId(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value)) return null
  const n = Number(value)
  return Number.isSafeInteger(n) ? n : null
}

async function findThread(fetchImpl: typeof fetch, token: string, target: ResolveTarget): Promise<ThreadLookup> {
  let lookup: ThreadLookup = { kind: 'absent' }
  const outcome = await walkThreadPages(
    fetchImpl,
    token,
    { owner: target.owner, repo: target.repo, prNumber: target.prNumber },
    (nodes) => {
      for (const node of nodes) {
        if (node.rootCommentId === target.rootCommentId) {
          lookup = { kind: 'found', thread: node }
          return 'stop'
        }
      }
      return 'continue'
    },
  )
  if (outcome.kind === 'error') return { kind: 'error', result: outcome.result }
  return lookup
}

export type UnresolvedSelfReviewThread = {
  threadId: string
  rootCommentId: number
  path: string | null
  line: number | null
  snippet: string | null
}

// One line of the root comment, capped, so the follow-up prompt can name each
// thread by its concern instead of a bare id — without dumping a multi-paragraph
// review comment into the system-facing instruction.
const SNIPPET_MAX_CHARS = 140

function firstLineSnippet(body: string | null): string | null {
  if (body === null) return null
  const firstLine = body.split('\n', 1)[0]?.trim() ?? ''
  if (firstLine === '') return null
  return firstLine.length > SNIPPET_MAX_CHARS ? `${firstLine.slice(0, SNIPPET_MAX_CHARS)}…` : firstLine
}

export type ListUnresolvedSelfReviewThreadsResult =
  | { ok: true; threads: UnresolvedSelfReviewThread[] }
  | { ok: false; error: string }

// Reuses the same page-walk and authorship guard (`isSelfAuthor`) as the
// single-thread resolver so the post-push "did my comments get addressed?"
// sweep can never surface a human reviewer's thread as a resolve candidate.
export async function listUnresolvedSelfReviewThreads(deps: {
  token: string
  selfLogin: string
  owner: string
  repo: string
  prNumber: number
  fetchImpl?: typeof fetch
}): Promise<ListUnresolvedSelfReviewThreadsResult> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const threads: UnresolvedSelfReviewThread[] = []
  const outcome = await walkThreadPages(
    fetchImpl,
    deps.token,
    { owner: deps.owner, repo: deps.repo, prNumber: deps.prNumber },
    (nodes) => {
      for (const node of nodes) {
        if (node.isResolved || node.rootCommentId === null) continue
        if (!isSelfAuthor(node, deps.selfLogin)) continue
        threads.push({
          threadId: node.id,
          rootCommentId: node.rootCommentId,
          path: node.path,
          line: node.line,
          snippet: firstLineSnippet(node.rootBody),
        })
      }
      return 'continue'
    },
  )
  if (outcome.kind === 'error') return { ok: false, error: outcome.result.error }
  return { ok: true, threads }
}

type WalkOutcome = { kind: 'done' } | { kind: 'error'; result: ReviewThreadResolveResult & { ok: false } }

async function walkThreadPages(
  fetchImpl: typeof fetch,
  token: string,
  target: { owner: string; repo: string; prNumber: number },
  onPage: (nodes: ReviewThreadNode[]) => 'stop' | 'continue',
): Promise<WalkOutcome> {
  let after: string | null = null
  for (;;) {
    let response: Response
    try {
      response = await fetchImpl(GRAPHQL_ENDPOINT, {
        method: 'POST',
        headers: githubJsonHeaders(token),
        body: JSON.stringify({
          query: THREADS_QUERY,
          variables: { owner: target.owner, name: target.repo, number: target.prNumber, after },
        }),
      })
    } catch (err) {
      return {
        kind: 'error',
        result: { ok: false, error: describeError(err), code: 'transient' },
      }
    }
    const parsed = await parseThreadsPage(response)
    if (parsed.kind === 'error') return { kind: 'error', result: parsed.result }
    if (onPage(parsed.nodes) === 'stop') return { kind: 'done' }
    if (!parsed.hasNextPage || parsed.endCursor === null) return { kind: 'done' }
    after = parsed.endCursor
  }
}

type ThreadsPage =
  | { kind: 'ok'; nodes: ReviewThreadNode[]; hasNextPage: boolean; endCursor: string | null }
  | { kind: 'error'; result: ReviewThreadResolveResult & { ok: false } }

async function parseThreadsPage(response: Response): Promise<ThreadsPage> {
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    return {
      kind: 'error',
      result: {
        ok: false,
        error: `GitHub GraphQL ${response.status}${text !== '' ? `: ${text}` : ''}`,
        code: classifyStatus(response.status),
      },
    }
  }
  const body = (await response.json().catch(() => null)) as GraphqlThreadsResponse | null
  if (body === null)
    return { kind: 'error', result: { ok: false, error: 'GitHub GraphQL returned non-JSON', code: 'transient' } }
  if (body.errors !== undefined && body.errors.length > 0) {
    return {
      kind: 'error',
      result: {
        ok: false,
        error: `GitHub GraphQL error: ${body.errors.map((e) => e.message).join('; ')}`,
        code: 'transient',
      },
    }
  }
  const connection = body.data?.repository?.pullRequest?.reviewThreads
  if (connection === undefined)
    return {
      kind: 'error',
      result: { ok: false, error: 'GitHub GraphQL response missing reviewThreads', code: 'transient' },
    }
  const nodes = connection.nodes.map((n) => {
    const root = n.comments.nodes[0]
    return {
      id: n.id,
      isResolved: n.isResolved,
      rootCommentId: root?.databaseId ?? null,
      rootAuthorLogin: root?.author?.login ?? null,
      rootAuthorIsBot: root?.author?.__typename === 'Bot',
      path: n.path ?? null,
      line: n.line ?? null,
      rootBody: root?.body ?? null,
    }
  })
  return { kind: 'ok', nodes, hasNextPage: connection.pageInfo.hasNextPage, endCursor: connection.pageInfo.endCursor }
}

async function runResolveMutation(
  fetchImpl: typeof fetch,
  token: string,
  threadId: string,
): Promise<ReviewThreadResolveResult> {
  let response: Response
  try {
    response = await fetchImpl(GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers: githubJsonHeaders(token),
      body: JSON.stringify({ query: RESOLVE_MUTATION, variables: { threadId } }),
    })
  } catch (err) {
    return { ok: false, error: describeError(err), code: 'transient' }
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    return {
      ok: false,
      error: `GitHub GraphQL ${response.status}${text !== '' ? `: ${text}` : ''}`,
      code: classifyStatus(response.status),
    }
  }
  const body = (await response.json().catch(() => null)) as GraphqlResolveResponse | null
  if (body === null) return { ok: false, error: 'GitHub GraphQL returned non-JSON', code: 'transient' }
  if (body.errors !== undefined && body.errors.length > 0) {
    return {
      ok: false,
      error: `GitHub GraphQL error: ${body.errors.map((e) => e.message).join('; ')}`,
      code: 'transient',
    }
  }
  if (body.data?.resolveReviewThread?.thread?.isResolved === true) return { ok: true }
  return { ok: false, error: 'resolveReviewThread mutation did not report isResolved', code: 'transient' }
}

function classifyStatus(status: number): 'permission-denied' | 'not-found' | 'transient' {
  if (status === 401 || status === 403) return 'permission-denied'
  if (status === 404) return 'not-found'
  return 'transient'
}

type GraphqlThreadsResponse = {
  data?: {
    repository?: {
      pullRequest?: {
        reviewThreads?: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null }
          nodes: Array<{
            id: string
            isResolved: boolean
            path?: string | null
            line?: number | null
            comments: {
              nodes: Array<{ databaseId?: number; body?: string; author?: { __typename?: string; login?: string } }>
            }
          }>
        }
      }
    }
  }
  errors?: Array<{ message: string }>
}

type GraphqlResolveResponse = {
  data?: { resolveReviewThread?: { thread?: { id: string; isResolved: boolean } } }
  errors?: Array<{ message: string }>
}
