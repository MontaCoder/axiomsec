export * from "./client.js"
export * from "./server.js"

import { createAxiomSecClient } from "./client.js"
import { createAxiomSecServer } from "./server.js"
import type { ServerOptions } from "./server.js"

export * as data from "./data.js"

export async function createAxiomSec(options?: ServerOptions) {
  const server = await createAxiomSecServer({
    ...options,
  })

  const client = createAxiomSecClient({
    baseUrl: server.url,
  })

  return {
    client,
    server,
  }
}
