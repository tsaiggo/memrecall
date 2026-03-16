import { describe, expect, it } from "bun:test"
import {
  completeCompressionRun,
  createPendingCompressionRun,
  totalCompressionTokens,
  upsertCompressionRunHistory,
} from "../src/compression-run.ts"

describe("compression run accounting", () => {
  it("creates pending runs for memory-parse commands", () => {
    const run = createPendingCompressionRun({
      sessionID: "session-1",
      commandMessageID: "msg-1",
      arguments: "",
      startedAt: 123,
    })

    expect(run.status).toBe("pending")
    expect(run.sessionID).toBe("session-1")
    expect(run.commandMessageID).toBe("msg-1")
    expect(run.startedAt).toBe(123)
  })

  it("completes runs with actual assistant token usage", () => {
    const run = createPendingCompressionRun({
      sessionID: "session-1",
      commandMessageID: "msg-1",
      arguments: "",
      startedAt: 100,
    })

    const completed = completeCompressionRun(
      run,
      {
        id: "assistant-1",
        parentID: "msg-1",
        sessionID: "session-1",
        cost: 0.12,
        tokens: {
          input: 100,
          output: 50,
          reasoning: 10,
          cache: { read: 20, write: 5 },
        },
      },
      200
    )

    expect(completed).not.toBeNull()
    expect(completed?.status).toBe("completed")
    expect(completed?.tokens?.total).toBe(185)
    expect(completed?.cost).toBe(0.12)
  })

  it("deduplicates history by session and command message id", () => {
    const a = createPendingCompressionRun({
      sessionID: "session-1",
      commandMessageID: "msg-1",
      arguments: "",
      startedAt: 100,
    })
    const b = { ...a, status: "completed" as const, completedAt: 200 }
    const c = { ...a, status: "completed" as const, completedAt: 300 }

    const history = upsertCompressionRunHistory([b], c)
    expect(history).toHaveLength(1)
    expect(history[0]?.completedAt).toBe(300)
  })

  it("sums token totals consistently", () => {
    const total = totalCompressionTokens({
      input: 10,
      output: 20,
      reasoning: 30,
      cache: { read: 40, write: 50 },
    })

    expect(total.total).toBe(150)
  })
})
