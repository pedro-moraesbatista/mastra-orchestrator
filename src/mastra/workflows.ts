import { createStep, createWorkflow } from "@mastra/core/workflows"
import { z } from "zod"
import { makeTools, extractJson, type ToolDeps } from "./tools.ts"
import { logger } from "../logger.ts"
import {
  RetryableError,
  PermanentWorkflowError,
  classifyError,
  withRetry,
  withTimeout,
  DEFAULT_RETRY,
  STEP_TIMEOUTS,
  WORKFLOW_LIMITS,
  validatePlan,
  type RetryConfig,
} from "./retry.ts"

interface ToolObserve {
  span<T>(name: string, fn: () => Promise<T> | T, attributes?: Record<string, unknown>): Promise<T>
  log(level: "debug" | "info" | "warn" | "error" | "fatal", message: string, data?: Record<string, unknown>): void
}

interface ObservabilityCtx {
  tracing?: any
  loggerVNext?: any
  metrics?: any
  tracingContext?: any
  runId?: string
}

const inputSchema = z.object({
  taskDescription: z.string(),
  readOnly: z.boolean().optional(),
  directory: z.string().optional().describe("target repository directory where agents should operate"),
  maxReplanCycles: z.number().optional().describe("maximum replan cycles on review rejection"),
})

const planSchema = z.object({
  goal: z.string(),
  analysis: z.string(),
  files: z.array(z.string()),
  steps: z.array(z.object({
    id: z.string().optional(),
    agent: z.string(),
    task: z.string(),
    dependencies: z.array(z.string()).optional(),
    expectedOutput: z.string().optional(),
    requiresPermission: z.object({
      resource: z.string(),
      operation: z.string(),
      reason: z.string().optional(),
    }).optional(),
    dependsOn: z.array(z.number()).optional(),
  })).min(1).max(30),
  risks: z.array(z.string()),
})

const outputSchema = z.object({
  approved: z.boolean(),
  summary: z.string(),
  findings: z.array(z.object({
    severity: z.string(),
    description: z.string(),
  })),
  agentOutputs: z.array(z.object({ agent: z.string(), text: z.string() })),
  replanCount: z.number(),
  cycles: z.array(z.object({
    cycle: z.number(),
    planGoal: z.string(),
    stepCount: z.number(),
    approved: z.boolean(),
    rejectionReason: z.string().optional(),
  })),
})

const suspendSchema = z.object({
  reason: z.string(),
  stepId: z.string(),
  attempt: z.number(),
  error: z.string(),
  taskDescription: z.string(),
})

function createToolObserve(ctx: ObservabilityCtx, toolName: string): ToolObserve {
  const traceCtx = ctx.tracing?.getCurrentSpan
    ? { traceId: ctx.tracing.getCurrentSpan()?.traceId, spanId: ctx.tracing.getCurrentSpan()?.spanId }
    : {}

  return {
    span: async <T>(name: string, fn: () => Promise<T> | T, attributes?: Record<string, unknown>): Promise<T> => {
      const start = Date.now()
      logger.debug(`tool:${toolName} span start`, { name, ...attributes, ...traceCtx })
      try {
        if (ctx.tracing?.createSpan) {
          return await ctx.tracing.createSpan(`tool.${toolName}.${name}`, async (span: any) => {
            if (attributes && span?.setAttributes) span.setAttributes(attributes)
            const result = await fn()
            const dur = Date.now() - start
            logger.info(`tool:${toolName} ${name} completed`, { durationMs: dur, ...traceCtx })
            return result
          })
        }
        const result = await fn()
        const dur = Date.now() - start
        logger.info(`tool:${toolName} ${name} completed`, { durationMs: dur, ...traceCtx })
        return result
      } catch (err) {
        const dur = Date.now() - start
        logger.error(`tool:${toolName} ${name} failed`, { durationMs: dur, error: String(err), ...traceCtx })
        throw err
      }
    },
    log: (level: "debug" | "info" | "warn" | "error" | "fatal", message: string, data?: Record<string, unknown>) => {
      logger[level](`tool:${toolName} ${message}`, { ...data, ...traceCtx })
      ctx.loggerVNext?.[level]?.(message, data)
    },
  }
}

