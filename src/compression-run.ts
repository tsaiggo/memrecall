export interface CompressionRunTokens {
  input: number
  output: number
  reasoning: number
  cache: {
    read: number
    write: number
  }
  total: number
}

export interface CompressionRunRecord {
  sessionID: string
  commandMessageID: string
  assistantMessageID?: string
  arguments: string
  status: "pending" | "completed"
  startedAt: number
  completedAt?: number
  cost?: number
  tokens?: CompressionRunTokens
}

export function totalCompressionTokens(tokens: Omit<CompressionRunTokens, "total">): CompressionRunTokens {
  return {
    ...tokens,
    total: tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write,
  }
}

export function createPendingCompressionRun(input: {
  sessionID: string
  commandMessageID: string
  arguments: string
  startedAt?: number
}): CompressionRunRecord {
  return {
    sessionID: input.sessionID,
    commandMessageID: input.commandMessageID,
    arguments: input.arguments,
    status: "pending",
    startedAt: input.startedAt ?? Date.now(),
  }
}

export function completeCompressionRun(
  run: CompressionRunRecord,
  assistant: {
    id: string
    parentID: string
    sessionID: string
    cost: number
    tokens: {
      input: number
      output: number
      reasoning: number
      cache: {
        read: number
        write: number
      }
    }
  },
  completedAt?: number
): CompressionRunRecord | null {
  if (run.sessionID !== assistant.sessionID || run.commandMessageID !== assistant.parentID) {
    return null
  }

  return {
    ...run,
    assistantMessageID: assistant.id,
    status: "completed",
    completedAt: completedAt ?? Date.now(),
    cost: assistant.cost,
    tokens: totalCompressionTokens(assistant.tokens),
  }
}

export function upsertCompressionRunHistory(
  history: CompressionRunRecord[],
  run: CompressionRunRecord,
  limit = 20
): CompressionRunRecord[] {
  const deduped = history.filter(
    (item) => !(item.sessionID === run.sessionID && item.commandMessageID === run.commandMessageID)
  )
  return [run, ...deduped]
    .sort((a, b) => (b.completedAt ?? b.startedAt) - (a.completedAt ?? a.startedAt))
    .slice(0, limit)
}
