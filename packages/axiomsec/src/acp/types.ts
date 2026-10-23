import type { McpServer } from "@agentclientprotocol/sdk/unstable"
import type { AxiomSecClient } from "@axiomsec/sdk/v2"
import type { ProviderID, ModelID } from "../providers/schema"

export interface ACPSessionState {
  id: string
  cwd: string
  mcpServers: McpServer[]
  createdAt: Date
  model?: {
    providerID: ProviderID
    modelID: ModelID
  }
  variant?: string
  modeId?: string
}

export interface ACPConfig {
  sdk: AxiomSecClient
  defaultModel?: {
    providerID: ProviderID
    modelID: ModelID
  }
}
