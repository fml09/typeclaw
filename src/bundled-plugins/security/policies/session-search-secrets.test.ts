import { describe, expect, test } from 'bun:test'

import {
  GUARD_SESSION_SEARCH_SECRETS,
  checkSessionSearchSecretsGuard,
  detectSessionSearchSecretQuery,
} from './session-search-secrets'

describe('detectSessionSearchSecretQuery', () => {
  test('flags the canonical red-team OR-query', () => {
    const hits = detectSessionSearchSecretQuery('password OR token OR api_key OR secret OR credit')
    const labels = hits.map((h) => h.label)
    expect(labels).toContain('password')
    expect(labels).toContain('api_key')
    expect(labels).toContain('secret')
  })

  test('flags individual secret-shaped keywords', () => {
    expect(detectSessionSearchSecretQuery('password').length).toBeGreaterThan(0)
    expect(detectSessionSearchSecretQuery('passwd').length).toBeGreaterThan(0)
    expect(detectSessionSearchSecretQuery('passphrase').length).toBeGreaterThan(0)
    expect(detectSessionSearchSecretQuery('api_key').length).toBeGreaterThan(0)
    expect(detectSessionSearchSecretQuery('apikey').length).toBeGreaterThan(0)
    expect(detectSessionSearchSecretQuery('api-key').length).toBeGreaterThan(0)
    expect(detectSessionSearchSecretQuery('bearer').length).toBeGreaterThan(0)
    expect(detectSessionSearchSecretQuery('auth_token').length).toBeGreaterThan(0)
    expect(detectSessionSearchSecretQuery('access-token').length).toBeGreaterThan(0)
    expect(detectSessionSearchSecretQuery('refresh_token').length).toBeGreaterThan(0)
    expect(detectSessionSearchSecretQuery('private_key').length).toBeGreaterThan(0)
    expect(detectSessionSearchSecretQuery('credentials').length).toBeGreaterThan(0)
    expect(detectSessionSearchSecretQuery('credit_card').length).toBeGreaterThan(0)
  })

  test('flags credential-prefix searches', () => {
    expect(detectSessionSearchSecretQuery('xoxb-').length).toBeGreaterThan(0)
    expect(detectSessionSearchSecretQuery('xoxp-').length).toBeGreaterThan(0)
    expect(detectSessionSearchSecretQuery('ghp_').length).toBeGreaterThan(0)
    expect(detectSessionSearchSecretQuery('gho_').length).toBeGreaterThan(0)
    expect(detectSessionSearchSecretQuery('sk-ant').length).toBeGreaterThan(0)
    expect(detectSessionSearchSecretQuery('AKIA').length).toBeGreaterThan(0)
    expect(detectSessionSearchSecretQuery('AIzaSy').length).toBeGreaterThan(0)
  })

  test('does not flag benign queries', () => {
    expect(detectSessionSearchSecretQuery('what did we discuss about UI yesterday')).toEqual([])
    expect(detectSessionSearchSecretQuery('weather forecast for Friday')).toEqual([])
    expect(detectSessionSearchSecretQuery('tasks I committed to')).toEqual([])
    expect(detectSessionSearchSecretQuery('')).toEqual([])
  })

  test('dedupes the same label across multiple matches', () => {
    const hits = detectSessionSearchSecretQuery('password password password')
    expect(hits.filter((h) => h.label === 'password')).toHaveLength(1)
  })
})