function execTool(tool: any, input: any, ctx: ObservabilityCtx, toolName: string) {
  const observe = createToolObserve(ctx, toolName)
  return tool.execute!(input, { observe })
}

function execToolWithRetry(
  tool: any,
  input: any,
  ctx: ObservabilityCtx,
  toolName: string,
  retryConfig: RetryConfig,
  stepId: string,
): Promise<any> {
  return withRetry(
    () => execTool(tool, input, ctx, toolName),
    retryConfig,
    `${stepId}.${toolName}`,
    (attempt, error, delayMs) => {
      const cls = classifyError(error)
      logger.warn(`retry: ${stepId}.${toolName} attempt ${attempt} failed`, {
        runId: ctx.runId,
        attempt,
        delayMs,
        retryable: cls.retryable,
        reason: cls.reason,
        error: String(error).slice(0, 200),
      })
    },
  )
}

async function callPlan(
  tools: ReturnType<typeof makeTools>,
  taskDescription: string,
  directory: string | undefined,
  agents: Array<{ name: string; canEdit: boolean }>,
  ctx: ObservabilityCtx,
  stepId: string,
  previousRejection?: string,
): Promise<z.infer<typeof planSchema>> {
  const agentList = agents.map((a) => `${a.name} (edit:${a.canEdit})`).join(", ")
  const promptParts = [
    "You are the Planner. Respond with ONLY a JSON object matching this schema:",
    '{"goal":"...","analysis":"...","files":["..."],"steps":[{"agent":"coder","task":"...","dependsOn":[0]}],"risks":["..."]}',
    "",
    `Task: ${taskDescription}`,
    `Available agents: ${agentList}`,
  ]
  if (previousRejection) {
    promptParts.push("", `Previous plan was rejected: ${previousRejection}`, "Create an improved plan addressing the rejection.")
  }

  const result = await withTimeout(
    () => execToolWithRetry(
      tools.planTask,
      { taskDescription: promptParts.join("\n"), directory },
      ctx,
      "planTask",
      DEFAULT_RETRY,
      stepId,
    ),
    STEP_TIMEOUTS.plan,
    `${stepId}.planTask`,
  )

  validatePlan(result)
  return result
}

