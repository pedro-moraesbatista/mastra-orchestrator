import type { OpencodeClient, Session, Part } from "./client.ts"
import { extractText } from "./client.ts"

export interface SessionManager {
  create(title?: string): Promise<Session>
  prompt(sessionId: string, text: string, opts?: { agent?: string; model?: { providerID: string; modelID: string } }): Promise<string>
  abort(sessionId: string): Promise<void>
  listMessages(sessionId: string): Promise<Array<{ info: { id: string }; parts: Part[] }>>
}

export function createSessionManager(client: OpencodeClient, directory?: string): SessionManager {
  const query = directory ? { directory } : {}

  return {
    async create(title?: string) {
      const res = await client.session.create({
        body: title ? { title } : undefined,
        query,
      })
      if (!res.data) throw new Error(`Failed to create session: ${res.error}`)
      return res.data
    },

    async prompt(sessionId, text, opts) {
      const res = await client.session.prompt({
        path: { id: sessionId },
        query,
        body: {
          agent: opts?.agent,
          model: opts?.model,
          parts: [{ type: "text", text }],
        },
      })
      if (!res.data) throw new Error(`Prompt failed: ${res.error}`)
      return extractText(res.data.parts)
    },

    async abort(sessionId) {
      await client.session.abort({ path: { id: sessionId }, query })
    },

    async listMessages(sessionId) {
      const res = await client.session.messages({ path: { id: sessionId }, query })
      if (!res.data) throw new Error(`Failed to list messages: ${res.error}`)
      return res.data
    },
  }
}