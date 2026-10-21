import { tmpdir } from "node:os"
import { join } from "node:path"
import { defineConfig } from "drizzle-kit"

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/**/*.sql.ts",
  out: "./migration",
  dbCredentials: {
    url: process.env.AXIOMSEC_DEV_DB ?? join(tmpdir(), "axiomsec-dev.db"),
  },
})
