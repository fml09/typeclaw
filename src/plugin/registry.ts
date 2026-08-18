import { existsSync } from 'node:fs'

import { BUILTIN_COMMAND_NAMES } from '@/cli/builtins'
import type { CronJob, PromptJob } from '@/cron'

import { FIRST_PARTY_GUARD_ACKNOWLEDGEMENT_DECLARATIONS } from './guard-acknowledgements'
import type { HookBus } from './hooks'
import type {
  PluginCommand,
  PluginCronJob,
  PluginDoctorCheck,
  PluginExports,
  GuardAcknowledgementDeclaration,
  PluginLogger,
  PluginSkill,
  Subagent,
  Tool,
} from './types'
import { isPrimitiveZodObject } from './zod-introspect'

export type RegisteredTool = { pluginName: string; toolName: string; tool: Tool<any>; logger: PluginLogger }
export type RegisteredSubagent = { pluginName: string; subagentName: string; subagent: Subagent<any> }
export type RegisteredCronJob = { pluginName: string; localId: string; globalId: string; job: CronJob }
export type RegisteredSkillEntry = { pluginName: string; localName: string; skill: PluginSkill }
export type RegisteredSkillDir = { pluginName: string; path: string }
export type RegisteredDoctorCheck = {
  pluginName: string
  checkName: string
  pluginConfig: unknown
  logger: PluginLogger
  check: PluginDoctorCheck
}
export type RegisteredCommand = {
  pluginName: string
  commandName: string
  command: PluginCommand
  logger: PluginLogger
}
export type RegisteredPluginDisposer = {
  pluginName: string
  logger: PluginLogger
  dispose: () => void | Promise<void>
}

export type GuardAcknowledgementRegistry = ReadonlyMap<string, ReadonlySet<string>>

export type PluginRegistry = {
  tools: RegisteredTool[]
  subagents: RegisteredSubagent[]
  cronJobs: RegisteredCronJob[]
  skills: RegisteredSkillEntry[]
  skillsDirs: RegisteredSkillDir[]
  doctorChecks: RegisteredDoctorCheck[]
  commands: RegisteredCommand[]
  disposers: RegisteredPluginDisposer[]
  guardAcknowledgements: Map<string, Set<string>>
  guardAcknowledgementOwners: Map<string, string>
}

export type RegisterContributionsOptions = {
  pluginName: string
  logger: PluginLogger
  exports: PluginExports
  // Static commands declared on `DefinedPlugin.commands`. Passed alongside
  // `exports` because they live outside the factory's return value.
  commands?: Record<string, PluginCommand>
  guardAcknowledgements?: readonly GuardAcknowledgementDeclaration[]
  registry: PluginRegistry
  hooks: HookBus
  agentDir: string
  pluginConfig: unknown
}

const COMMAND_NAME_REGEX = /^[a-z][a-z0-9-]*$/

// CLI subcommands plugins MUST NOT shadow. Derived from BUILTIN_COMMAND_NAMES
// so cli/index.ts and registry.ts cannot drift apart.
export const RESERVED_COMMAND_NAMES: ReadonlySet<string> = new Set(BUILTIN_COMMAND_NAMES)

export function buildPluginCronGlobalId(pluginName: string, localId: string): string {
  return `__plugin_${pluginName}_${localId}`
}

