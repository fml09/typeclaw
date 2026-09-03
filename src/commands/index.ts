// Returning nothing keeps the void contract — the dispatch layer then falls
// back to its static per-result-kind reply. A `reply` lets dynamic commands
// (/help) surface text the dispatcher could not have known statically.
export type CommandHandlerResult = void | { reply?: string }

export type CommandHandler<Context> = (
  context: Context,
  command: ParsedCommand,
) => Promise<CommandHandlerResult> | CommandHandlerResult

// `permission` and `requiresLiveSession` are command-level policy the dispatch
// layer (the channel router) enforces. They live on the command, not the
// dispatcher, so a new command declares its own requirements in one place:
// 'session.control' + requiresLiveSession:true is the control-command default
// (/stop); 'none' + requiresLiveSession:false is the informational default
// (/help). 'session.admin' + requiresLiveSession:false is the operate-the-agent
// tier (/reload, /restart) — owner+trusted only, no live session required since
// it acts on the container, not a channel turn. Both are optional so plain
// registries (tests, TUI) need not care.
export type CommandPermission = 'none' | 'session.control' | 'session.admin'

export type Command<Context> = {
  name: string
  aliases?: readonly string[]
  description: string
  permission?: CommandPermission
  requiresLiveSession?: boolean
  // Resolve an existing live session into the handler context WITHOUT failing
  // when none exists (distinct from `requiresLiveSession`, which aborts the
  // command if no session is live). Used by /restart: it must bounce the
  // container even from a cold channel, but when a session IS live it needs
  // that session's identity to write a resume handoff. Ignored when
  // `requiresLiveSession` is true (that path already resolves the session).
  wantsLiveSession?: boolean
  handler: CommandHandler<Context>
}

export type ParsedCommand = {
  name: string
  args: string
}

// Read-only view of a registered command, used to generate help text from the
// registry so the listing can never drift from the actual command set. Aliases
// are folded into the canonical entry rather than listed as separate commands.
export type CommandInfo = {
  name: string
  aliases: readonly string[]
  description: string
  permission: CommandPermission
  requiresLiveSession: boolean
  wantsLiveSession: boolean
}

export type CommandResult =
  | { kind: 'not-command' }
  | { kind: 'unknown-command'; name: string }
  | { kind: 'handled'; name: string; reply?: string }

export type CommandRegistry<Context> = {
  parse: (text: string) => ParsedCommand | null
  has: (name: string) => boolean
  get: (name: string) => CommandInfo | undefined
  list: () => readonly CommandInfo[]
  execute: (text: string, context: Context) => Promise<CommandResult>
}

// Plugin-contributed commands exist on the CHANNEL surface only
// (`PluginExports.channelCommands`). The channel router adapts each declaration
// into a `Command<ChannelCommandContext>` and appends it to its own list before
// building this registry — which is why the duplicate-name throw below is a
// runtime-owned invariant the router must pre-filter for, never a boot crash a
// third-party plugin can trigger. The TUI and CLI registries stay built-in-only.

export function createCommandRegistry<Context>(commands: readonly Command<Context>[]): CommandRegistry<Context> {
  const byName = new Map<string, Command<Context>>()
  for (const command of commands) {
    registerName(byName, command.name, command)
    for (const alias of command.aliases ?? []) {
      registerName(byName, alias, command)
    }
  }

  const info = (command: Command<Context>): CommandInfo => ({
    name: command.name,
    aliases: command.aliases ?? [],
    description: command.description,
    permission: command.permission ?? 'session.control',
    requiresLiveSession: command.requiresLiveSession ?? true,
    wantsLiveSession: command.wantsLiveSession ?? false,
  })

  return {
    parse: parseCommand,
    has: (name) => byName.has(name.toLowerCase()),
    get: (name) => {
      const command = byName.get(name.toLowerCase())
      return command ? info(command) : undefined
    },
    // Canonical commands only, in declaration order. Aliases resolve to the
    // same Command object, so de-dupe by identity to avoid duplicate rows.
    list: () => commands.map(info),
    execute: async (text, context) => {
      const parsed = parseCommand(text)
      if (parsed === null) return { kind: 'not-command' }
      const command = byName.get(parsed.name)
      if (!command) return { kind: 'unknown-command', name: parsed.name }
      const result = await command.handler(context, parsed)
      const reply = result?.reply
      return reply !== undefined
        ? { kind: 'handled', name: command.name, reply }
        : { kind: 'handled', name: command.name }
    },
  }
}

export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return null

  const body = trimmed.slice(1)
  const match = /^(?<name>[a-z][a-z0-9_-]*)(?:\s+(?<args>[\s\S]*))?$/i.exec(body)
  if (!match?.groups) return null

  return {
    name: match.groups.name!.toLowerCase(),
    args: match.groups.args ?? '',
  }
}

function registerName<Context>(
  byName: Map<string, Command<Context>>,
  rawName: string,
  command: Command<Context>,
): void {
  const name = rawName.toLowerCase()
  if (byName.has(name)) {
    throw new Error(`duplicate command: ${name}`)
  }
  byName.set(name, command)
}
