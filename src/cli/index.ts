import { loadConfig } from "../config.ts"
import { connectOpencode, healthCheck, detectVersion } from "../opencode/client.ts"
import { createMastra } from "../mastra/index.ts"
import { createWorktree, type Worktree } from "../opencode/worktree.ts"

const HELP = `
Mastra Orchestrator — CLI

Studio UI:
  bun run dev              Start Mastra Studio + API (mastra dev)
  bun run studio           Start standalone Studio (connects to running server)

CLI commands:
  bun run health           Check opencode server connection
  bun run agents           List available opencode agents
  bun run task "<prompt>"  Run a task through Mastra workflow
  bun run task "<prompt>" --loop   Run via decision loop workflow
  bun run agent "<prompt>" Run via supervisor agent directly
  bun run worktree "<prompt>" Run task in isolated git worktree

Options:
  --loop          Use decision loop workflow (dynamic agent routing)
  --read-only     Prevent agents from editing files
  --worktree      Run in isolated git worktree
  -h, --help      Show this help
`

async function main(argv: string[]): Promise<void> {
  const cmd = argv[0] ?? "help"
  const rest = argv.slice(1)

  if (cmd === "-h" || cmd === "--help" || cmd === "help") {
    console.log(HELP)
    return
  }

  const cfg = loadConfig()

  if (cmd === "health") {
    await runHealth(cfg)
    return
  }

  if (cmd === "agents") {
    await runAgents(cfg)
    return
  }

  if (cmd === "task") {
    const { prompt, useLoop, readOnly, useWorktree } = parseArgs(rest)
    if (!prompt) { console.log(HELP); process.exit(1) }
    await runTask(cfg, prompt, { useLoop, readOnly, useWorktree })
    return
  }

  if (cmd === "agent") {
    const { prompt } = parseArgs(rest)
    if (!prompt) { console.log(HELP); process.exit(1) }
    await runAgent(cfg, prompt)
    return
  }

  if (cmd === "worktree") {
    const { prompt } = parseArgs(rest)
    if (!prompt) { console.log(HELP); process.exit(1) }
    await runTask(cfg, prompt, { useWorktree: true })
    return
  }

  console.log(HELP)
  process.exit(1)
}

function parseArgs(args: string[]): { prompt: string; useLoop: boolean; readOnly: boolean; useWorktree: boolean } {
  const positional: string[] = []
  let useLoop = false
  let readOnly = false
  let useWorktree = false
  for (const a of args) {
    if (a === "--loop") useLoop = true
    else if (a === "--read-only") readOnly = true
    else if (a === "--worktree") useWorktree = true
    else positional.push(a)
  }
  return { prompt: positional.join(" ").trim(), useLoop, readOnly, useWorktree }
}

type Cfg = ReturnType<typeof loadConfig>

async function runHealth(cfg: Cfg) {
  const handle = connectOpencode(cfg)
  try {
    const healthy = await healthCheck(handle.client)
    const version = await detectVersion()
    console.log("OpenCode")
    console.log("--------")
    console.log(`Status: ${healthy ? "healthy" : "unhealthy"}`)
    if (version) console.log(`Version: ${version}`)
    if (!healthy) process.exit(1)
  } finally {
    await handle.close()
  }
}

async function runAgents(cfg: Cfg) {
  const handle = connectOpencode(cfg)
  try {
    const res = await handle.client.app.agents({})
    if (!res.data) { console.log("No agents found."); return }
    console.log("Available agents")
    console.log("-----------------")
    for (const a of res.data) {
      if (["compaction", "summary", "title"].includes(a.name)) continue
      const tag = a.builtIn ? "[built-in]" : "[custom]"
      const desc = a.description ? ` - ${a.description}` : ""
      console.log(`  ${a.name.padEnd(16)} ${tag}${desc} (${a.mode})`)
    }
  } finally {
    await handle.close()
  }
}

async function runTask(cfg: Cfg, prompt: string, opts: { useLoop?: boolean; readOnly?: boolean; useWorktree?: boolean }) {
  const handle = connectOpencode(cfg)
  let worktree: Worktree | undefined

  process.on("SIGINT", () => {
    console.log("\nStopping...")
    if (worktree) worktree.remove().catch(() => {})
    process.exit(0)
  })

  try {
    let directory: string | undefined
    if (opts.useWorktree) {
      worktree = await createWorktree("HEAD", prompt)
      directory = worktree.path
      console.log(`Worktree: ${worktree.path} (branch: ${worktree.branch})`)
    }

    const mastra = await createMastra({ client: handle.client, directory })

    const workflowId = opts.useLoop ? "decisionLoop" : "orchestration"
    const workflow = mastra.getWorkflow(workflowId)

    console.log(`Workflow: ${workflowId}`)
    console.log(`Prompt: ${prompt}`)
    if (opts.readOnly) console.log("Mode: read-only")
    console.log()

    const run = await workflow.createRun()
    const result = await run.start({
      inputData: {
        taskDescription: prompt,
        readOnly: opts.readOnly,
        directory,
        maxIterations: 20,
      } as Record<string, unknown>,
    })

    console.log()
    if (result.status === "failed") {
      console.log(`Workflow failed: ${(result as any).error?.message ?? "unknown error"}`)
      return
    }
    if (result.status !== "success") {
      console.log(`Workflow status: ${result.status}`)
      return
    }
    const r = (result as any).result as Record<string, unknown> | undefined
    if (opts.useLoop) {
      console.log(`Result: ${r?.result ?? "unknown"}`)
      console.log(`Summary: ${r?.summary ?? ""}`)
      const invs = r?.invocations as Array<{ agent: string; instruction: string; text: string }> | undefined
      if (invs && invs.length > 0) {
        console.log("\nAgent outputs:")
        for (const inv of invs) {
          console.log(`\n--- ${inv.agent} ---`)
          console.log(inv.text.slice(0, 2000))
        }
      }
    } else {
      console.log(`Approved: ${r?.approved ?? false}`)
      console.log(`Summary: ${r?.summary ?? ""}`)
      const outputs = r?.agentOutputs as Array<{ agent: string; text: string }> | undefined
      if (outputs && outputs.length > 0) {
        console.log("\nAgent outputs:")
        for (const out of outputs) {
          console.log(`\n--- ${out.agent} ---`)
          console.log(out.text.slice(0, 2000))
        }
      }
    }
  } finally {
    await handle.close()
    if (worktree) await worktree.remove()
  }
}

async function runAgent(cfg: Cfg, prompt: string) {
  const handle = connectOpencode(cfg)
  try {
    const mastra = await createMastra({ client: handle.client })
    const supervisor = mastra.getAgent("supervisor")

    console.log(`Agent: supervisor`)
    console.log(`Prompt: ${prompt}`)
    console.log()

    const result = await supervisor.generate(prompt)
    console.log()
    console.log(result.text)
  } finally {
    await handle.close()
  }
}

main(process.argv.slice(2)).catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err))
  process.exit(1)
})