async function callExecute(
  tools: ReturnType<typeof makeTools>,
  plan: z.infer<typeof planSchema>,
  directory: string | undefined,
  ctx: ObservabilityCtx,
  stepId: string,
  suspend: (payload: z.infer<typeof suspendSchema>) => any,
  retryCount: number | undefined,
  taskDescription: string,
): Promise<Array<{ agent: string; text: string }>> {
  const agentOutputs: Array<{ agent: string; text: string }> = []
  const completed = new Set<number>()
  const failedSteps: Array<{ index: number; agent: string; error: string; attempts: number }> = []

  logger.info(`${stepId}:execute started`, { runId: ctx.runId, totalSteps: plan.steps.length })

  while (completed.size < plan.steps.length) {
    const ready = plan.steps
      .map((step, i) => ({ step, i }))
      .filter(({ i }) => !completed.has(i))
      .filter(({ step }) => !step.dependsOn || step.dependsOn.every((d) => completed.has(d)))

    if (ready.length === 0) {
      const pending = plan.steps
        .map((step, i) => ({ step, i }))
        .filter(({ i }) => !completed.has(i))
        .map(({ i, step }) => `step[${i}] agent=${step.agent} dependsOn=${JSON.stringify(step.dependsOn ?? [])}`)

      throw new PermanentWorkflowError(
        `Deadlock: no ready steps. Completed: [${[...completed].join(", ")}]. Pending: ${pending.join("; ")}.`,
      )
    }

    logger.info(`${stepId}:execute dispatching`, {
      runId: ctx.runId,
      readyCount: ready.length,
      completedCount: completed.size,
    })

    const stepRetryConfig: RetryConfig = { ...DEFAULT_RETRY, maxAttempts: WORKFLOW_LIMITS.maxStepRetries }

    const results = await Promise.allSettled(
      ready.map(async ({ step, i }) => {
        logger.info(`${stepId}:execute running agent`, {
          runId: ctx.runId,
          stepIndex: i,
          agent: step.agent,
          task: step.task.slice(0, 100),
        })

        const result = await withTimeout(
          () => execToolWithRetry(
            tools.runAgent,
            { agentName: step.agent, instruction: step.task, directory },
            ctx,
            "runAgent",
            stepRetryConfig,
            `${stepId}.step[${i}]`,
          ),
          STEP_TIMEOUTS.execute,
          `${stepId}.step[${i}].${step.agent}`,
        )
        completed.add(i)

        logger.info(`${stepId}:execute agent completed`, {
          runId: ctx.runId,
          stepIndex: i,
          agent: step.agent,
          outputLength: result.text.length,
        })

        return { agent: step.agent, text: result.text }
      }),
    )

    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected")
    if (rejected.length > 0) {
      for (const r of results) {
        if (r.status === "fulfilled") agentOutputs.push(r.value)
      }

      if ((retryCount ?? 0) >= WORKFLOW_LIMITS.maxStepRetries) {
        for (const r of rejected) {
          const cls = classifyError(r.reason)
          if (!cls.retryable) continue
        }

        logger.warn(`${stepId}:execute suspending after persistent failures`, {
          runId: ctx.runId,
          failedSteps,
          retryCount,
        })

        suspend({
          reason: "Persistent agent execution failures after retries",
          stepId,
          attempt: retryCount ?? 0,
          error: rejected.map((r) => String(r.reason).slice(0, 200)).join("; "),
          taskDescription,
        })
        return agentOutputs
      }

      throw rejected[0]!.reason
    }

    for (const r of results) {
      if (r.status === "fulfilled") agentOutputs.push(r.value)
    }
  }

  logger.info(`${stepId}:execute completed`, { runId: ctx.runId, totalOutputs: agentOutputs.length })
  return agentOutputs
}

async function callReview(
  tools: ReturnType<typeof makeTools>,
  taskDescription: string,
  planGoal: string,
  agentOutputs: Array<{ agent: string; text: string }>,
  directory: string | undefined,
  ctx: ObservabilityCtx,
  stepId: string,
): Promise<{ approved: boolean; findings: Array<{ severity: string; description: string }>; summary: string }> {
  const review = await withTimeout(
    () => execToolWithRetry(
      tools.reviewWork,
      { taskDescription, planGoal, agentOutputs, directory },
      ctx,
      "reviewWork",
      DEFAULT_RETRY,
      stepId,
    ),
    STEP_TIMEOUTS.review,
    `${stepId}.reviewWork`,
  )

  return {
    approved: review.approved,
    findings: review.findings.map((f: any) => ({ severity: f.severity, description: f.description })),
    summary: review.summary,
  }
}

