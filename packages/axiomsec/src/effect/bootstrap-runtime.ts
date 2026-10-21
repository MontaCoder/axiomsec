import { Layer, ManagedRuntime } from "effect"
import { memoMap } from "./run-service"

import { Plugin } from "@/plugins"
import { FileWatcher } from "@/files/watcher"
import { Format } from "@/formatters"
import { File } from "@/files"
import { Vcs } from "@/project"
import { Snapshot } from "@/snapshots"
import { Bus } from "@/events"
import * as Observability from "./observability"

export const BootstrapLayer = Layer.mergeAll(
  Plugin.defaultLayer,
  Format.defaultLayer,
  File.defaultLayer,
  FileWatcher.defaultLayer,
  Vcs.defaultLayer,
  Snapshot.defaultLayer,
  Bus.defaultLayer,
).pipe(Layer.provide(Observability.layer))

export const BootstrapRuntime = ManagedRuntime.make(BootstrapLayer, { memoMap })
