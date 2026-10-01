type LogLevel = "debug" | "info" | "warn" | "error" | "fatal"

interface LogEntry {
  level: LogLevel
  msg: string
  data?: Record<string, unknown>
  timestamp: string
  traceId?: string
  spanId?: string
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  fatal: 4,
}

const minLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) ?? "info"

const inMemoryLogs: LogEntry[] = []
const MAX_LOGS = 5000

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[minLevel]
}

function log(level: LogLevel, msg: string, data?: Record<string, unknown>, traceCtx?: { traceId?: string; spanId?: string }) {
  if (!shouldLog(level)) return
  const entry: LogEntry = {
    level,
    msg,
    data,
    timestamp: new Date().toISOString(),
    ...traceCtx,
  }
  inMemoryLogs.push(entry)
  if (inMemoryLogs.length > MAX_LOGS) inMemoryLogs.shift()

  const prefix = `[${entry.timestamp}] [${level.toUpperCase()}]`
  const traceStr = traceCtx?.traceId ? ` [trace:${traceCtx.traceId.slice(0, 8)}]` : ""
  const dataStr = data ? ` ${JSON.stringify(data)}` : ""
  const line = `${prefix}${traceStr} ${msg}${dataStr}`

  if (level === "error" || level === "fatal") console.error(line)
  else if (level === "warn") console.warn(line)
  else console.log(line)
}

export const logger = {
  debug: (msg: string, data?: Record<string, unknown>, traceCtx?: { traceId?: string; spanId?: string }) =>
    log("debug", msg, data, traceCtx),
  info: (msg: string, data?: Record<string, unknown>, traceCtx?: { traceId?: string; spanId?: string }) =>
    log("info", msg, data, traceCtx),
  warn: (msg: string, data?: Record<string, unknown>, traceCtx?: { traceId?: string; spanId?: string }) =>
    log("warn", msg, data, traceCtx),
  error: (msg: string, data?: Record<string, unknown>, traceCtx?: { traceId?: string; spanId?: string }) =>
    log("error", msg, data, traceCtx),
  fatal: (msg: string, data?: Record<string, unknown>, traceCtx?: { traceId?: string; spanId?: string }) =>
    log("fatal", msg, data, traceCtx),
  getLogs: (filter?: { level?: LogLevel; traceId?: string; limit?: number }): LogEntry[] => {
    let result = inMemoryLogs
    if (filter?.level) result = result.filter((e) => LEVEL_ORDER[e.level] >= LEVEL_ORDER[filter.level!])
    if (filter?.traceId) result = result.filter((e) => e.traceId === filter.traceId)
    const limit = filter?.limit ?? 100
    return result.slice(-limit)
  },
  clearLogs: () => { inMemoryLogs.length = 0 },
}