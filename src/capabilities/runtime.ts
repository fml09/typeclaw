import { dirname, join } from 'node:path'

import { type DeploymentProfile, resolveDeploymentProfile } from '@/container/controller'
import { createFileMcpOAuthStore, type McpOAuthStore, resolveContainerMcpOAuthStore } from '@/mcp'
import { createKeyStore, defaultKeyStoreDir } from '@/secrets/keys'
import {
  createFileSecretsProvider,
  type RuntimeSecretsProvider,
  resolveRuntimeSecretsProvider,
} from '@/secrets/secrets-provider'

import { createManagedRuntimeCredentialRenewer, type RuntimeCredentialRenewer } from './runtime-credential-renewer'
import {
  resolveHostdRuntimeRestarter,
  resolveManagedRuntimeRestarter,
  createUnavailableRuntimeRestarter,
  type RuntimeRestarter,
} from './runtime-restarter'

// The container-stage capability bag: what the agent runtime (`typeclaw run`)
// can CALL to reach durable host-side substrate. Assembled once at the
// container-stage composition root and passed to the modules that need it —
// build at the root, hand specific capabilities down (not a service locator).
//
// `secrets` is nullable: it degrades to null when no write-back backend is
// wired (the hostd triple is absent in host mode), so the runtime boots without
// crashing. restarter / portForwarder / ingress slot in here as they are
// extracted (see the capability-composition design).
export type RuntimeCapabilities = {
  deploymentProfile: DeploymentProfile
  secrets: RuntimeSecretsProvider | null
  mcpOAuthStore: McpOAuthStore
  // Host deployments keep renewal in hostd. Managed deployments have no
  // hostd, so their bound implementation runs inside the foreground runtime.
  // Optional preserves source compatibility for injected pre-renewer bags.
  credentialRenewer?: RuntimeCredentialRenewer | null
  // Optional preserves source compatibility for callers that constructed the
  // pre-managed `{ secrets }` bag themselves. The production composer always
  // sets this field to an adapter or null.
  restarter?: RuntimeRestarter | null
}

// Composes the container-stage capabilities. `secretsPath` is the mounted
// secrets.json the runtime reads (defaults to <cwd>/secrets.json, which is
// /agent/secrets.json in the container). Env is injectable for tests. The
// deployment profile is resolved once here so every runtime capability uses
// the same boot-time platform boundary.
export function createRuntimeCapabilities(
  env: NodeJS.ProcessEnv = process.env,
  secretsPath: string = join(process.cwd(), 'secrets.json'),
): RuntimeCapabilities {
  const profile = resolveDeploymentProfile(env)
  const agentDir = dirname(secretsPath)
  return {
    deploymentProfile: profile,
    secrets:
      profile === 'managed' ? createFileSecretsProvider(secretsPath) : resolveRuntimeSecretsProvider(env, secretsPath),
    mcpOAuthStore:
      profile === 'managed' ? createFileMcpOAuthStore(secretsPath) : resolveContainerMcpOAuthStore(env, secretsPath),
    credentialRenewer:
      profile === 'managed'
        ? createManagedRuntimeCredentialRenewer({
            agentDir,
            keyStore: createKeyStore({ keysDir: defaultKeyStoreDir(env) }),
          })
        : null,
    restarter:
      profile === 'managed'
        ? (resolveManagedRuntimeRestarter(env) ??
          createUnavailableRuntimeRestarter(
            'managed restart unavailable: TYPECLAW_RUNTIME_ID and TYPECLAW_MANAGED_CONTROL_DIR are required',
          ))
        : resolveHostdRuntimeRestarter(env),
  }
}
