import type { GithubTokenResolveResult } from '@/channels/github-token-bridge'

import { ensureGitAskPassHelper } from '../github-cli-auth/git-askpass'
import { parseGithubRepoFromGitUrl } from '../github-cli-auth/git-command'
import { shouldMintAppToken } from '../github-cli-auth/token-class'

export type BackupGitAuthEnv = Record<string, string>

export type BackupPushAuthDeps = {
  hasAppTokenResolver: () => boolean
  ghToken: string | undefined
  resolveTokenForRepo: (repoSlug: string) => Promise<GithubTokenResolveResult>
  resolveOriginPushUrl: (cwd: string) => Promise<string | null>
  ensureAskPassHelper: () => Promise<string>
}

// The backup runner spawns git directly (not via the bash tool), so the
// `github-cli-auth` plugin's `tool.before` credential injection never fires for
// its push. Without this, App-auth agents push with no credentials and fail.
// A live App resolver is authoritative even when the process also carries an
// operator PAT: runtime backup always uses the repo-scoped App credential.
// Without a resolver, PAT/SSH/credential-helper setups keep using the runner's
// inherited process env.
export async function resolveBackupPushAuthEnv(
  cwd: string,
  deps: BackupPushAuthDeps,
): Promise<BackupGitAuthEnv | null> {
  const hasAppTokenResolver = deps.hasAppTokenResolver()
  if (!hasAppTokenResolver && !shouldMintAppToken(deps.ghToken, false)) return null

  const originUrl = await deps.resolveOriginPushUrl(cwd)
  if (originUrl === null) return null

  const slug = parseGithubRepoFromGitUrl(originUrl)
  if (slug === null) return null

  const token = await deps.resolveTokenForRepo(slug)
  if (token.kind !== 'token') return null

  const askpass = await deps.ensureAskPassHelper()

  // Token rides in TYPECLAW_GIT_TOKEN (read by the askpass helper), never in
  // argv/config. The insteadOf rewrites map ssh/scp github remotes to https so
  // the askpass credential applies; GIT_TERMINAL_PROMPT=0 fails fast instead of
  // hanging on a prompt. Mirrors github-cli-auth/index.ts.
  return {
    GIT_ASKPASS: askpass,
    TYPECLAW_GIT_TOKEN: token.token,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ALLOW_PROTOCOL: 'https',
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'url.https://github.com/.insteadOf',
    GIT_CONFIG_VALUE_1: 'git@github.com:',
    GIT_CONFIG_KEY_2: 'url.https://github.com/.insteadOf',
    GIT_CONFIG_VALUE_2: 'ssh://git@github.com/',
  }
}

export function makeDefaultAskPassEnsurer(): () => Promise<string> {
  return () => ensureGitAskPassHelper()
}
