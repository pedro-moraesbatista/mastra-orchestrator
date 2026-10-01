import { MCPClient } from "@mastra/mcp"
import { logger } from "../logger.ts"

export interface McpServerConfig {
  id: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  requireToolApproval?: boolean | ((params: { toolName: string }) => boolean)
}

const mcpServers: Record<string, McpServerConfig> = {}

export function registerMcpServer(config: McpServerConfig): void {
  mcpServers[config.id] = config
  logger.info("MCP server registered", { serverId: config.id })
}

export function listRegisteredServers(): McpServerConfig[] {
  return Object.values(mcpServers)
}

export function removeMcpServer(id: string): void {
  delete mcpServers[id]
  logger.info("MCP server removed", { serverId: id })
}

export function createMcpClient(): MCPClient {
  const servers: Record<string, any> = {}

  for (const [id, config] of Object.entries(mcpServers)) {
    if (config.command) {
      servers[id] = {
        command: config.command,
        args: config.args ?? [],
        env: config.env,
        requireToolApproval: config.requireToolApproval,
      }
    } else if (config.url) {
      servers[id] = {
        url: new URL(config.url),
        requestInit: config.headers ? { headers: config.headers } : undefined,
        requireToolApproval: config.requireToolApproval,
      }
    }
  }

  return new MCPClient({
    id: "orchestrator-mcp",
    servers,
  })
}

loadMcpFromEnv()

function loadMcpFromEnv(): void {
  const raw = process.env.MCP_SERVERS
  if (!raw) return
  try {
    const parsed = JSON.parse(raw) as Record<string, McpServerConfig>
    for (const [id, config] of Object.entries(parsed)) {
      registerMcpServer({ ...config, id })
    }
  } catch (err) {
    logger.warn("Failed to parse MCP_SERVERS env var", { err: String(err) })
  }
}