import { randomUUID } from 'node:crypto'
import { mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { sendHttp } from '@/hostd/client'

export type RuntimeRestartRequest = { build: boolean }
export type RuntimeRestartResult = { ok: true } | { ok: false; reason: string }

// A bound self-restart capability. Callers ask to replace the runtime they are
// already inside; transport credentials and platform object names stay inside
// the adapter. Acceptance is the boundary — replacement completion belongs to
// the host daemon or managed control plane.
export interface RuntimeRestarter {
  requestRestart(request: RuntimeRestartRequest): Promise<RuntimeRestartResult>
}

export type HostdRuntimeRestarterOptions = {
  hostdUrl: string
  restartToken: string
  containerName: string
  ackTimeoutMs?: number
  send?: typeof sendHttp
}

const HOSTD_RESTART_ACK_TIMEOUT_MS = 5_000

export function createHostdRuntimeRestarter(options: HostdRuntimeRestarterOptions): RuntimeRestarter {
  const send = options.send ?? sendHttp
  return {
    async requestRestart({ build }): Promise<RuntimeRestartResult> {
      const reply = await send(
        { kind: 'restart', containerName: options.containerName, build },
        {
          url: options.hostdUrl,
          token: options.restartToken,
          timeoutMs: options.ackTimeoutMs ?? HOSTD_RESTART_ACK_TIMEOUT_MS,
        },
      )
      return reply.ok ? { ok: true } : { ok: false, reason: reply.reason }
    },
  }
}

export type ManagedFileRestarterOptions = {
  controlDir: string
  runtimeId: string
  createRequestId?: () => string
  now?: () => Date
}

export type ManagedRestartEnvelope = {
  schemaVersion: 1
  kind: 'restart'
  requestId: string
  runtimeId: string
  requestedAt: string
}

// Platform-neutral managed transport. A sidecar/controller watches the shared
// control volume and treats the final rename as an accepted replacement
// request. TypeClaw never needs Kubernetes credentials or workload RBAC.
export function createManagedFileRestarter(options: ManagedFileRestarterOptions): RuntimeRestarter {
  const createRequestId = options.createRequestId ?? randomUUID
  const now = options.now ?? (() => new Date())
  return {
    async requestRestart({ build }): Promise<RuntimeRestartResult> {
      if (build) {
        return {
          ok: false,
          reason: 'managed runtimes cannot rebuild their image; update the platform image reference instead',
        }
      }

      const requestId = createRequestId()
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(requestId)) {
        return { ok: false, reason: 'managed restart request id is not filesystem-safe' }
      }
      const envelope: ManagedRestartEnvelope = {
        schemaVersion: 1,
        kind: 'restart',
        requestId,
        runtimeId: options.runtimeId,
        requestedAt: now().toISOString(),
      }
      const finalPath = join(options.controlDir, `restart-${requestId}.json`)
      const tmpPath = join(options.controlDir, `.restart-${requestId}.${process.pid}.tmp`)
      try {
        await mkdir(options.controlDir, { recursive: true, mode: 0o700 })
        const control = await stat(options.controlDir)
        const mode = control.mode & 0o777
        if (!control.isDirectory() || mode !== 0o700) {
          return {
            ok: false,
            reason: `managed control directory must be a directory with mode 0700; got ${mode.toString(8).padStart(4, '0')}`,
          }
        }
        const runtimeUid = typeof process.getuid === 'function' ? process.getuid() : undefined
        if (runtimeUid !== undefined && control.uid !== runtimeUid) {
          return {
            ok: false,
            reason: `managed control directory must be owned by runtime uid ${runtimeUid}; got uid ${control.uid}`,
          }
        }
        await writeFile(tmpPath, `${JSON.stringify(envelope, null, 2)}\n`, {
          encoding: 'utf8',
          flag: 'wx',
          mode: 0o600,
        })
        await rename(tmpPath, finalPath)
        return { ok: true }
      } catch (err) {
        await unlink(tmpPath).catch(() => {})
        const reason = err instanceof Error ? err.message : String(err)
        return { ok: false, reason: `could not publish managed restart request: ${reason}` }
      }
    },
  }
}

export function resolveHostdRuntimeRestarter(
  env: NodeJS.ProcessEnv,
  options: { ackTimeoutMs?: number } = {},
): RuntimeRestarter | null {
  const hostdUrl = env.TYPECLAW_HOSTD_URL
  const restartToken = env.TYPECLAW_HOSTD_TOKEN
  const containerName = env.TYPECLAW_CONTAINER_NAME
  if (!hostdUrl || !restartToken || !containerName) return null
  return createHostdRuntimeRestarter({ hostdUrl, restartToken, containerName, ...options })
}

export function resolveManagedRuntimeRestarter(env: NodeJS.ProcessEnv): RuntimeRestarter | null {
  const controlDir = env.TYPECLAW_MANAGED_CONTROL_DIR
  const runtimeId = env.TYPECLAW_RUNTIME_ID
  if (!controlDir || !runtimeId) return null
  return createManagedFileRestarter({ controlDir, runtimeId })
}

export function createUnavailableRuntimeRestarter(reason: string): RuntimeRestarter {
  return {
    async requestRestart(): Promise<RuntimeRestartResult> {
      return { ok: false, reason }
    },
  }
}
