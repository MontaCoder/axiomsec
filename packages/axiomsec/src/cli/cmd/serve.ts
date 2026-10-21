import { Server } from "../../server/server"
import { cmd } from "./cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "../../flags/flag"

export const ServeCommand = cmd({
  command: "serve",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "starts a headless axiomsec server",
  handler: async (args) => {
    const opts = await resolveNetworkOptions(args)
    if (!Flag.AXIOMSEC_SERVER_PASSWORD && !isLoopbackHostname(opts.hostname)) {
      console.error(
        `Error: refusing to bind ${opts.hostname} without AXIOMSEC_SERVER_PASSWORD. Set the password or bind to 127.0.0.1.`,
      )
      process.exit(1)
    }
    if (!Flag.AXIOMSEC_SERVER_PASSWORD) {
      console.log("Warning: AXIOMSEC_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const server = await Server.listen(opts)
    console.log(`axiomsec server listening on http://${server.hostname}:${server.port}`)

    await new Promise(() => {})
    await server.stop()
  },
})

function isLoopbackHostname(hostname: string) {
  const host = hostname.trim().toLowerCase()
  if (host === "localhost" || host === "::1" || host === "[::1]") return true
  return /^127(?:\.\d{1,3}){3}$/.test(host)
}
