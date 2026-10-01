import { MCPClient } from '@mastra/mcp'

export const azureMcpClient = new MCPClient({
  id: 'azure-mcp',
  servers: {
    azure: {
      command: 'npx',
      args: ['-y', '@azure/mcp@latest', 'server', 'start'],
      env: {
        AZURE_TOKEN_CREDENTIALS: 'InteractiveBrowserCredential',
      },
    },
  },
})