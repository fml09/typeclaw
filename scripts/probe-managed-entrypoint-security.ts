import { lstatSync, readFileSync, readlinkSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

import { exportClaudeCredentialsFileIfApplicable } from '../src/secrets/export-claude-credentials-file'
import type { Providers } from '../src/secrets/schema'

const customConfigDir = process.env['CLAUDE_CONFIG_DIR']?.trim()
if (!customConfigDir) {
  throw new Error('CLAUDE_CONFIG_DIR was not loaded from the Agent Folder .env')
}
if (!customConfigDir.startsWith('/agent/')) {
  throw new Error(`security probe requires a model-visible /agent path, got ${customConfigDir}`)
}

const runtimeHome = process.env['HOME']
if (!runtimeHome) throw new Error('managed runtime HOME is missing')

const aliasPath = join(customConfigDir, '.credentials.json')
const realPath = join(runtimeHome, '.claude', '.credentials.json')
if (!lstatSync(aliasPath).isSymbolicLink()) {
  throw new Error(`entrypoint did not create the Claude credential alias at ${aliasPath}`)
}
if (readlinkSync(aliasPath) !== realPath) {
  throw new Error(`Claude credential alias does not point into runtime HOME: ${readlinkSync(aliasPath)}`)
}

const providers: Providers = {
  anthropic: {
    type: 'oauth',
    access: 'managed-security-probe-access',
    refresh: 'managed-security-probe-refresh',
    expires: 4_102_444_800_000,
  },
}
const result = exportClaudeCredentialsFileIfApplicable({
  claudeCodeEnabled: true,
  providers,
  homeDir: runtimeHome,
})
if (result.action !== 'wrote' || result.path !== aliasPath) {
  throw new Error(`Claude credential exporter did not write through the alias: ${JSON.stringify(result)}`)
}

const after = lstatSync(aliasPath)
if (!after.isSymbolicLink() || readlinkSync(aliasPath) !== realPath) {
  throw new Error('Claude credential export replaced the model-visible alias')
}
const real = statSync(realPath)
if (!real.isFile() || (real.mode & 0o777) !== 0o600) {
  throw new Error(`real Claude credential must be a mode-0600 file, got ${(real.mode & 0o777).toString(8)}`)
}
if (typeof process.getuid === 'function' && real.uid !== process.getuid()) {
  throw new Error(`real Claude credential owner ${real.uid} does not match runtime uid ${process.getuid()}`)
}
const written = JSON.parse(readFileSync(realPath, 'utf8')) as {
  claudeAiOauth?: { accessToken?: string; refreshToken?: string }
}
if (
  written.claudeAiOauth?.accessToken !== 'managed-security-probe-access' ||
  written.claudeAiOauth.refreshToken !== 'managed-security-probe-refresh'
) {
  throw new Error('Claude credential bytes did not land at the runtime-HOME target')
}

// Do not leave even a synthetic refresh token behind for the subsequent boot.
unlinkSync(realPath)
