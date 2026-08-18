import path from 'node:path'

import type { SecuritySeverity } from '../permissions'
import type { SecurityBlock } from '../policy'

export const GUARD_SECRET_EXFIL_READ = 'secretExfilRead'
// Classified `medium` (silent-attack axis): bypass returns `.env` /
// credential-file contents into model context. Same shape as
// secretExfilBash — silent at the moment of read, becomes catastrophic on
// the next channel-side tool call that quotes it.
export const GUARD_SECRET_EXFIL_READ_SEVERITY: SecuritySeverity = 'medium'

const SENSITIVE_BASENAMES = new Set([
  '.env',
  '.envrc',
  '.netrc',
  '.pgpass',
  'credentials',
  'credentials.json',
  'credentials.yaml',
  'credentials.yml',
  'service-account.json',
  'gha-creds.json',
  'token.json',
  'secrets.json',
])

const SENSITIVE_BASENAME_PATTERNS: ReadonlyArray<RegExp> = [
  /^\.env\.[^/\\]+$/,
  /^id_(?:rsa|ed25519|ecdsa|dsa)(?:\.pub)?$/,
]

const SENSITIVE_DIRECTORY_SEGMENTS = [
  '.ssh',
  '.gnupg',
  '.aws',
  '.docker',
  '.kube',
  '.hermes',
  '.config/gh',
  '.config/hub',
  '.config/sops',
  '.config/op',
  '.config/hermes',
]

const HISTORY_BASENAMES = new Set([
  '.bash_history',
  '.zsh_history',
  '.python_history',
  '.node_repl_history',
  '.lesshst',
  '.viminfo',
  '.mysql_history',
  '.psql_history',
])

const PATH_LIKE_KEYS = ['path', 'paths', 'pattern', 'patterns', 'glob', 'globs', 'cwd', 'dir', 'directory']

export function checkSecretExfilReadGuard(options: {
  tool: string
  args: Record<string, unknown>
}): SecurityBlock | undefined {
  const { tool, args } = options
  if (tool !== 'read' && tool !== 'grep' && tool !== 'find' && tool !== 'ls') return undefined
  for (const key of PATH_LIKE_KEYS) {
    const value = args[key]
    const candidates = collectStringValues(value)
    for (const candidate of candidates) {
      const reason = classifySensitivePath(candidate)
      if (reason) {
        return {
          block: true,
          reason: [
            `Guard \`${GUARD_SECRET_EXFIL_READ}\` blocked ${tool} of ${reason}: ${candidate}.`,
            'Reading secret material is treated as exfiltration even when the agent only intends to inspect it.',
            'Intentional access requires an operator-configured security bypass permission.',
          ].join(' '),
        }
      }
    }
  }
  return undefined
}

function collectStringValues(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string')
  return []
}

function classifySensitivePath(rawPath: string): string | undefined {
  const normalized = rawPath.replace(/\\/g, '/').replace(/^~\//, '/home/__user__/').replace(/^~/, '/home/__user__/')
  const basename = path.basename(normalized)

  if (SENSITIVE_BASENAMES.has(basename)) return `${basename} (credentials file)`
  if (HISTORY_BASENAMES.has(basename)) return `${basename} (shell history; may contain accidentally typed secrets)`
  for (const pat of SENSITIVE_BASENAME_PATTERNS) {
    if (pat.test(basename)) return `${basename} (looks like a credentials/secret file)`
  }

  const segments = normalized.split('/').filter((s) => s.length > 0)
  for (const seg of SENSITIVE_DIRECTORY_SEGMENTS) {
    const parts = seg.split('/')
    if (containsSubsequence(segments, parts)) return `${seg}/ (sensitive directory)`
  }

  if (/(?:^|\/)\.config\/[^/]+\/(?:credentials|token|secret|auth|cookies|session)/.test(normalized)) {
    return '~/.config/**/credentials-like file'
  }

  if (normalized.startsWith('/proc/') && normalized.endsWith('/environ')) {
    return '/proc/*/environ (process environment)'
  }

  return undefined
}

function containsSubsequence<T>(haystack: T[], needle: T[]): boolean {
  if (needle.length === 0) return false
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    let ok = true
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        ok = false
        break
      }
    }
    if (ok) return true
  }
  return false
}