export function registerContributions(opts: RegisterContributionsOptions): void {
  const { pluginName, logger, exports: ex, registry, hooks, agentDir, pluginConfig } = opts

  registerGuardAcknowledgements(pluginName, opts.guardAcknowledgements ?? [], registry)

  if (ex.tools) {
    for (const [toolName, tool] of Object.entries(ex.tools)) {
      assertNotEmpty('tool name', toolName, pluginName)
      const conflict = registry.tools.find((t) => t.toolName === toolName)
      if (conflict) {
        throw new Error(`plugin ${pluginName}: tool "${toolName}" already registered by plugin ${conflict.pluginName}`)
      }
      registry.tools.push({ pluginName, toolName, tool, logger })
    }
  }

  if (ex.subagents) {
    for (const [subagentName, subagent] of Object.entries(ex.subagents)) {
      assertNotEmpty('subagent name', subagentName, pluginName)
      const conflict = registry.subagents.find((s) => s.subagentName === subagentName)
      if (conflict) {
        throw new Error(
          `plugin ${pluginName}: subagent "${subagentName}" already registered by plugin ${conflict.pluginName}`,
        )
      }
      registry.subagents.push({ pluginName, subagentName, subagent })
    }
  }

  if (ex.cronJobs) {
    for (const [localId, spec] of Object.entries(ex.cronJobs)) {
      assertNotEmpty('cron job id', localId, pluginName)
      const globalId = buildPluginCronGlobalId(pluginName, localId)
      const conflict = registry.cronJobs.find((j) => j.globalId === globalId)
      if (conflict) {
        throw new Error(
          `plugin ${pluginName}: cron job "${localId}" globalId "${globalId}" conflicts with plugin ${conflict.pluginName}`,
        )
      }
      const job = toCronJob(globalId, spec)
      registry.cronJobs.push({ pluginName, localId, globalId, job })
    }
  }

  if (ex.skills) {
    for (const [localName, skill] of Object.entries(ex.skills)) {
      assertNotEmpty('skill name', localName, pluginName)
      const conflict = registry.skills.find((s) => s.localName === localName)
      if (conflict) {
        throw new Error(
          `plugin ${pluginName}: skill "${localName}" already registered by plugin ${conflict.pluginName}`,
        )
      }
      registry.skills.push({ pluginName, localName, skill })
    }
  }

  if (ex.skillsDirs) {
    for (const path of ex.skillsDirs) {
      if (!existsSync(path)) {
        logger.warn(`skillsDirs entry does not exist on disk: ${path}`)
      }
      registry.skillsDirs.push({ pluginName, path })
    }
  }

  if (ex.hooks) {
    hooks.registerAll(pluginName, agentDir, logger, ex.hooks)
  }

  if (ex.doctorChecks) {
    for (const [checkName, check] of Object.entries(ex.doctorChecks)) {
      assertNotEmpty('doctor check name', checkName, pluginName)
      const conflict = registry.doctorChecks.find((c) => c.pluginName === pluginName && c.checkName === checkName)
      if (conflict) {
        throw new Error(`plugin ${pluginName}: doctor check "${checkName}" already registered`)
      }
      registry.doctorChecks.push({ pluginName, checkName, pluginConfig, logger, check })
    }
  }

  if (opts.commands) {
    for (const [commandName, command] of Object.entries(opts.commands)) {
      validateCommandDeclaration(pluginName, commandName, command)
      const conflict = registry.commands.find((c) => c.commandName === commandName)
      if (conflict) {
        throw new Error(
          `plugin ${pluginName}: command "${commandName}" already registered by plugin ${conflict.pluginName}`,
        )
      }
      registry.commands.push({ pluginName, commandName, command, logger })
    }
  }

  if (ex.onDispose) {
    registry.disposers.push({ pluginName, logger, dispose: ex.onDispose })
  }
}

export function discardRegistrationsBy(pluginName: string, registry: PluginRegistry, hooks: HookBus): void {
  registry.tools = registry.tools.filter((t) => t.pluginName !== pluginName)
  registry.subagents = registry.subagents.filter((s) => s.pluginName !== pluginName)
  registry.cronJobs = registry.cronJobs.filter((j) => j.pluginName !== pluginName)
  registry.skills = registry.skills.filter((s) => s.pluginName !== pluginName)
  registry.skillsDirs = registry.skillsDirs.filter((d) => d.pluginName !== pluginName)
  registry.doctorChecks = registry.doctorChecks.filter((d) => d.pluginName !== pluginName)
  registry.commands = registry.commands.filter((c) => c.pluginName !== pluginName)
  registry.disposers = registry.disposers.filter((d) => d.pluginName !== pluginName)
  for (const [key, owner] of registry.guardAcknowledgementOwners) {
    if (owner !== pluginName) continue
    registry.guardAcknowledgementOwners.delete(key)
    for (const [tool, keys] of registry.guardAcknowledgements) {
      keys.delete(key)
      if (keys.size === 0) registry.guardAcknowledgements.delete(tool)
    }
  }
  hooks.unregisterAll(pluginName)
}

export function emptyRegistry(): PluginRegistry {
  const registry: PluginRegistry = {
    tools: [],
    subagents: [],
    cronJobs: [],
    skills: [],
    skillsDirs: [],
    doctorChecks: [],
    commands: [],
    disposers: [],
    guardAcknowledgements: new Map(),
    guardAcknowledgementOwners: new Map(),
  }
  registerGuardAcknowledgements('<first-party>', FIRST_PARTY_GUARD_ACKNOWLEDGEMENT_DECLARATIONS, registry)
  return registry
}

