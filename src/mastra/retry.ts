import { MastraNonRetryableError } from "@mastra/core/error"

export class RetryableError extends Error {
  readonly isRetryable = true
  readonly attempt?: number

  constructor(message: string, opts?: { cause?: unknown; attempt?: number }) {
    super(message, opts)
    this.name = "RetryableError"
    this.attempt = opts?.attempt
  }
}

export class PermanentWorkflowError extends MastraNonRetryableError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "PermanentWorkflowError"
  }
}

export interface ErrorClassification {
  retryable: boolean
  reason: string
}

export function classifyError(err: unknown): ErrorClassification {
  if (err instanceof MastraNonRetryableError || err instanceof PermanentWorkflowError) {
    return { retryable: false, reason: "non-retryable error type" }
  }

  if (err instanceof RetryableError) {
    return { retryable: true, reason: "explicitly marked retryable" }
  }

  const msg = String((err as Record<string, unknown>)?.["message"] ?? err)
  const lower = msg.toLowerCase()

  if (lower.includes("schema") || lower.includes("validation") || lower.includes("invalid")) {
    return { retryable: false, reason: `schema/validation error: ${msg}` }
  }

  if (lower.includes("agent") && lower.includes("not found")) {
    return { retryable: false, reason: `agent not found: ${msg}` }
  }

  if (lower.includes("circular") || lower.includes("deadlock") || lower.includes("dependency")) {
    return { retryable: false, reason: `structural error: ${msg}` }
  }

  if (lower.includes("authentication") || lower.includes("unauthorized") || lower.includes("api key")) {
    return { retryable: false, reason: `auth error: ${msg}` }
  }

  if (lower.includes("fetch failed") || lower.includes("econnreset") || lower.includes("econnrefused")) {
    return { retryable: true, reason: `network error: ${msg}` }
  }

  if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("aborted")) {
    return { retryable: true, reason: `timeout: ${msg}` }
  }

  if (lower.includes("429") || lower.includes("rate limit") || lower.includes("too many requests")) {
    return { retryable: true, reason: `rate limited: ${msg}` }
  }

  if (lower.includes("503") || lower.includes("502") || lower.includes("500") || lower.includes("service unavailable")) {
    return { retryable: true, reason: `server error: ${msg}` }
  }

  if (lower.includes("no json found") || lower.includes("parse")) {
    return { retryable: true, reason: `parse error (may be transient LLM output): ${msg}` }
  }

  return { retryable: false, reason: `unclassified error: ${msg}` }
}

export interface RetryConfig {
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
}

export const DEFAULT_RETRY: RetryConfig = {
  maxAttempts: 3,
  baseDelayMs: 2000,
  maxDelayMs: 30000,
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  config: RetryConfig,
  label: string,
  onAttempt?: (attempt: number, error: unknown, delayMs: number) => void,
): Promise<T> {
  let lastError: unknown

  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      const cls = classifyError(err)

      if (!cls.retryable) {
        throw err
      }

      if (attempt >= config.maxAttempts) {
        throw err
      }

      const delayMs = Math.min(
        config.baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 500,
        config.maxDelayMs,
      )

      onAttempt?.(attempt, err, delayMs)

      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }

  throw lastError
}

export function withTimeout<T>(fn: () => Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
      reject(new RetryableError(`Timeout after ${timeoutMs}ms: ${label}`))
    }, timeoutMs)

    fn()
      .then((result) => {
        clearTimeout(timer)
        resolve(result)
      })
      .catch((err) => {
        clearTimeout(timer)
        if (controller.signal.aborted) {
          reject(new RetryableError(`Timeout after ${timeoutMs}ms: ${label}`))
        } else {
          reject(err)
        }
      })
  })
}

export const STEP_TIMEOUTS = {
  analyze: 60_000,
  plan: 120_000,
  validate: 5_000,
  execute: 600_000,
  review: 120_000,
} as const

export const WORKFLOW_LIMITS = {
  maxStepRetries: 3,
  maxReplanCycles: 2,
  maxWorkflowDuration: 1_800_000,
  maxAgentIterations: 20,
  maxPlanSteps: 30,
  minPlanSteps: 1,
  maxInstructionLength: 500,
} as const

export function validatePlan(plan: { steps: Array<{ agent: string; task: string; dependsOn?: number[] }> }): void {
  const steps = plan.steps
  if (!steps || steps.length === 0) {
    throw new PermanentWorkflowError("Plan is empty: no steps")
  }

  if (steps.length > WORKFLOW_LIMITS.maxPlanSteps) {
    throw new PermanentWorkflowError(`Plan has too many steps: ${steps.length} (max ${WORKFLOW_LIMITS.maxPlanSteps})`)
  }

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!

    if (!step.agent || step.agent.trim().length === 0) {
      throw new PermanentWorkflowError(`Step ${i} has no agent assigned`)
    }

    if (!step.task || step.task.trim().length === 0) {
      throw new PermanentWorkflowError(`Step ${i} has no task description`)
    }

    if (step.task.length > WORKFLOW_LIMITS.maxInstructionLength) {
      throw new PermanentWorkflowError(`Step ${i} task is too long (${step.task.length} chars, max ${WORKFLOW_LIMITS.maxInstructionLength})`)
    }

    const deps = step.dependsOn ?? []
    for (const dep of deps) {
      if (dep === i) {
        throw new PermanentWorkflowError(`Step ${i} depends on itself`)
      }
      if (dep < 0 || dep >= steps.length) {
        throw new PermanentWorkflowError(`Step ${i} depends on invalid step index ${dep} (valid: 0..${steps.length - 1})`)
      }
    }
  }

  const visited = new Set<number>()
  const stack = new Set<number>()

  function hasCycle(node: number): boolean {
    if (stack.has(node)) return true
    if (visited.has(node)) return false
    visited.add(node)
    stack.add(node)
    const deps = steps[node]!.dependsOn ?? []
    for (const dep of deps) {
      if (hasCycle(dep)) return true
    }
    stack.delete(node)
    return false
  }

  for (let i = 0; i < steps.length; i++) {
    if (!visited.has(i) && hasCycle(i)) {
      throw new PermanentWorkflowError(`Circular dependency detected involving step ${i}`)
    }
  }

  const seenTasks = new Set<string>()
  for (let i = 0; i < steps.length; i++) {
    const key = `${steps[i]!.agent}:${steps[i]!.task.slice(0, 60)}`
    if (seenTasks.has(key)) {
      throw new PermanentWorkflowError(`Duplicate step detected at index ${i}: same agent+task as a previous step`)
    }
    seenTasks.add(key)
  }
}