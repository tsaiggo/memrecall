import {
  completeCompressionRun,
  createPendingCompressionRun,
  type CompressionRunRecord,
} from "./compression-run.ts"
import { persistCompressionRun } from "./compression-io.ts"

export function createEventHandler(
  pendingCompressionRuns: Map<string, CompressionRunRecord>,
  compressionRunStatsPath: string
) {
  return async ({ event }: { event: any }) => {
    if (event.type === "command.executed" && event.properties.name === "memory-parse") {
      const run = createPendingCompressionRun({
        sessionID: event.properties.sessionID,
        commandMessageID: event.properties.messageID,
        arguments: event.properties.arguments,
      })
      pendingCompressionRuns.set(`${run.sessionID}:${run.commandMessageID}`, run)
      return
    }

    if (event.type !== "message.updated") {
      return
    }

    const info = event.properties.info
    if (info.role !== "assistant" || !info.time.completed) {
      return
    }

    const key = `${info.sessionID}:${info.parentID}`
    const pending = pendingCompressionRuns.get(key)
    if (!pending) {
      return
    }

    const completed = completeCompressionRun(
      pending,
      {
        id: info.id,
        parentID: info.parentID,
        sessionID: info.sessionID,
        cost: info.cost,
        tokens: info.tokens,
      },
      info.time.completed
    )

    if (!completed) {
      return
    }

    pendingCompressionRuns.delete(key)
    persistCompressionRun(compressionRunStatsPath, completed)
  }
}