function registerGuardAcknowledgements(
  pluginName: string,
  declarations: readonly GuardAcknowledgementDeclaration[],
  registry: PluginRegistry,
): void {
  const additions: Array<{ key: string; tools: readonly string[] }> = []
  const declaredHere = new Set<string>()

  for (const declaration of declarations) {
    assertNotEmpty('guard acknowledgement key', declaration.key, pluginName)
    if (declaredHere.has(declaration.key)) {
      throw new Error(`plugin ${pluginName}: duplicate guard acknowledgement key "${declaration.key}"`)
    }
    const owner = registry.guardAcknowledgementOwners.get(declaration.key)
    if (owner !== undefined) {
      throw new Error(
        `plugin ${pluginName}: guard acknowledgement key "${declaration.key}" already declared by plugin ${owner}`,
      )
    }
    if (declaration.tools.length === 0) {
      throw new Error(`plugin ${pluginName}: guard acknowledgement "${declaration.key}" declares no tools`)
    }
    const tools = new Set<string>()
    for (const tool of declaration.tools) {
      assertNotEmpty('guard acknowledgement tool name', tool, pluginName)
      if (tools.has(tool)) {
        throw new Error(
          `plugin ${pluginName}: guard acknowledgement "${declaration.key}" declares duplicate tool "${tool}"`,
        )
      }
      tools.add(tool)
    }
    declaredHere.add(declaration.key)
    additions.push({ key: declaration.key, tools: [...tools] })
  }

  for (const declaration of additions) {
    registry.guardAcknowledgementOwners.set(declaration.key, pluginName)
    for (const tool of declaration.tools) {
      const keys = registry.guardAcknowledgements.get(tool) ?? new Set<string>()
      keys.add(declaration.key)
      registry.guardAcknowledgements.set(tool, keys)
    }
  }
}

function assertNotEmpty(kind: string, value: string, pluginName: string): void {
  if (value.length === 0) {
    throw new Error(`plugin ${pluginName}: empty ${kind}`)
  }
}

function assertValidCommandArgsSchema(pluginName: string, commandName: string, command: PluginCommand): void {
  if (command.args === undefined) return
  if (!isPrimitiveZodObject(command.args)) {
    throw new Error(
      `plugin ${pluginName}: command "${commandName}" args must be a z.object({...}) with primitive (string/number/boolean) leaves`,
    )
  }
}

// Reuses the same checks `registerContributions` runs at boot, so host-stage
// discovery and runtime registration agree on what is a valid command. Throws
// a precise error referencing the plugin and command; callers translate the
// error into a discovery `loadError` rather than failing the whole CLI.
export function validateCommandDeclaration(pluginName: string, commandName: string, command: PluginCommand): void {
  if (commandName.length === 0) {
    throw new Error(`plugin ${pluginName}: empty command name`)
  }
  if (!COMMAND_NAME_REGEX.test(commandName)) {
    throw new Error(
      `plugin ${pluginName}: command "${commandName}" does not match ${COMMAND_NAME_REGEX.source} (lowercase letters, digits, dashes; must start with a letter)`,
    )
  }
  if (RESERVED_COMMAND_NAMES.has(commandName)) {
    throw new Error(
      `plugin ${pluginName}: command "${commandName}" shadows a built-in typeclaw subcommand and cannot be registered`,
    )
  }
  assertValidCommandArgsSchema(pluginName, commandName, command)
}

function toCronJob(globalId: string, spec: PluginCronJob): CronJob {
  // Plugin-contributed jobs default to `owner` because they are part of the
  // agent's bundled (or operator-installed) runtime, not user-channel
  // schedules. Without this default they would resolve to `guest` and the
  // bundled memory dreaming cron (which writes memory/topics/, runs git, etc.)
  // would lose every security bypass. Hand-authored cron.json entries take
  // a different path and must declare scheduledByRole explicitly.
  const scheduledByRole: PromptJob['scheduledByRole'] = 'owner'
  if (spec.kind === 'prompt') {
    const job: PromptJob = {
      id: globalId,
      schedule: spec.schedule,
      enabled: spec.enabled ?? true,
      kind: 'prompt',
      prompt: spec.prompt,
      scheduledByRole,
      ...(spec.timezone !== undefined ? { timezone: spec.timezone } : {}),
      ...(spec.subagent !== undefined ? { subagent: spec.subagent } : {}),
      ...(spec.payload !== undefined ? { payload: spec.payload } : {}),
    }
    return job
  }
  if (spec.kind === 'exec') {
    return {
      id: globalId,
      schedule: spec.schedule,
      enabled: spec.enabled ?? true,
      kind: 'exec',
      command: spec.command,
      scheduledByRole,
      ...(spec.timezone !== undefined ? { timezone: spec.timezone } : {}),
    }
  }
  return {
    id: globalId,
    schedule: spec.schedule,
    enabled: spec.enabled ?? true,
    kind: 'handler',
    handler: spec.handler,
    scheduledByRole,
    ...(spec.timezone !== undefined ? { timezone: spec.timezone } : {}),
  }
}
