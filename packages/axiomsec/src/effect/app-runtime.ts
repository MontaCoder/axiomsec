import { Layer, ManagedRuntime } from "effect"
import { attach, memoMap } from "./run-service"
import * as Observability from "./observability"

import { AppFileSystem } from "@axiomsec/shared/filesystem"
import { Bus } from "@/events"
import { Auth } from "@/auth"
import { Config } from "@/config"
import { Git } from "@/git"
import { Ripgrep } from "@/files/ripgrep"
import { FileTime } from "@/files/time"
import { File } from "@/files"
import { FileWatcher } from "@/files/watcher"
import { Storage } from "@/storage"
import { Snapshot } from "@/snapshots"
import { Plugin } from "@/plugins"
import { Provider } from "@/providers"
import { ProviderAuth } from "@/providers"
import { Agent } from "@/agent/agent"
import { Skill } from "@/skills"
import { Discovery } from "@/skills/discovery"
import { Question } from "@/question"
import { Permission } from "@/permissions"
import { Todo } from "@/session/todo"
import { Session } from "@/session"
import { SessionStatus } from "@/session/status"
import { SessionRunState } from "@/session/run-state"
import { SessionProcessor } from "@/session/processor"
import { SessionCompaction } from "@/session/compaction"
import { SessionRevert } from "@/session/revert"
import { SessionSummary } from "@/session/summary"
import { SessionPrompt } from "@/session/prompt"
import { Instruction } from "@/session/instruction"
import { LLM } from "@/session/llm"
import { MCP } from "@/mcp"
import { McpAuth } from "@/mcp/auth"
import { Command } from "@/commands"
import { Truncate } from "@/tools"
import { ToolRegistry } from "@/tools"
import { Format } from "@/formatters"
import { Project } from "@/project"
import { Vcs } from "@/project"
import { Worktree } from "@/worktrees"
import { Pty } from "@/terminal"
import { Installation } from "@/installer"
import { Npm } from "@axiomsec/shared/npm"

export const AppLayer = Layer.mergeAll(
  Npm.defaultLayer,
  AppFileSystem.defaultLayer,
  Bus.defaultLayer,
  Auth.defaultLayer,
  Config.defaultLayer,
  Git.defaultLayer,
  Ripgrep.defaultLayer,
  FileTime.defaultLayer,
  File.defaultLayer,
  FileWatcher.defaultLayer,
  Storage.defaultLayer,
  Snapshot.defaultLayer,
  Plugin.defaultLayer,
  Provider.defaultLayer,
  ProviderAuth.defaultLayer,
  Agent.defaultLayer,
  Skill.defaultLayer,
  Discovery.defaultLayer,
  Question.defaultLayer,
  Permission.defaultLayer,
  Todo.defaultLayer,
  Session.defaultLayer,
  SessionStatus.defaultLayer,
  SessionRunState.defaultLayer,
  SessionProcessor.defaultLayer,
  SessionCompaction.defaultLayer,
  SessionRevert.defaultLayer,
  SessionSummary.defaultLayer,
  SessionPrompt.defaultLayer,
  Instruction.defaultLayer,
  LLM.defaultLayer,
  MCP.defaultLayer,
  McpAuth.defaultLayer,
  Command.defaultLayer,
  Truncate.defaultLayer,
  ToolRegistry.defaultLayer,
  Format.defaultLayer,
  Project.defaultLayer,
  Vcs.defaultLayer,
  Worktree.defaultLayer,
  Pty.defaultLayer,
  Installation.defaultLayer,
).pipe(Layer.provideMerge(Observability.layer))

const rt = ManagedRuntime.make(AppLayer, { memoMap })
type Runtime = Pick<typeof rt, "runSync" | "runPromise" | "runPromiseExit" | "runFork" | "runCallback" | "dispose">
const wrap = (effect: Parameters<typeof rt.runSync>[0]) => attach(effect as never) as never

export const AppRuntime: Runtime = {
  runSync(effect) {
    return rt.runSync(wrap(effect))
  },
  runPromise(effect, options) {
    return rt.runPromise(wrap(effect), options)
  },
  runPromiseExit(effect, options) {
    return rt.runPromiseExit(wrap(effect), options)
  },
  runFork(effect) {
    return rt.runFork(wrap(effect))
  },
  runCallback(effect) {
    return rt.runCallback(wrap(effect))
  },
  dispose: () => rt.dispose(),
}
