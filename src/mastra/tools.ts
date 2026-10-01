import { createTool } from "@mastra/core/tools"
import { z } from "zod"
import type { OpencodeClient } from "../opencode/client.ts"
import { createSessionManager } from "../opencode/sessions.ts"
import { createWorktree } from "../opencode/worktree.ts"

export interface ToolDeps {
  client: OpencodeClient
  directory?: string
}

const planSchema = z.object({
  goal: z.string(),
  analysis: z.string(),
  files: z.array(z.string()),
  steps: z.array(z.object({
    agent: z.string(),
    task: z.string(),
    requiresPermission: z.object({
      resource: z.string(),
      operation: z.string(),
      reason: z.string().optional(),
    }).optional(),
    dependsOn: z.array(z.number()).optional(),
  })),
  risks: z.array(z.string()),
})

const reviewSchema = z.object({
  approved: z.boolean(),
  findings: z.array(z.object({
    severity: z.enum(["low", "medium", "high", "critical"]),
    file: z.string().optional(),
    description: z.string(),
  })),
  summary: z.string(),
})

export type PlanResult = z.infer<typeof planSchema>
export type ReviewResult = z.infer<typeof reviewSchema>

function makeSessionManagerForDir(client: OpencodeClient, directory?: string) {
  return createSessionManager(client, directory)
}

export function makeTools(deps: ToolDeps) {
  const defaultSessions = createSessionManager(deps.client, deps.directory)

  function resolveSessions(directory?: string) {
    if (!directory || directory === deps.directory) return defaultSessions
    return makeSessionManagerForDir(deps.client, directory)
  }

  const runAgent = createTool({
    id: "runOpencodeAgent",
    description:
      "Delegate a task to an opencode agent. The agent runs in a dedicated session with filesystem, bash, and MCP tool access. Returns the agent's text output.",
    inputSchema: z.object({
      agentName: z.string().describe("opencode agent name: build, plan, general, explore, coder, etc."),
      instruction: z.string().describe("concise instruction for the agent (max 500 chars)"),
      directory: z.string().optional().describe("target repository directory for the agent to work in"),
    }),
    outputSchema: z.object({
      text: z.string(),
      sessionId: z.string(),
    }),
    execute: async (input) => {
      const sessions = resolveSessions(input.directory)
      const session = await sessions.create(`mastra:${input.agentName}`)
      const text = await sessions.prompt(session.id, input.instruction, { agent: input.agentName })
      return { text, sessionId: session.id }
    },
  })

  const planTask = createTool({
    id: "planTask",
    description:
      "Ask the planner agent to analyze a task and produce a structured plan with steps, dependencies, and risk assessment.",
    inputSchema: z.object({
      taskDescription: z.string(),
      directory: z.string().optional().describe("target repository directory for the agent to analyze"),
    }),
    outputSchema: planSchema,
    execute: async (input) => {
      const sessions = resolveSessions(input.directory)
      const session = await sessions.create("mastra:planner")
      const prompt = [
        "You are the Planner. Respond with ONLY a JSON object matching this schema:",
        '{"goal":"...","analysis":"...","files":["..."],"steps":[{"agent":"coder","task":"...","dependsOn":[0]}],"risks":["..."]}',
        "",
        `Task: ${input.taskDescription}`,
      ].join("\n")
      const raw = await sessions.prompt(session.id, prompt, { agent: "planner" })
      const json = extractJson(raw)
      return planSchema.parse(JSON.parse(json))
    },
  })

  const reviewWork = createTool({
    id: "reviewWork",
    description:
      "Ask the reviewer agent to evaluate agent outputs against the original task. Returns approval, findings, and summary.",
    inputSchema: z.object({
      taskDescription: z.string(),
      planGoal: z.string(),
      agentOutputs: z.array(z.object({ agent: z.string(), text: z.string() })),
      directory: z.string().optional().describe("target repository directory for the reviewer to check"),
    }),
    outputSchema: reviewSchema,
    execute: async (input) => {
      const sessions = resolveSessions(input.directory)
      const session = await sessions.create("mastra:reviewer")
      const lines = [
        "You are the Reviewer. Respond with ONLY a JSON object matching this schema:",
        '{"approved":true,"findings":[{"severity":"low","file":"optional","description":"..."}],"summary":"..."}',
        "",
        `Task: ${input.taskDescription}`,
        `Plan goal: ${input.planGoal}`,
        "",
        "Agent outputs:",
        ...input.agentOutputs.flatMap((o: { agent: string; text: string }) => [`--- ${o.agent} ---`, o.text.slice(0, 4000)]),
      ]
      const raw = await sessions.prompt(session.id, lines.join("\n"), { agent: "reviewer" })
      const json = extractJson(raw)
      return reviewSchema.parse(JSON.parse(json))
    },
  })

  const listAgents = createTool({
    id: "listAgents",
    description: "List all available opencode agents with their capabilities.",
    inputSchema: z.object({
      directory: z.string().optional().describe("directory to query agents for"),
    }),
    outputSchema: z.object({
      agents: z.array(z.object({
        name: z.string(),
        description: z.string().optional(),
        canEdit: z.boolean(),
        canBash: z.boolean(),
        mode: z.string(),
      })),
    }),
    execute: async (input) => {
      const dir = input.directory ?? deps.directory
      const res = await deps.client.app.agents({ query: dir ? { directory: dir } : {} })
      if (!res.data) return { agents: [] }
      return {
        agents: res.data
          .filter((a) => !["compaction", "summary", "title"].includes(a.name))
          .map((a) => ({
            name: a.name,
            description: a.description,
            canEdit: a.permission.edit === "allow",
            canBash: a.permission.bash ? Object.values(a.permission.bash).some((v) => v === "allow") : false,
            mode: a.mode,
          })),
      }
    },
  })

  const mcpStatus = createTool({
    id: "mcpStatus",
    description: "Check the status of all MCP servers connected to opencode.",
    inputSchema: z.object({}),
    outputSchema: z.object({
      servers: z.record(z.string(), z.object({
        status: z.string(),
        error: z.string().optional(),
      })),
    }),
    execute: async () => {
      const res = await deps.client.mcp.status()
      return { servers: (res.data ?? {}) as Record<string, { status: string; error?: string }> }
    },
  })

  const createGitWorktree = createTool({
    id: "createGitWorktree",
    description: "Create an isolated git worktree for running tasks in a separate branch.",
    inputSchema: z.object({
      taskName: z.string(),
      baseBranch: z.string().default("HEAD"),
    }),
    outputSchema: z.object({
      path: z.string(),
      branch: z.string(),
    }),
    execute: async (input) => {
      const wt = await createWorktree(input.baseBranch, input.taskName)
      return { path: wt.path, branch: wt.branch }
    },
  })

  return { runAgent, planTask, reviewWork, listAgents, mcpStatus, createGitWorktree }
}

export function extractJson(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.startsWith("{")) return trimmed
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence?.[1]) return fence[1].trim()
  const start = trimmed.indexOf("{")
  const end = trimmed.lastIndexOf("}")
  if (start !== -1 && end !== -1 && end > start) return trimmed.slice(start, end + 1)
  throw new Error("No JSON found in response")
}