import type { SecuritySeverity } from '../permissions'
import type { SecurityBlock } from '../policy'

export const GUARD_SECRET_EXFIL_BASH = 'secretExfilBash'
// Classified `medium` (silent-attack axis): bypass dumps the whole
// environment (every API key, every token) into the agent's tool-result
// buffer. No direct channel side effect — operator only sees on session
// review — but the secrets are now in model context and one channel_send
// away from a third-party audience. Silent at the moment of leak.
export const GUARD_SECRET_EXFIL_BASH_SEVERITY: SecuritySeverity = 'medium'

const DANGEROUS_COMMAND_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /(^|[\s;|&(`$])(env|printenv)([\s;|&)`]|$)/, label: 'env / printenv (full environment dump)' },
  // Interpreter-mediated env dumps: node/bun/deno reading process.env, python
  // reading os.environ, ruby reading ENV, perl reading %ENV. Each interpreter
  // has multiple invocation flags (-e, -c, --eval, etc.) and each language has
  // multiple ways to spell the same dump. We match the interpreter token plus
  // any later mention of the language's env object - shell parsing is not
  // worth the false-positive risk so we let the substring catch wrap, pipe,
  // and quote variants too.
  {
    pattern: /\b(?:node|bun|deno)\b[\s\S]{0,200}\bprocess\.env\b/,
    label: 'node/bun/deno process.env dump',
  },
  {
    pattern: /\bpython3?\b[\s\S]{0,200}\bos\.environ\b/,
    label: 'python os.environ dump',
  },
  { pattern: /\bruby\b[\s\S]{0,200}\bENV\b/, label: 'ruby ENV dump' },
  { pattern: /\bperl\b[\s\S]{0,200}%ENV\b/, label: 'perl %ENV dump' },
  // awk has a built-in ENVIRON hash. The canonical exfil one-liner is
  // `awk 'BEGIN{for (k in ENVIRON) print k"="ENVIRON[k]}'`, which evades the
  // env/printenv match above because the dangerous token is `ENVIRON`, not
  // `env`. Anchor on the awk command + the ENVIRON identifier in the same
  // command-line.
  { pattern: /\bawk\b[\s\S]{0,200}\bENVIRON\b/, label: 'awk ENVIRON dump' },
  // Shell builtins that print or list env-var names. `compgen -e` lists
  // exported names, `declare -p`/`-x` prints them with values, `export -p`
  // does the same. None of these contain the word `env` so the env/printenv
  // pattern misses all of them.
  { pattern: /(^|[\s;|&(`$])compgen\s+-[A-Za-z]*e/, label: 'compgen -e (env-var name listing)' },
  {
    pattern: /(^|[\s;|&(`$])declare\s+-[A-Za-z]*[pPx]/,
    label: 'declare -p / -x (exported env-var dump)',
  },
  { pattern: /(^|[\s;|&(`$])export\s+-p\b/, label: 'export -p (exported env-var dump)' },
  // `set` in POSIX mode dumps env vars; `set -o posix; set` is the canonical
  // exfil. We avoid blocking bare `set` (false-positive nightmare on
  // `set -e` / `set -euo pipefail`) and require the posix-mode opt-in.
  { pattern: /set\s+-o\s+posix[\s\S]{0,40}(?:^|[\s;|&(`])set(?:[\s;|&)`]|$)/m, label: 'set -o posix; set (env dump)' },
  {
    // jq/yq read+emit arbitrary files just like cat (e.g. `jq . .env`,
    // `yq '.x' .env`). `jq` ships in the container baseline; `yq` no longer
    // does, but a user can re-add it via `docker.file.append`, so both stay
    // gated here as first-class .env exfil vectors — not just the
    // pager/dumper family.
    pattern: /(cat|less|more|head|tail|bat|xxd|od|hexdump|strings|jq|yq)\s+[^\n;|&`]*\.env(\s|$|[;|&`])/,
    label: 'reading .env file',
  },
  {
    pattern: /(cat|less|more|head|tail|bat|jq|yq)\s+[^\n;|&`]*\.envrc(\s|$|[;|&`])/,
    label: 'reading .envrc file',
  },
  { pattern: /\.ssh\/(id_[a-z0-9]+|authorized_keys|known_hosts|config)/i, label: '~/.ssh/* private material' },
  {
    pattern: /(cat|less|more|head|tail|ls|find|grep|rg|bat)\s+[^\n;|&`]*~?\/?\.ssh(\/|\s|$|[;|&`])/,
    label: 'reading ~/.ssh/ directory',
  },
  { pattern: /\.aws\/(credentials|config)/i, label: '~/.aws/credentials' },
  { pattern: /\.docker\/config\.json/i, label: '~/.docker/config.json (registry auth)' },
  { pattern: /\.netrc/i, label: '~/.netrc (HTTP credentials)' },
  { pattern: /\.kube\/config/i, label: '~/.kube/config (cluster credentials)' },
  { pattern: /\.gnupg\//i, label: '~/.gnupg/ (PGP keys)' },
  { pattern: /\.config\/[^\s;|&`]*\/(credentials|token|secret|auth)/i, label: '~/.config/**/credentials-like file' },
  { pattern: /\.hermes\/config/i, label: '~/.hermes/config (agent credentials)' },
  { pattern: /\.config\/hermes\//i, label: '~/.config/hermes/ (agent credentials)' },
  { pattern: /\/proc\/\d*\/environ/, label: '/proc/*/environ' },
  { pattern: /\/proc\/self\/environ/, label: '/proc/self/environ' },
  { pattern: /find\s+[^\n;|&`]*-name\s+["']?\*?\.env/, label: 'find ... -name "*.env"' },
  { pattern: /find\s+[^\n;|&`]*-name\s+["']?credentials/i, label: 'find ... -name "credentials*"' },
  { pattern: /find\s+[^\n;|&`]*-name\s+["']?[^\n"';|&`]*secret/i, label: 'find ... -name "*secret*"' },
  { pattern: /find\s+[^\n;|&`]*-name\s+["']?id_(rsa|ed25519|ecdsa|dsa)/i, label: 'find ... -name "id_rsa"' },
  {
    pattern: /(grep|rg|ag)\s+[^\n;|&`]*-r[^\n;|&`]*(password|api[_-]?key|secret|token)/i,
    label: 'recursive grep for secrets',
  },
  { pattern: /\.bash_history|\.zsh_history|\.python_history|\.node_repl_history/, label: 'shell history files' },
  { pattern: /(curl|wget|fetch)\s+[^\n;|&`]*169\.254\.169\.254/, label: 'cloud metadata endpoint' },
  { pattern: /(curl|wget|fetch)\s+[^\n;|&`]*metadata\.google\.internal/, label: 'GCP metadata endpoint' },
]

export function checkSecretExfilBashGuard(options: {
  tool: string
  args: Record<string, unknown>
}): SecurityBlock | undefined {
  const { tool, args } = options
  if (tool !== 'bash') return undefined

  const command = args.command
  if (typeof command !== 'string') return undefined
  const matched = DANGEROUS_COMMAND_PATTERNS.find(({ pattern }) => pattern.test(command))
  if (!matched) return undefined

  return {
    block: true,
    reason: [
      `Guard \`${GUARD_SECRET_EXFIL_BASH}\` blocked bash command that looks like secret exfiltration: ${matched.label}.`,
      'Intentional access requires an operator-configured security bypass permission.',
    ].join(' '),
  }
}
