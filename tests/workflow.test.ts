import { describe, it, expect } from "vitest"
import { classifyError, RetryableError, PermanentWorkflowError, withRetry, withTimeout, validatePlan, WORKFLOW_LIMITS } from "../src/mastra/retry.ts"

describe("classifyError", () => {
  it("classifies network errors as retryable", () => {
    const err = new Error("fetch failed")
    const cls = classifyError(err)
    expect(cls.retryable).toBe(true)
    expect(cls.reason).toContain("network")
  })

  it("classifies timeout as retryable", () => {
    const err = new Error("Request timed out")
    const cls = classifyError(err)
    expect(cls.retryable).toBe(true)
    expect(cls.reason).toContain("timeout")
  })

  it("classifies 429 rate limit as retryable", () => {
    const err = new Error("429 Too Many Requests")
    const cls = classifyError(err)
    expect(cls.retryable).toBe(true)
    expect(cls.reason).toContain("rate")
  })

  it("classifies 503 as retryable", () => {
    const err = new Error("503 Service Unavailable")
    const cls = classifyError(err)
    expect(cls.retryable).toBe(true)
    expect(cls.reason).toContain("server")
  })

  it("classifies schema validation as non-retryable", () => {
    const err = new Error("Invalid schema: missing required field")
    const cls = classifyError(err)
    expect(cls.retryable).toBe(false)
    expect(cls.reason).toContain("schema")
  })

  it("classifies circular dependency as non-retryable", () => {
    const err = new Error("Circular dependency detected")
    const cls = classifyError(err)
    expect(cls.retryable).toBe(false)
    expect(cls.reason).toContain("structural")
  })

  it("classifies agent not found as non-retryable", () => {
    const err = new Error("agent not found: coder")
    const cls = classifyError(err)
    expect(cls.retryable).toBe(false)
    expect(cls.reason).toContain("agent")
  })

  it("classifies auth errors as non-retryable", () => {
    const err = new Error("Unauthorized: invalid api key")
    const cls = classifyError(err)
    expect(cls.retryable).toBe(false)
    expect(cls.reason).toContain("auth")
  })

  it("classifies JSON parse errors as retryable (transient LLM output)", () => {
    const err = new Error("No JSON found in response")
    const cls = classifyError(err)
    expect(cls.retryable).toBe(true)
    expect(cls.reason).toContain("parse")
  })

  it("classifies PermanentWorkflowError as non-retryable", () => {
    const err = new PermanentWorkflowError("plan is empty")
    const cls = classifyError(err)
    expect(cls.retryable).toBe(false)
  })

  it("classifies RetryableError as retryable", () => {
    const err = new RetryableError("transient failure")
    const cls = classifyError(err)
    expect(cls.retryable).toBe(true)
  })

  it("classifies unknown errors as non-retryable", () => {
    const err = new Error("something weird happened")
    const cls = classifyError(err)
    expect(cls.retryable).toBe(false)
    expect(cls.reason).toContain("unclassified")
  })
})

describe("withRetry", () => {
  it("succeeds on first attempt", async () => {
    let calls = 0
    const result = await withRetry(async () => {
      calls++
      return "ok"
    }, { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 50 }, "test")
    expect(result).toBe("ok")
    expect(calls).toBe(1)
  })

  it("retries on retryable error and succeeds", async () => {
    let calls = 0
    const result = await withRetry(async () => {
      calls++
      if (calls < 2) throw new Error("fetch failed")
      return "ok"
    }, { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 50 }, "test")
    expect(result).toBe("ok")
    expect(calls).toBe(2)
  })

  it("does NOT retry on non-retryable error", async () => {
    let calls = 0
    await expect(
      withRetry(async () => {
        calls++
        throw new PermanentWorkflowError("schema invalid")
      }, { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 50 }, "test"),
    ).rejects.toThrow("schema invalid")
    expect(calls).toBe(1)
  })

  it("exhausts retries and throws last error", async () => {
    let calls = 0
    await expect(
      withRetry(async () => {
        calls++
        throw new Error("timeout")
      }, { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 50 }, "test"),
    ).rejects.toThrow("timeout")
    expect(calls).toBe(2)
  })

  it("calls onAttempt callback on retry", async () => {
    const attempts: number[] = []
    let calls = 0
    await withRetry(
      async () => {
        calls++
        if (calls < 3) throw new Error("fetch failed")
        return "ok"
      },
      { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 50 },
      "test",
      (attempt) => attempts.push(attempt),
    )
    expect(attempts).toEqual([1, 2])
  })
})

describe("withTimeout", () => {
  it("resolves if fn completes before timeout", async () => {
    const result = await withTimeout(async () => "ok", 1000, "test")
    expect(result).toBe("ok")
  })

  it("rejects with RetryableError if fn exceeds timeout", async () => {
    await expect(
      withTimeout(async () => {
        await new Promise((r) => setTimeout(r, 200))
        return "ok"
      }, 50, "test"),
    ).rejects.toThrow("Timeout")
  })
})

describe("validatePlan", () => {
  it("validates a correct plan", () => {
    const plan = {
      steps: [
        { agent: "coder", task: "do A", dependsOn: [] },
        { agent: "build", task: "do B", dependsOn: [0] },
      ],
    }
    expect(() => validatePlan(plan)).not.toThrow()
  })

  it("rejects empty plan", () => {
    expect(() => validatePlan({ steps: [] })).toThrow("empty")
  })

  it("rejects step with no agent", () => {
    const plan = { steps: [{ agent: "", task: "do A" }] }
    expect(() => validatePlan(plan)).toThrow("no agent")
  })

  it("rejects step with no task", () => {
    const plan = { steps: [{ agent: "coder", task: "" }] }
    expect(() => validatePlan(plan)).toThrow("no task")
  })

  it("rejects self-dependency", () => {
    const plan = { steps: [{ agent: "coder", task: "do A", dependsOn: [0] }] }
    expect(() => validatePlan(plan)).toThrow("depends on itself")
  })

  it("rejects out-of-range dependency", () => {
    const plan = { steps: [{ agent: "coder", task: "do A", dependsOn: [5] }] }
    expect(() => validatePlan(plan)).toThrow("invalid step index")
  })

  it("rejects circular dependency", () => {
    const plan = {
      steps: [
        { agent: "coder", task: "do A", dependsOn: [1] },
        { agent: "build", task: "do B", dependsOn: [0] },
      ],
    }
    expect(() => validatePlan(plan)).toThrow("Circular")
  })

  it("rejects duplicate steps", () => {
    const plan = {
      steps: [
        { agent: "coder", task: "do the same thing" },
        { agent: "coder", task: "do the same thing" },
      ],
    }
    expect(() => validatePlan(plan)).toThrow("Duplicate")
  })

  it("rejects too many steps", () => {
    const plan = {
      steps: Array.from({ length: WORKFLOW_LIMITS.maxPlanSteps + 1 }, (_, i) => ({
        agent: "coder",
        task: `task ${i}`,
      })),
    }
    expect(() => validatePlan(plan)).toThrow("too many")
  })

  it("rejects task that is too long", () => {
    const plan = {
      steps: [{ agent: "coder", task: "x".repeat(WORKFLOW_LIMITS.maxInstructionLength + 1) }],
    }
    expect(() => validatePlan(plan)).toThrow("too long")
  })
})