export interface Worktree {
  path: string
  branch: string
  remove(): Promise<void>
}

export async function createWorktree(baseBranch: string, taskName: string): Promise<Worktree> {
  const slug = taskName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
  const branch = `orchestrator/${slug}-${Date.now().toString(36)}`
  const path = `.worktrees/${branch}`

  const proc = Bun.spawn(["git", "worktree", "add", "-b", branch, path, baseBranch], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const code = await proc.exited
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text()
    throw new Error(`git worktree add failed: ${stderr}`)
  }

  return {
    path,
    branch,
    async remove() {
      const p1 = Bun.spawn(["git", "worktree", "remove", "--force", path], { stdout: "pipe", stderr: "pipe" })
      await p1.exited
      const p2 = Bun.spawn(["git", "branch", "-D", branch], { stdout: "pipe", stderr: "pipe" })
      await p2.exited
    },
  }
}