export function createOrchestrationWorkflow(deps: ToolDeps) {
  const tools = makeTools(deps)

  const analyzeStep = createStep({
    id: "analyze",
    description: "Check opencode connectivity and list available agents",
    inputSchema,
    outputSchema: z.object({
      taskDescription: z.string(),
      directory: z.string().optional(),
      agents: z.array(z.object({
        name: z.string(),
        canEdit: z.boolean(),
        canBash: z.boolean(),
        mode: z.string(),
      })),
    }),
    execute: async ({ inputData, runId, tracing, loggerVNext, metrics, tracingContext }) => {
      const ctx: ObservabilityCtx = { tracing, loggerVNext, metrics, tracingContext, runId }
      const { taskDescription, directory } = inputData

      logger.info("workflow:analyze started", { runId, taskDescription: taskDescription.slice(0, 100), directory })

      try {
        const agentsResult = await withTimeout(
          () => execToolWithRetry(tools.listAgents, { directory }, ctx, "listAgents", DEFAULT_RETRY, "analyze"),
          STEP_TIMEOUTS.analyze,
          "analyze.listAgents",
        )

        logger.info("workflow:analyze completed", {
          runId,
          agentCount: agentsResult.agents.length,
          agents: agentsResult.agents.map((a: any) => a.name),
        })

        return { taskDescription, directory, agents: agentsResult.agents }
      } catch (err) {
        const cls = classifyError(err)
        logger.error("workflow:analyze failed", { runId, error: String(err), retryable: cls.retryable, reason: cls.reason })
        throw err
      }
    },
  })

  const orchestrateStep = createStep({
    id: "orchestrate",
    description: "Plan → Validate → Execute → Review with replan loop and suspend on persistent failures",
    inputSchema: z.object({
      taskDescription: z.string(),
      directory: z.string().optional(),
      agents: z.array(z.object({
        name: z.string(),
        canEdit: z.boolean(),
        canBash: z.boolean(),
        mode: z.string(),
      })),
    }),
    outputSchema,
    execute: async ({ inputData, getInitData, runId, tracing, loggerVNext, metrics, tracingContext, suspend, retryCount }) => {
      const ctx: ObservabilityCtx = { tracing, loggerVNext, metrics, tracingContext, runId }
      const init = getInitData() as { taskDescription: string; directory?: string; maxReplanCycles?: number }
      const { taskDescription, directory, agents } = inputData
      const maxReplan = Math.min(init.maxReplanCycles ?? WORKFLOW_LIMITS.maxReplanCycles, WORKFLOW_LIMITS.maxReplanCycles)

      const cycles: Array<{ cycle: number; planGoal: string; stepCount: number; approved: boolean; rejectionReason?: string }> = []
      let allAgentOutputs: Array<{ agent: string; text: string }> = []
      let replanCount = 0

      logger.info("workflow:orchestrate started", {
        runId,
        taskDescription: taskDescription.slice(0, 100),
        directory,
        maxReplan,
      })

      for (let cycle = 0; cycle <= maxReplan; cycle++) {
        logger.info("workflow:orchestrate cycle", { runId, cycle, replanCount })

        const previousRejection = cycles.length > 0 && !cycles[cycles.length - 1]!.approved
          ? cycles[cycles.length - 1]!.rejectionReason
          : undefined

        const plan = await withTimeout(
          () => callPlan(tools, taskDescription, directory, agents, ctx, `orchestrate.cycle[${cycle}]`, previousRejection),
          STEP_TIMEOUTS.plan + 10_000,
          `orchestrate.cycle[${cycle}].plan`,
        )

        logger.info("workflow:orchestrate plan ready", {
          runId,
          cycle,
          stepCount: plan.steps.length,
          goal: plan.goal.slice(0, 80),
        })

        const agentOutputs = await callExecute(
          tools,
          plan,
          directory,
          ctx,
          `orchestrate.cycle[${cycle}]`,
          suspend,
          retryCount,
          taskDescription,
        )

        allAgentOutputs = agentOutputs

        const review = await withTimeout(
          () => callReview(tools, taskDescription, plan.goal, agentOutputs, directory, ctx, `orchestrate.cycle[${cycle}]`),
          STEP_TIMEOUTS.review + 10_000,
          `orchestrate.cycle[${cycle}].review`,
        )

        const cycleInfo = {
          cycle,
          planGoal: plan.goal.slice(0, 100),
          stepCount: plan.steps.length,
          approved: review.approved,
          rejectionReason: review.approved ? undefined : review.summary,
        }
        cycles.push(cycleInfo)

        logger.info("workflow:orchestrate review result", {
          runId,
          cycle,
          approved: review.approved,
          findingsCount: review.findings.length,
        })

        if (review.approved) {
          logger.info("workflow:orchestrate approved", { runId, cycle, replanCount })
          return {
            approved: true,
            summary: review.summary,
            findings: review.findings,
            agentOutputs: allAgentOutputs,
            replanCount,
            cycles,
          }
        }

        if (cycle >= maxReplan) {
          logger.warn("workflow:orchestrate max replan reached", { runId, cycle, replanCount, rejection: review.summary })
          return {
            approved: false,
            summary: `Plan rejected after ${replanCount} replan cycles. Last rejection: ${review.summary}`,
            findings: review.findings,
            agentOutputs: allAgentOutputs,
            replanCount,
            cycles,
          }
        }

        replanCount++
        logger.info("workflow:orchestrate replanning", {
          runId,
          cycle,
          replanCount,
          rejectionReason: review.summary.slice(0, 200),
        })
      }

      return {
        approved: false,
        summary: "Max replan cycles reached",
        findings: [],
        agentOutputs: allAgentOutputs,
        replanCount,
        cycles,
      }
    },
  })

  return createWorkflow({
    id: "orchestration",
    inputSchema,
    outputSchema,
    steps: [analyzeStep, orchestrateStep],
    retryConfig: {
      attempts: WORKFLOW_LIMITS.maxStepRetries,
      delay: DEFAULT_RETRY.baseDelayMs,
    },
  })
    .then(analyzeStep)
    .then(orchestrateStep)
    .commit()
}

