import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "fs"
import os from "os"
import path from "path"
import { readCompressionRunHistory } from "../src/compression-io.ts"
import { createEventHandler } from "../src/hooks.ts"
import type { CompressionRunRecord } from "../src/compression-run.ts"
import type { AssistantMessage, EventCommandExecuted, EventMessageUpdated, UserMessage } from "@opencode-ai/sdk"

let tmpDir: string
let statsPath: string
let pending: Map<string, CompressionRunRecord>

function makeCommandExecutedEvent(name = "memory-parse"): EventCommandExecuted {
  return {
    type: "command.executed",
    properties: {
      name,
      sessionID: "session-1",
      arguments: name === "memory-parse" ? "--full" : "",
      messageID: "cmd-1",
    },
  }
}

function makeAssistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    id: "assistant-1",
    sessionID: "session-1",
    role: "assistant",
    parentID: "cmd-1",
    modelID: "model-1",
    providerID: "provider-1",
    mode: "default",
    path: {
      cwd: tmpDir,
      root: tmpDir,
    },
    cost: 0.42,
    tokens: {
      input: 100,
      output: 50,
      reasoning: 10,
      cache: { read: 20, write: 5 },
    },
    time: {
      created: 100,
      completed: 200,
    },
    ...overrides,
  }
}

function makeAssistantUpdatedEvent(overrides: Partial<AssistantMessage> = {}): EventMessageUpdated {
  return {
    type: "message.updated",
    properties: {
      info: makeAssistantMessage(overrides),
    },
  }
}

function makeUserUpdatedEvent(overrides: Partial<UserMessage> = {}): EventMessageUpdated {
  return {
    type: "message.updated",
    properties: {
      info: {
        id: "user-1",
        sessionID: "session-1",
        role: "user",
        time: {
          created: 100,
        },
        agent: "test-agent",
        model: {
          providerID: "provider-1",
          modelID: "model-1",
        },
        ...overrides,
      },
    },
  }
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "hooks-test-"))
  statsPath = path.join(tmpDir, ".opencode", "memory-run-stats.json")
  pending = new Map()
})

afterEach(() => {
  mock.restore()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe("createEventHandler", () => {
  it("tracks memory-parse command executions as pending runs", async () => {
    const handler = createEventHandler(pending, statsPath)

    await handler({
      event: makeCommandExecutedEvent(),
    })

    const run = pending.get("session-1:cmd-1")
    expect(run).toBeDefined()
    expect(run?.status).toBe("pending")
    expect(run?.arguments).toBe("--full")
  })

  it("ignores non-memory-parse command executions", async () => {
    const handler = createEventHandler(pending, statsPath)

    await handler({
      event: makeCommandExecutedEvent("other-command"),
    })

    expect(pending.size).toBe(0)
  })

  it("completes a matching assistant update and persists it to history", async () => {
    const handler = createEventHandler(pending, statsPath)

    await handler({
      event: {
        ...makeCommandExecutedEvent(),
        properties: {
          ...makeCommandExecutedEvent().properties,
          arguments: "",
        },
      },
    })

    await handler({
      event: makeAssistantUpdatedEvent(),
    })

    expect(pending.size).toBe(0)
    const history = readCompressionRunHistory(statsPath)
    expect(history).toHaveLength(1)
    expect(history[0]?.assistantMessageID).toBe("assistant-1")
    expect(history[0]?.tokens?.total).toBe(185)
    expect(history[0]?.cost).toBe(0.42)
  })

  it("ignores assistant updates that do not match a pending run", async () => {
    const handler = createEventHandler(pending, statsPath)

    await handler({
      event: makeAssistantUpdatedEvent({ parentID: "unknown-cmd" }),
    })

    expect(pending.size).toBe(0)
    expect(readCompressionRunHistory(statsPath)).toEqual([])
  })

  it("ignores non-assistant or incomplete message updates", async () => {
    const handler = createEventHandler(pending, statsPath)

    await handler({
      event: {
        ...makeCommandExecutedEvent(),
        properties: {
          ...makeCommandExecutedEvent().properties,
          arguments: "",
        },
      },
    })

    await handler({
      event: makeUserUpdatedEvent(),
    })

    await handler({
      event: makeAssistantUpdatedEvent({
        time: {
          created: 100,
        },
      }),
    })

    expect(pending.size).toBe(1)
    expect(readCompressionRunHistory(statsPath)).toEqual([])
  })
})
