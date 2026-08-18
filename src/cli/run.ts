import { defineCommand } from 'citty'

import { CONTAINER_PORT } from '@/container'
import { isInitialized } from '@/init'
import { startAgent } from '@/run'

import { errorLine } from './ui'

export const run = defineCommand({
  meta: {
    name: 'run',
    description: 'run the agent in the foreground (container stage)',
  },
  args: {
    port: {
      type: 'string',
      description: 'port to listen on (defaults to the fixed container-internal port)',
      default: String(CONTAINER_PORT),
    },
    prompt: {
      type: 'positional',
      description: 'initial prompt for the attached tui',
      required: false,
    },
    tui: {
      type: 'boolean',
      description: 'attach a local tui (default: auto, on when stdin is a tty)',
    },
    'no-tui': {
      type: 'boolean',
      description: 'never attach a local tui, stay headless',
    },
  },
  async run({ args }) {
    if (!isInitialized(process.cwd())) {
      console.error(errorLine('TypeClaw config file not found. Run `typeclaw init` first.'))
      process.exit(1)
    }

    const attachTui = resolveAttachTui({
      tui: args.tui,
      noTui: args['no-tui'],
      isTTY: Boolean(process.stdin.isTTY),
    })

    const { tuiPromise, stop } = await startAgent({
      port: Number(args.port),
      attachTui,
      initialPrompt: args.prompt,
    })

    const exit = (code: number): void => {
      process.exit(code)
    }
    const onSignal = (): void => {
      void shutdown({ stop, exit })
    }
    process.once('SIGINT', onSignal)

    if (tuiPromise) {
      await tuiPromise
      await shutdown({ stop, exit })
    }
  },
})

// Awaits `stop()` BEFORE exiting so async teardown side-effects (channel
// adapter teardown, in particular GitHub webhook deregistration) actually
// complete. SIGTERM is deliberately owned by startAgent: its handoff-first
// sequence must finish before teardown and process exit during a supervised
// container replacement. The CLI owns only interactive SIGINT here.
export async function shutdown(deps: {
  stop: () => void | Promise<void>
  exit: (code: number) => void
}): Promise<void> {
  try {
    await deps.stop()
    deps.exit(0)
  } catch {
    deps.exit(1)
  }
}

function resolveAttachTui({
  tui,
  noTui,
  isTTY,
}: {
  tui: boolean | undefined
  noTui: boolean | undefined
  isTTY: boolean
}): boolean {
  if (noTui) return false
  if (tui) return true
  return isTTY
}