const decisionInputSchema = z.object({
  taskDescription: z.string(),
  readOnly: z.boolean().optional(),
  maxIterations: z.number().optional(),
  directory: z.string().optional().describe("target repository directory where agents should operate"),
})

const decisionOutputSchema = z.object({
  result: z.enum(["completed", "failed"]),
  summary: z.string(),
  invocations: z.array(z.object({
    agent: z.string(),
    instruction: z.string(),
    text: z.string(),
  })),
})

const decisionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("run_agent"), agent: z.string(), instruction: z.string() }),
  z.object({ action: z.literal("run_parallel"), steps: z.array(z.object({ agent: z.string(), instruction: z.string() })) }),
  z.object({ action: z.literal("finish"), result: z.enum(["completed", "failed"]), summary: z.string() }),
])

export function createDecisionLoopWorkflow(deps: ToolDeps) {
  const tools = makeTools(deps)

  const loopStep = createStep({
    id: "decision-loop",
    description: "Supervisor decides and executes actions in a loop until finish",
    inputSchema: decisionInputSchema,
    outputSchema: decisionOutputSchema,
    execute: async ({ inputData, runId, tracing, loggerVNext, metrics, tracingContext, suspend, retryCount }) => {
      const ctx: ObservabilityCtx = { tracing, loggerVNext, metrics, tracingContext, runId }
      const { taskDescription, maxIterations, directory } = inputData
      const maxIter = Math.min(maxIterations ?? WORKFLOW_LIMITS.maxAgentIterations, WORKFLOW_LIMITS.maxAgentIterations)

      logger.info("workflow:decision-loop started", { runId, taskDescription: taskDescription.slice(0, 100), directory, maxIter })

      const agentsResult = await withTimeout(
        () => execToolWithRetry(tools.listAgents, { directory }, ctx, "listAgents", DEFAULT_RETRY, "decision-loop"),
        STEP_TIMEOUTS.analyze,
        "decision-loop.listAgents",
      )
      const invocations: Array<{ agent: string; instruction: string; text: string }> = []

      for (let iter = 0; iter < maxIter; iter++) {
        const agentList = agentsResult.agents.map((a: any) => `${a.name} (edit:${a.canEdit})`).join(", ")

        const decisionPrompt = [
          "You are the Supervisor. Respond with ONLY a JSON object:",
          '  {"action":"run_agent","agent":"<name>","instruction":"<text>"}',
          '  {"action":"run_parallel","steps":[{"agent":"<name>","instruction":"<text>"}]}',
          '  {"action":"finish","result":"completed|failed","summary":"<text>"}',
          "",
          `Task: ${taskDescription}`,
          `Available agents: ${agentList}`,
          `Completed: ${invocations.length} steps`,
          invocations.length > 0 ? "History:" : "",
          ...invocations.map((v, i) => `  ${i + 1}. ${v.agent}: ${v.instruction.slice(0, 80)}`),
          "",
          "What is the next action?",
        ].join("\n")

        logger.info("workflow:decision-loop iteration", { runId, iteration: iter, invocations: invocations.length })

        let result
        try {
          result = await withTimeout(
            () => execToolWithRetry(
              tools.runAgent,
              { agentName: "build", instruction: decisionPrompt, directory },
              ctx,
              "runAgent",
              DEFAULT_RETRY,
              `decision-loop.iter[${iter}]`,
            ),
            STEP_TIMEOUTS.plan,
            `decision-loop.iter[${iter}].supervisor`,
          )
        } catch (err) {
          const cls = classifyError(err)
          logger.error("workflow:decision-loop supervisor call failed", {
            runId, iteration: iter, error: String(err), retryable: cls.retryable, reason: cls.reason,
          })

          if (!cls.retryable) throw err

          if ((retryCount ?? 0) >= WORKFLOW_LIMITS.maxStepRetries) {
            logger.warn("workflow:decision-loop suspending after persistent failures", { runId, retryCount })
            suspend({
              reason: "Persistent supervisor call failures",
              stepId: "decision-loop",
              attempt: retryCount ?? 0,
              error: String(err).slice(0, 500),
              taskDescription,
            })
            return { result: "failed" as const, summary: "Suspended after persistent failures", invocations }
          }
          throw err
        }

        let decision
        try {
          decision = decisionSchema.parse(JSON.parse(extractJson(result.text)))
        } catch {
          logger.warn("workflow:decision-loop failed to parse decision", { runId, iteration: iter })
          continue
        }

        if (decision.action === "finish") {
          logger.info("workflow:decision-loop finished", { runId, iteration: iter, result: decision.result })
          return { result: decision.result, summary: decision.summary, invocations }
        }

        if (decision.action === "run_agent") {
          logger.info("workflow:decision-loop run_agent", { runId, iteration: iter, agent: decision.agent })
          try {
            const r = await withTimeout(
              () => execToolWithRetry(
                tools.runAgent,
                { agentName: decision.agent, instruction: decision.instruction, directory },
                ctx, "runAgent", DEFAULT_RETRY, `decision-loop.iter[${iter}].${decision.agent}`,
              ),
              STEP_TIMEOUTS.execute,
              `decision-loop.iter[${iter}].${decision.agent}`,
            )
            invocations.push({ agent: decision.agent, instruction: decision.instruction, text: r.text })
          } catch (err) {
            const cls = classifyError(err)
            logger.error("workflow:decision-loop agent failed", {
              runId, iteration: iter, agent: decision.agent, error: String(err), retryable: cls.retryable, reason: cls.reason,
            })
            if (!cls.retryable) throw err
          }
        }

        if (decision.action === "run_parallel") {
          logger.info("workflow:decision-loop run_parallel", { runId, iteration: iter, stepCount: decision.steps.length })
          const results = await Promise.allSettled(
            decision.steps.map((step) =>
              withTimeout(
                () => execToolWithRetry(
                  tools.runAgent,
                  { agentName: step.agent, instruction: step.instruction, directory },
                  ctx, "runAgent", DEFAULT_RETRY, `decision-loop.iter[${iter}].parallel.${step.agent}`,
                ),
                STEP_TIMEOUTS.execute,
                `decision-loop.iter[${iter}].parallel.${step.agent}`,
              ),
            ),
          )
          for (let i = 0; i < decision.steps.length; i++) {
            const r = results[i]!
            if (r.status === "fulfilled") {
              invocations.push({ agent: decision.steps[i]!.agent, instruction: decision.steps[i]!.instruction, text: r.value.text })
            } else {
              logger.warn("workflow:decision-loop parallel step failed", {
                runId, iteration: iter, agent: decision.steps[i]!.agent, error: String(r.reason),
              })
            }
          }
        }
      }

      logger.warn("workflow:decision-loop max iterations reached", { runId, maxIter })
      return { result: "failed" as const, summary: "Max iterations reached", invocations }
    },
  })

  return createWorkflow({
    id: "decision-loop",
    inputSchema: decisionInputSchema,
    outputSchema: decisionOutputSchema,
    steps: [loopStep],
    retryConfig: { attempts: WORKFLOW_LIMITS.maxStepRetries, delay: DEFAULT_RETRY.baseDelayMs },
  })
    .then(loopStep)
    .commit()
}