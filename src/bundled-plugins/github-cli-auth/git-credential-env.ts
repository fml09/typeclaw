export function buildGitCredentialEnv(token: string, askpassPath: string): Record<string, string> {
  return {
    TYPECLAW_GIT_TOKEN: token,
    GIT_ASKPASS: askpassPath,
    GIT_TERMINAL_PROMPT: '0',
    // Git applies local insteadOf rewrites after analysis; HTTPS-only blocks ext:: from inheriting the token.
    GIT_ALLOW_PROTOCOL: 'https',
    GIT_CONFIG_COUNT: '4',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: '/dev/null',
    GIT_CONFIG_KEY_1: 'credential.helper',
    GIT_CONFIG_VALUE_1: '',
    GIT_CONFIG_KEY_2: 'url.https://github.com/.insteadOf',
    GIT_CONFIG_VALUE_2: 'git@github.com:',
    GIT_CONFIG_KEY_3: 'url.https://github.com/.insteadOf',
    GIT_CONFIG_VALUE_3: 'ssh://git@github.com/',
  }
}

// Injection and clone-tail stripping share these keys so a new credential variable cannot leak into the tail shell.
export const GIT_CREDENTIAL_ENV_KEYS: readonly string[] = Object.freeze(Object.keys(buildGitCredentialEnv('', '')))