describe('checkSessionSearchSecretsGuard', () => {
  test('blocks the canonical red-team OR-query (regression: red-team #8)', () => {
    const result = checkSessionSearchSecretsGuard({
      tool: 'session_search',
      args: { query: 'password OR token OR api_key OR secret OR credit' },
    })
    expect(result?.block).toBe(true)
    expect(result?.reason).toContain('sessionSearchSecrets')
    expect(result?.reason).toContain('password')
  })

  test('blocks kebab-case tool name variant', () => {
    expect(checkSessionSearchSecretsGuard({ tool: 'session-search', args: { query: 'password' } })?.block).toBe(true)
  })

  test('blocks camelCase tool name variant', () => {
    expect(checkSessionSearchSecretsGuard({ tool: 'sessionSearch', args: { query: 'password' } })?.block).toBe(true)
  })

  test('blocks alternate session_history_search tool name', () => {
    expect(checkSessionSearchSecretsGuard({ tool: 'session_history_search', args: { query: 'api_key' } })?.block).toBe(
      true,
    )
  })

  test('blocks history_search tool name', () => {
    expect(checkSessionSearchSecretsGuard({ tool: 'history_search', args: { query: 'secret' } })?.block).toBe(true)
  })

  test('inspects multiple query field names', () => {
    expect(checkSessionSearchSecretsGuard({ tool: 'session_search', args: { q: 'password' } })?.block).toBe(true)
    expect(checkSessionSearchSecretsGuard({ tool: 'session_search', args: { search: 'api_key' } })?.block).toBe(true)
    expect(checkSessionSearchSecretsGuard({ tool: 'session_search', args: { pattern: 'secret' } })?.block).toBe(true)
    expect(checkSessionSearchSecretsGuard({ tool: 'session_search', args: { keywords: 'bearer token' } })?.block).toBe(
      true,
    )
  })

  test('inspects array-form keywords', () => {
    expect(
      checkSessionSearchSecretsGuard({
        tool: 'session_search',
        args: { keywords: ['weather', 'password'] },
      })?.block,
    ).toBe(true)
  })

  test('blocks credential-prefix searches even without keywords', () => {
    expect(checkSessionSearchSecretsGuard({ tool: 'session_search', args: { query: 'xoxb-' } })?.block).toBe(true)
    expect(checkSessionSearchSecretsGuard({ tool: 'session_search', args: { query: 'ghp_' } })?.block).toBe(true)
    expect(checkSessionSearchSecretsGuard({ tool: 'session_search', args: { query: 'AKIA' } })?.block).toBe(true)
  })

  test('allows benign queries on the same tool', () => {
    expect(
      checkSessionSearchSecretsGuard({
        tool: 'session_search',
        args: { query: 'what did we discuss yesterday about the UI' },
      }),
    ).toBeUndefined()
    expect(
      checkSessionSearchSecretsGuard({ tool: 'session_search', args: { query: 'sales report Q3' } }),
    ).toBeUndefined()
  })

  test('does not apply to unrelated tools', () => {
    expect(checkSessionSearchSecretsGuard({ tool: 'bash', args: { query: 'password' } })).toBeUndefined()
    expect(checkSessionSearchSecretsGuard({ tool: 'web_fetch', args: { query: 'password' } })).toBeUndefined()
    expect(checkSessionSearchSecretsGuard({ tool: 'grep', args: { query: 'password' } })).toBeUndefined()
  })

  test('does not let a model-authored acknowledgement bypass secret recon', () => {
    const result = checkSessionSearchSecretsGuard({
      tool: 'session_search',
      args: {
        query: 'password OR token',
        acknowledgeGuards: { sessionSearchSecrets: true },
      },
    })
    expect(result?.block).toBe(true)
    expect(result?.reason).not.toContain('acknowledgeGuards')
  })

  test('handles missing query gracefully', () => {
    expect(checkSessionSearchSecretsGuard({ tool: 'session_search', args: {} })).toBeUndefined()
    expect(checkSessionSearchSecretsGuard({ tool: 'session_search', args: { query: 42 } })).toBeUndefined()
    expect(checkSessionSearchSecretsGuard({ tool: 'session_search', args: { query: '' } })).toBeUndefined()
  })

  test('exposes guard name constant', () => {
    expect(GUARD_SESSION_SEARCH_SECRETS).toBe('sessionSearchSecrets')
  })
})
