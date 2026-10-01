import { Workspace, LocalSandbox, LocalFilesystem, WORKSPACE_TOOLS } from "@mastra/core/workspace"
import { logger } from "../logger.ts"

export interface WorkspaceConfig {
  workingDirectory: string
  isolation?: "seatbelt" | "bwrap" | "none"
  allowNetwork?: boolean
  readOnlyPaths?: string[]
  requireApproval?: boolean
  disableShell?: boolean
}

export function createWorkspace(config: WorkspaceConfig): Workspace {
  const sandbox = new LocalSandbox({
    workingDirectory: config.workingDirectory,
    isolation: config.isolation === "none" ? undefined : config.isolation,
    nativeSandbox: config.isolation && config.isolation !== "none" ? {
      allowNetwork: config.allowNetwork ?? false,
      readOnlyPaths: config.readOnlyPaths,
    } : undefined,
  })

  const filesystem = new LocalFilesystem({
    basePath: config.workingDirectory,
  })

  const workspace = new Workspace({
    sandbox,
    filesystem,
    tools: {
      requireApproval: config.requireApproval ?? false,
      ...(config.disableShell ? { [WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND]: { enabled: false } } : {}),
    },
  })

  logger.info("Workspace created", { workingDirectory: config.workingDirectory })
  return workspace
}

export function createDefaultWorkspace(): Workspace {
  const dir = process.env.WORKSPACE_DIR ?? "./workspace"
  return createWorkspace({
    workingDirectory: dir,
    isolation: (process.env.WORKSPACE_ISOLATION as "seatbelt" | "bwrap" | "none" | undefined) ?? "none",
    allowNetwork: process.env.WORKSPACE_ALLOW_NETWORK === "true",
    requireApproval: process.env.WORKSPACE_REQUIRE_APPROVAL === "true",
    disableShell: process.env.WORKSPACE_DISABLE_SHELL === "true",
  })
}