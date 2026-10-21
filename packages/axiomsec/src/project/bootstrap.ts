import { Plugin } from "../plugins"
import { Format } from "../formatters"
import { File } from "../files"
import { Snapshot } from "../snapshots"
import * as Project from "./project"
import * as Vcs from "./vcs"
import { Bus } from "../events"
import { Command } from "../commands"
import { Instance } from "./instance"
import { Log } from "@/support"
import { FileWatcher } from "@/files/watcher"
import * as Effect from "effect/Effect"

export const InstanceBootstrap = Effect.gen(function* () {
  Log.Default.info("bootstrapping", { directory: Instance.directory })
  yield* Plugin.Service.use((svc) => svc.init())
  yield* Effect.all(
    [
      Format.Service,
      File.Service,
      FileWatcher.Service,
      Vcs.Service,
      Snapshot.Service,
    ].map((s) => Effect.forkDetach(s.use((i) => i.init()))),
  ).pipe(Effect.withSpan("InstanceBootstrap.init"))

  yield* Bus.Service.use((svc) =>
    svc.subscribeCallback(Command.Event.Executed, async (payload) => {
      if (payload.properties.name === Command.Default.INIT) {
        Project.setInitialized(Instance.project.id)
      }
    }),
  )
}).pipe(Effect.withSpan("InstanceBootstrap"))
