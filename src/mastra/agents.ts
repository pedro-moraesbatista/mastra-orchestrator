import { Agent } from "@mastra/core/agent"
import type { ToolDeps } from "./tools.ts"
import { makeTools } from "./tools.ts"

export interface AgentDeps extends ToolDeps {
  model: string
}

export function createPlannerAgent(deps: AgentDeps, extraTools: Record<string, any> = {}) {
  const tools = makeTools(deps)
  return new Agent({
    id: "planner",
    name: "Planner",
    instructions: `You are the Planner agent. Analyze the task and produce a structured plan.

Use the planTask tool to delegate planning to the opencode planner agent.
The tool returns a plan with goal, steps (with agent assignments and dependencies), files, and risks.

Return the plan as-is. Do not modify it.`,
    model: deps.model,
    tools: { planTask: tools.planTask, listAgents: tools.listAgents, ...extraTools },
  })
}

export function createReviewerAgent(deps: AgentDeps, extraTools: Record<string, any> = {}) {
  const tools = makeTools(deps)
  return new Agent({
    id: "reviewer",
    name: "Reviewer",
    instructions: `You are the Reviewer agent. Evaluate the work produced by other agents.

Use the reviewWork tool to delegate review to the opencode reviewer agent.
The tool returns whether the work is approved, findings with severity, and a summary.

Return the review as-is. Do not modify it.`,
    model: deps.model,
    tools: { reviewWork: tools.reviewWork, ...extraTools },
  })
}

export function createSupervisorAgent(deps: AgentDeps, extraTools: Record<string, any> = {}) {
  const tools = makeTools(deps)
  return new Agent({
    id: "supervisor",
    name: "Supervisor",
    instructions: `You are the Supervisor. You orchestrate task execution by delegating to opencode agents.

Your workflow:
1. Call listAgents to discover available opencode agents and their capabilities.
2. Call runOpencodeAgent to delegate work to an appropriate agent.
3. You can call runOpencodeAgent multiple times for multi-step tasks.
4. Check mcpStatus if the task involves external services.
5. When the task is complete, summarize the results.

Rules:
- Choose agents based on their capabilities (canEdit, canBash).
- For read-only analysis, prefer agents that cannot edit files.
- For implementation, use agents that can edit files.
- Keep instructions concise (max 500 chars).
- When the task involves external services, instruct agents to use MCP tools.
- If an agent fails, try a different agent or explain the failure.

You have access to the full opencode agent ecosystem through these tools.`,
    model: deps.model,
    tools: {
      runOpencodeAgent: tools.runAgent,
      listAgents: tools.listAgents,
      mcpStatus: tools.mcpStatus,
      createGitWorktree: tools.createGitWorktree,
      ...extraTools,
    },
  })
}

export function createCoderAgent(deps: AgentDeps, extraTools: Record<string, any> = {}) {
  const tools = makeTools(deps)
  return new Agent({
    id: "coder",
    name: "Coder",
    instructions: `You are the Coder agent. You implement code changes by delegating to opencode coding agents.

Use the runOpencodeAgent tool with agent "build" or "coder" to make file changes.
Do NOT run git push or destructive commands.
Always provide a clear summary of what you did.`,
    model: deps.model,
    tools: { runOpencodeAgent: tools.runAgent, ...extraTools },
  })
}