export type GitRepoCredential = { repoSlug: string; token: string }
export type GitCredentialTransportOptions = {
  expectedRemote?: string
  pushUrls?: readonly string[]
  trustedEnv?: NodeJS.ProcessEnv
}

export function buildGitCredentialEnv(
  credentials: readonly GitRepoCredential[],
  askpassPath: string,
  options?: GitCredentialTransportOptions,
): Record<string, string>
export function buildGitCredentialEnv(
  token: string,
  askpassPath: string,
  expectedRepo?: string,
  expectedRemote?: string,
): Record<string, string>
export function buildGitCredentialEnv(
  credentialsOrToken: readonly GitRepoCredential[] | string,
  askpassPath: string,
  expectedRepoOrOptions?: GitCredentialTransportOptions | string,
  legacyExpectedRemote?: string,
): Record<string, string> {
  const expectedRepo = typeof expectedRepoOrOptions === 'string' ? expectedRepoOrOptions : undefined
  const options =
    typeof expectedRepoOrOptions === 'object'
      ? expectedRepoOrOptions
      : { expectedRemote: legacyExpectedRemote, trustedEnv: {} }
  const credentials = normalizeCredentials(credentialsOrToken, expectedRepo)
  const transport = resolveTrustedTransport(options.trustedEnv ?? {})
  const config: Array<[string, string]> = [
    ['core.hooksPath', '/dev/null'],
    ['credential.helper', ''],
    ['url.https://github.com/.insteadOf', 'git@github.com:'],
    ['url.https://github.com/.insteadOf', 'ssh://git@github.com/'],
    ['credential.useHttpPath', 'true'],
  ]
  const credentialUrls =
    options.pushUrls === undefined
      ? credentials.flatMap(({ repoSlug }) => [`https://github.com/${repoSlug}`, `https://github.com/${repoSlug}.git`])
      : options.pushUrls.map(normalizeGithubPushUrl)
  for (const url of new Set(credentialUrls)) {
    config.push(
      [`credential.${url}.helper`, ''],
      [`http.${url}.proxy`, transport.proxy],
      [`http.${url}.sslCAInfo`, transport.caInfo],
      [`http.${url}.sslVerify`, 'true'],
    )
  }
  if (options.expectedRemote !== undefined) config.push([`remote.${options.expectedRemote}.proxy`, transport.proxy])

  const credentialVariables: Record<string, string> =
    credentials.length === 1
      ? {
          TYPECLAW_GIT_TOKEN: credentials[0]?.token ?? '',
          TYPECLAW_GIT_EXPECTED_REPO: credentials[0]?.repoSlug ?? '',
        }
      : credentials.length > 1
        ? { TYPECLAW_GIT_CREDENTIALS: credentials.map(({ repoSlug, token }) => `${repoSlug}\t${token}`).join('\n') }
        : {}

  return {
    ...credentialVariables,
    GIT_ASKPASS: askpassPath,
    GIT_TERMINAL_PROMPT: '0',
    // Git applies local insteadOf rewrites after analysis; HTTPS-only blocks ext:: from inheriting the token.
    GIT_ALLOW_PROTOCOL: 'https',
    GIT_CONFIG_COUNT: String(config.length),
    ...Object.fromEntries(
      config.flatMap(([key, value], index) => [
        [`GIT_CONFIG_KEY_${index}`, key],
        [`GIT_CONFIG_VALUE_${index}`, value],
      ]),
    ),
  }
}

function normalizeGithubPushUrl(raw: string): string {
  const url = raw.trim()
  const https = url.match(/^https:\/\/github\.com\/([^/\s:@]+)\/([^/\s?#]+?)(\.git)?\/?(?:[?#].*)?$/i)
  const scp = url.match(/^git@github\.com:([^/\s:?#]+)\/([^/\s?#]+?)(\.git)?$/i)
  const ssh = url.match(/^ssh:\/\/git@github\.com\/([^/\s]+)\/([^/\s?#]+?)(\.git)?\/?(?:[?#].*)?$/i)
  const match = https ?? scp ?? ssh
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new Error('invalid GitHub push URL')
  }
  return `https://github.com/${match[1]}/${match[2]}${match[3] ?? ''}`
}

function resolveTrustedTransport(env: NodeJS.ProcessEnv): {
  proxy: string
  caInfo: string
} {
  const proxy = firstDefined(env, ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'])
  const caInfo = firstNonEmpty(env, ['GIT_SSL_CAINFO', 'SSL_CERT_FILE', 'CURL_CA_BUNDLE'])
  return {
    proxy: proxy ?? '',
    caInfo: caInfo ?? '/etc/ssl/certs/ca-certificates.crt',
  }
}

function firstDefined(env: NodeJS.ProcessEnv, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    if (env[key] !== undefined) return env[key]
  }
  return undefined
}

function firstNonEmpty(env: NodeJS.ProcessEnv, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = env[key]
    if (value !== undefined && value !== '') return value
  }
  return undefined
}

function normalizeCredentials(
  credentialsOrToken: readonly GitRepoCredential[] | string,
  expectedRepo: string | undefined,
): GitRepoCredential[] {
  const source =
    typeof credentialsOrToken === 'string'
      ? expectedRepo === undefined
        ? []
        : [{ repoSlug: expectedRepo, token: credentialsOrToken }]
      : [...credentialsOrToken]
  return source.map((credential) => {
    const repoSlug = credential.repoSlug.toLocaleLowerCase().replace(/\.git$/i, '')
    if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repoSlug) || /[\t\r\n]/.test(credential.token)) {
      throw new Error('invalid repository credential')
    }
    return { repoSlug, token: credential.token }
  })
}

// Injection and clone-tail stripping share these keys so a new credential variable cannot leak into the tail shell.
export const GIT_CREDENTIAL_ENV_KEYS: readonly string[] = Object.freeze([
  ...new Set([
    ...Object.keys(buildGitCredentialEnv('', '', 'owner/repo')),
    ...Object.keys(
      buildGitCredentialEnv(
        [
          { repoSlug: 'owner/repo', token: '' },
          { repoSlug: 'owner/other', token: '' },
        ],
        '',
      ),
    ),
  ]),
])
