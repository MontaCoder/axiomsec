import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"

const server = new McpServer({ name: "axiomsec-test-echo", version: "1.0.0" })

server.registerTool(
  "echo",
  {
    description: "Echo text back to the caller.",
    inputSchema: { text: z.string() },
  },
  async ({ text }) => ({
    content: [{ type: "text", text: `ECHO:${text}` }],
  }),
)

server.registerTool(
  "env",
  {
    description: "Read an environment variable.",
    inputSchema: { name: z.string() },
  },
  async ({ name }) => ({
    content: [{ type: "text", text: `ENV:${process.env[name] ?? "UNSET"}` }],
  }),
)

await server.connect(new StdioServerTransport())
