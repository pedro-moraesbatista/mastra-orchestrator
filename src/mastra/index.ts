import { Mastra } from "@mastra/core"
import { MastraCompositeStore, InMemoryDB, ObservabilityInMemory } from "@mastra/core/storage"
import { LibSQLStore } from "@mastra/libsql"
import { Observability, MastraStorageExporter } from "@mastra/observability"
import type { OpencodeClient } from "../opencode/client.ts"
import { createPlannerAgent, createReviewerAgent, createSupervisorAgent, createCoderAgent } from "./agents.ts"
import { createOrchestrationWorkflow, createDecisionLoopWorkflow } from "./workflows.ts"
import { createMcpClient, listRegisteredServers } from "./mcp.ts"
import { azureMcpClient } from "./mcp/azure.ts"
import { createDefaultWorkspace } from "./workspace.ts"
import { loadConfig } from "../config.ts"
import { connectOpencode } from "../opencode/client.ts"
import { logger } from "../logger.ts"

export interface CreateMastraOptions {
  client: OpencodeClient
  directory?: string
  model?: string
}

export async function createMastra(opts: CreateMastraOptions): Promise<Mastra> {
  const cfg = loadConfig()
  const model = opts.model ?? `${cfg.modelProvider}/${cfg.modelName}`

  const agentDeps = {
    client: opts.client,
    directory: opts.directory,
    model,
  }

  const libsqlStore = new LibSQLStore({
    id: "mastra-storage",
    url: "file:./orchestrator.db",
  })

  const observabilityDb = new InMemoryDB()
  const observabilityStore = new ObservabilityInMemory({ db: observabilityDb })

  const storage = new MastraCompositeStore({
    id: "mastra-composite",
    default: libsqlStore,
    domains: {
      observability: observabilityStore,
    },
  })

  const workspace = createDefaultWorkspace()

  const mcpServers = listRegisteredServers()
  let mcpTools: Record<string, any> = {}
  if (mcpServers.length > 0) {
    try {
      const mcpClient = createMcpClient()
      mcpTools = await mcpClient.listTools()
      logger.info("MCP tools loaded", { toolCount: Object.keys(mcpTools).length })
    } catch (err) {
      logger.warn("Failed to load MCP tools", { err: String(err) })
    }
  }

  try {
    const azureTools = await azureMcpClient.listTools()
    mcpTools = { ...mcpTools, ...azureTools }
    logger.info("Azure MCP tools loaded", { toolCount: Object.keys(azureTools).length })
  } catch (err) {
    logger.warn("Failed to load Azure MCP tools", { err: String(err) })
  }

  const azureMcpServers = azureMcpClient.toMCPServerProxies()

  const observability = new Observability({
    configs: {
      default: {
        serviceName: "mastra-orchestrator",
        exporters: [new MastraStorageExporter()],
      },
    },
  })

  return new Mastra({
    agents: {
      planner: createPlannerAgent(agentDeps, mcpTools),
      reviewer: createReviewerAgent(agentDeps, mcpTools),
      supervisor: createSupervisorAgent(agentDeps, mcpTools),
      coder: createCoderAgent(agentDeps, mcpTools),
    },
    workflows: {
      orchestration: createOrchestrationWorkflow(agentDeps),
      decisionLoop: createDecisionLoopWorkflow(agentDeps),
    },
    mcpServers: azureMcpServers,
    storage,
    observability,
    workspace,
    server: {
      port: cfg.mastra.port,
    },
  })
}

const handle = connectOpencode(loadConfig())
export const mastra = await createMastra({ client: handle.client })