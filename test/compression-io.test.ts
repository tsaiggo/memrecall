import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import os from "os"
import path from "path"
import {
  persistCompressionRun,
  readCompressionRunHistory,
  writeCompressionRunHistory,
} from "../src/compression-io.ts"
import type { CompressionRunRecord } from "../src/compression-run.ts"

let tmpDir: string
let statsPath: string

function makeRun(overrides: Partial<CompressionRunRecord> = {}): CompressionRunRecord {
  return {
    sessionID: "session-1",
    commandMessageID: "cmd-1",
    assistantMessageID: "assistant-1",
    arguments: "",
    status: "completed",
    startedAt: 100,
    completedAt: 200,
    cost: 0.12,
    tokens: {
      input: 100,
      output: 50,
      reasoning: 10,
      cache: { read: 20, write: 5 },
      total: 185,
    },
    ...overrides,
  }
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "compression-io-test-"))
  statsPath = path.join(tmpDir, ".opencode", "memory-run-stats.json")
  mkdirSync(path.dirname(statsPath), { recursive: true })
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe("compression-io", () => {
  it("returns empty history when the stats file does not exist", () => {
    expect(readCompressionRunHistory(statsPath)).toEqual([])
  })

  it("returns empty history when the stats file contains invalid JSON", () => {
    writeFileSync(statsPath, "{not valid json", "utf-8")
    expect(readCompressionRunHistory(statsPath)).toEqual([])
  })

  it("writes history to disk and can read it back", () => {
    const history = [makeRun()]
    writeCompressionRunHistory(statsPath, history)

    expect(existsSync(statsPath)).toBe(true)
    expect(readCompressionRunHistory(statsPath)).toEqual(history)
  })

  it("persists runs with deduplication by session and command message", () => {
    const first = makeRun({ completedAt: 200, tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 }, total: 15 } })
    const updated = makeRun({ completedAt: 300, cost: 0.34, tokens: { input: 10, output: 20, reasoning: 30, cache: { read: 40, write: 50 }, total: 150 } })

    persistCompressionRun(statsPath, first)
    persistCompressionRun(statsPath, updated)

    const history = readCompressionRunHistory(statsPath)
    expect(history).toHaveLength(1)
    expect(history[0]?.completedAt).toBe(300)
    expect(history[0]?.cost).toBe(0.34)
    expect(history[0]?.tokens?.total).toBe(150)
  })

  it("keeps newest runs first when persisting different command runs", () => {
    const older = makeRun({ commandMessageID: "cmd-older", completedAt: 200 })
    const newer = makeRun({ commandMessageID: "cmd-newer", completedAt: 400 })

    persistCompressionRun(statsPath, older)
    persistCompressionRun(statsPath, newer)

    const history = JSON.parse(readFileSync(statsPath, "utf-8")) as CompressionRunRecord[]
    expect(history.map((run) => run.commandMessageID)).toEqual(["cmd-newer", "cmd-older"])
  })
})
