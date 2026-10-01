export interface AppConfig {
  opencode: {
    hostname: string
    port: number
  }
  mastra: {
    port: number
  }
  modelProvider: string
  modelName: string
  allowedPaths: string[]
}

function env(key: string, fallback: string): string {
  const v = process.env[key]
  return v && v.length > 0 ? v : fallback
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key]
  if (!raw) return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isNaN(n) ? fallback : n
}

function envList(key: string, fallback: string[]): string[] {
  const raw = process.env[key]
  if (!raw) return fallback
  return raw.split(";").map((s) => s.trim()).filter(Boolean)
}

export function loadConfig(): AppConfig {
  return {
    opencode: {
      hostname: env("OPENCODE_HOSTNAME", "127.0.0.1"),
      port: envInt("OPENCODE_PORT", 4096),
    },
    mastra: {
      port: envInt("MASTRA_PORT", 4111),
    },
  modelProvider: env("MASTRA_MODEL_PROVIDER", "ollama-cloud"),
  modelName: env("MASTRA_MODEL_NAME", "glm-5.2"),
    allowedPaths: envList("OPENCODE_ALLOWED_PATHS", []),
  }
}