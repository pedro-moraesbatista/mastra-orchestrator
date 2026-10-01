import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk"
import type { Agent, Session, Part, Message } from "@opencode-ai/sdk"
import type { AppConfig } from "../config.ts"

export type { OpencodeClient, Agent, Session, Part, Message }

export interface OpenCodeHandle {
  client: OpencodeClient
  close(): Promise<void>
}

export function connectOpencode(cfg: AppConfig): OpenCodeHandle {
  const url = `http://${cfg.opencode.hostname}:${cfg.opencode.port}`
  const client = createOpencodeClient({ baseUrl: url })
  return {
    client,
    async close() {},
  }
}

export async function healthCheck(client: OpencodeClient): Promise<boolean> {
  try {
    const res = await client.config.get()
    return !!res.data
  } catch {
    return false
  }
}

export async function detectVersion(): Promise<string | undefined> {
  try {
    const proc = Bun.spawn(["opencode", "--version"], { stdout: "pipe", stderr: "pipe" })
    const out = await new Response(proc.stdout).text()
    await proc.exited
    const m = out.match(/(\d+\.\d+\.\d+)/)
    return m?.[1]
  } catch {
    return undefined
  }
}

export function extractText(parts: Part[]): string {
  return parts
    .filter((p): p is Extract<Part, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n")
    .trim()
}