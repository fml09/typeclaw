import type { SecuritySeverity } from '../permissions'
import type { SecurityBlock } from '../policy'

export const GUARD_SESSION_SEARCH_SECRETS = 'sessionSearchSecrets'
// Classified `medium` (silent-attack axis): bypass returns secret-shaped
// session-search hits into the agent's tool-result buffer. The operator
// doesn't see the raw hits — the agent summarizes them — so the leak is
// silent from the operator's perspective even though it's a read tool.
// The hits then live in model context as a precondition for a later
// channel_send leak; outboundSecret would catch the actual send, but
// silent-recon-then-summarize is its own attack shape.
export const GUARD_SESSION_SEARCH_SECRETS_SEVERITY: SecuritySeverity = 'medium'

const SESSION_SEARCH_TOOLS: ReadonlySet<string> = new Set([
  'session_search',
  'session-search',
  'sessionSearch',
  'session_history_search',
  'sessionHistorySearch',
  'history_search',
  'historySearch',
])

const QUERY_KEYS: ReadonlyArray<string> = ['query', 'q', 'search', 'pattern', 'keywords', 'text']

const SECRET_KEYWORD_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /\bpassword\b/i, label: 'password' },
  { pattern: /\bpasswd\b/i, label: 'passwd' },
  { pattern: /\bpassphrase\b/i, label: 'passphrase' },
  { pattern: /\bapi[_-]?keys?\b/i, label: 'api_key' },
  { pattern: /\bapikey\b/i, label: 'apikey' },
  { pattern: /\bsecret(?:s|_key)?\b/i, label: 'secret' },
  { pattern: /\bbearer\b/i, label: 'bearer' },
  { pattern: /\bauth[_-]?token\b/i, label: 'auth_token' },
  { pattern: /\baccess[_-]?token\b/i, label: 'access_token' },
  { pattern: /\brefresh[_-]?token\b/i, label: 'refresh_token' },
  { pattern: /\bprivate[_-]?key\b/i, label: 'private_key' },
  { pattern: /\bcredentials?\b/i, label: 'credentials' },
  { pattern: /\bcredit[_-]?card\b/i, label: 'credit_card' },
  { pattern: /\bxox[baprs]-/i, label: 'slack token prefix' },
  { pattern: /\bghp_/i, label: 'github PAT prefix' },
  { pattern: /\bgho_/i, label: 'github OAuth prefix' },
  { pattern: /\bsk-(?:ant|proj)?/i, label: 'openai/anthropic key prefix' },
  { pattern: /\bAKIA\b/, label: 'AWS access key prefix' },
  { pattern: /\bAIza[A-Za-z0-9]/, label: 'Google API key prefix' },
]

export function detectSessionSearchSecretQuery(query: string): ReadonlyArray<{ label: string }> {
  const hits: Array<{ label: string }> = []
  const seen = new Set<string>()
  for (const { pattern, label } of SECRET_KEYWORD_PATTERNS) {
    if (pattern.test(query) && !seen.has(label)) {
      seen.add(label)
      hits.push({ label })
    }
  }
  return hits
}

export function checkSessionSearchSecretsGuard(options: {
  tool: string
  args: Record<string, unknown>
}): SecurityBlock | undefined {
  const { tool, args } = options
  if (!SESSION_SEARCH_TOOLS.has(tool)) return undefined
  const queries = collectQueryStrings(args)
  for (const query of queries) {
    const hits = detectSessionSearchSecretQuery(query)
    if (hits.length === 0) continue
    const summary = hits.map((h) => h.label).join(', ')
    return {
      block: true,
      reason: [
        `Guard \`${GUARD_SESSION_SEARCH_SECRETS}\` blocked ${tool}: query targets credential-shaped keywords (${summary}).`,
        'Searching session history for secret-shaped strings is a recon pattern - even if the index returns no hits today, a future session that accidentally typed a credential will match.',
        'Intentional auditing requires an operator-configured security bypass permission.',
      ].join(' '),
    }
  }
  return undefined
}

function collectQueryStrings(args: Record<string, unknown>): string[] {
  const out: string[] = []
  for (const key of QUERY_KEYS) {
    const value = args[key]
    if (typeof value === 'string' && value.length > 0) out.push(value)
    else if (Array.isArray(value)) {
      for (const v of value) if (typeof v === 'string' && v.length > 0) out.push(v)
    }
  }
  return out
}
