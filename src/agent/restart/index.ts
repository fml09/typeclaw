import { basename } from 'node:path'

import { acquireRestartHandoffLock, type RestartHandoffOrigin, writeRestartHandoff } from '@/agent/restart-handoff'
import { createHostdRuntimeRestarter, type RuntimeRestarter } from '@/capabilities'
import type { Stream } from '@/stream'

const ACK_TIMEOUT_MS = 5_000

export type ContainerRestartingBroadcast = {
  kind: 'container-restarting'
  restartedAt: string
  originatingSessionId: string
}

export type RequestContainerRestartOptions = {
  containerName: string
  build?: boolean
  hostdUrl?: string
  hostdToken?: string
  ackTimeoutMs?: number
  // Bound runtime replacement capability. Managed platforms inject this; when
  // omitted, the legacy hostd env/options below remain the compatibility path.
  restarter?: RuntimeRestarter | null
  // When present together with originatingSessionId, the post-ACK
  // container-restarting broadcast is published here so every live session's
  // subscribeRestartNotice fans out the restart notice (originator gets
  // typeclaw.restart-self, siblings get typeclaw.restart). Both the tool and
  // the server /restart path route through this so the broadcast->handoff
  // ordering lives in one place.
  stream?: Stream
  agentDir?: string
  originatingSessionId?: string
  originatingSessionFile?: string
  // Origin metadata persisted into the handoff so the next boot routes the
  // resume to the right subsystem (tui → websocket open; channel → router
  // startup). Required alongside agentDir + originatingSessionFile for the
  // handoff to be written; omitting it skips the handoff entirely.
  handoffOrigin?: RestartHandoffOrigin
  // Author of the inbound that owned the restarting session, carried so the
  // reopened channel session re-seeds the requester's identity on its resume
  // turn (see RestartHandoff.triggeringAuthorId).
  triggeringAuthorId?: string
  restartedAt?: string
}

export type RequestContainerRestartResult =
  | { ok: true; containerName: string; restartedAt: string }
  | { ok: false; containerName: string; reason: string }

export async function requestContainerRestart({
  containerName,
  build,
  hostdUrl,
  hostdToken,
  ackTimeoutMs,
  restarter,
  stream,
  agentDir,
  originatingSessionId,
  originatingSessionFile,
  handoffOrigin,
  triggeringAuthorId,
  restartedAt,
}: RequestContainerRestartOptions): Promise<RequestContainerRestartResult> {
  const httpUrl = hostdUrl ?? process.env.TYPECLAW_HOSTD_URL
  const httpToken = hostdToken ?? process.env.TYPECLAW_HOSTD_TOKEN
  const ackBudget = ackTimeoutMs ?? ACK_TIMEOUT_MS

  // HTTP/TCP is the only container->hostd transport (TYPECLAW_HOSTD_URL/TOKEN,
  // injected by start.ts via host.docker.internal). There is no Unix-socket
  // fallback: the host run dir is never bind-mounted, so the old
  // `/run/typeclaw-host/hostd.sock` dial always silently failed — and on native
  // Windows the host transport is a named pipe, not a socket. Fail loud here
  // when the control env is absent (hostd unregistered/disabled).
  const runtimeRestarter =
    restarter !== undefined
      ? restarter
      : httpUrl && httpToken
        ? createHostdRuntimeRestarter({
            hostdUrl: httpUrl,
            restartToken: httpToken,
            containerName,
            ackTimeoutMs: ackBudget,
          })
        : null
  if (runtimeRestarter === null) {
    return {
      ok: false,
      containerName,
      reason:
        'host daemon control endpoint unavailable (TYPECLAW_HOSTD_URL/TYPECLAW_HOSTD_TOKEN not set); cannot request restart',
    }
  }
  const boundRestarter = runtimeRestarter
  const handoffTarget =
    agentDir !== undefined &&
    originatingSessionId !== undefined &&
    originatingSessionFile !== undefined &&
    handoffOrigin !== undefined
      ? { agentDir, originatingSessionId, originatingSessionFile, handoffOrigin }
      : undefined

  // Hold the handoff lock from BEFORE the ACK through our post-ACK write. hostd
  // fires `docker stop` → SIGTERM the instant it accepts, so the container's
  // SIGTERM writer can run while we are still mid-flight; the lock makes it wait
  // and then augment the exact handoff we commit here, instead of synthesizing
  // one for another session in the gap before our write lands.
  const releaseHandoffLock =
    handoffTarget !== undefined ? await acquireRestartHandoffLock(handoffTarget.agentDir) : undefined
  try {
    return await performRestart()
  } finally {
    releaseHandoffLock?.()
  }

  async function performRestart(): Promise<RequestContainerRestartResult> {
    const reply = await boundRestarter.requestRestart({ build: build === true })

    if (!reply.ok) return { ok: false, containerName, reason: reply.reason }

    const restartTimestamp = restartedAt ?? new Date().toISOString()

    // Fan out the restart notice to every live session BEFORE writing the handoff.
    // The originating session's subscribeRestartNotice appends the
    // typeclaw.restart-self entry synchronously (broker delivery + the JSONL
    // append are both synchronous), so the handoff below points at a JSONL that
    // already carries the "I'm back" instruction the rebooted container hydrates.
    // Only after an accepted ACK, never on a failed/timed-out restart.
    if (stream !== undefined && originatingSessionId !== undefined) {
      const broadcast: ContainerRestartingBroadcast = {
        kind: 'container-restarting',
        restartedAt: restartTimestamp,
        originatingSessionId,
      }
      stream.publish({ target: { kind: 'broadcast' }, payload: broadcast })
    }

    // Post-ACK: hostd has committed the restart, so a handoff-write failure must
    // never demote it to a failure — that would render a false error in the TUI
    // and swallow the accepted response. The handoff is a best-effort resume hint
    // only; a missing one just cold-starts the rebooted container without the
    // "I'm back" greeting. writeRestartHandoff swallows its own errors today, but
    // guard here too so this contract survives the writer being changed later.
    if (handoffTarget !== undefined) {
      try {
        await writeRestartHandoff(handoffTarget.agentDir, {
          schemaVersion: 2,
          restartedAt: restartTimestamp,
          originatingSessionId: handoffTarget.originatingSessionId,
          originatingSessionFile: basename(handoffTarget.originatingSessionFile),
          origin: handoffTarget.handoffOrigin,
          ...(triggeringAuthorId !== undefined ? { triggeringAuthorId } : {}),
        })
      } catch {
        // intentional swallow — see the post-ACK rationale above
      }
    }

    return { ok: true, containerName, restartedAt: restartTimestamp }
  }
}
