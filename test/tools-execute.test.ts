import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "fs"
import os from "os"
import path from "path"
import { MEMORIES_DIR, MEMORY_FILE, MAX_MEMORY_SIZE, MAX_SHARDS } from "../src/constants.ts"
import { MemoryIndex } from "../src/index-db.ts"
import { listShards, readShard, writeShard } from "../src/shard.ts"
import { createTools } from "../src/tools.ts"
import type { ToolContext } from "@opencode-ai/plugin"

let tmpDir: string
let memoriesDir: string
let compressionRunStatsPath: string
let index: MemoryIndex

function makeToolContext(): ToolContext {
  return {
    sessionID: "session-1",
    messageID: "message-1",
    agent: "test-agent",
    directory: tmpDir,
    worktree: tmpDir,
    abort: new AbortController().signal,
    metadata() {},
    ask: async () => {},
  }
}

function createSubject() {
  return createTools(
    {
      directory: tmpDir,
      client: {
        session: {
          async list() {
            return { data: [] }
          },
          async messages() {
            return { data: [] }
          },
        },
      },
    },
    index,
    memoriesDir,
    compressionRunStatsPath,
    "No memory shards available yet."
  )
}

function buildLargeMemory(sectionCount = 8, linesPerSection = 150): string {
  const parts = ["# Memory", "", "Project memory bootstrap"]

  for (let i = 1; i <= sectionCount; i++) {
    parts.push(`## Section ${i}`)
    for (let j = 0; j < linesPerSection; j++) {
      parts.push(`- Detail ${j} for section ${i}: architecture decisions, coding preferences, workflow context, and implementation notes.`)
    }
    parts.push("")
  }

  return parts.join("\n")
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "tools-execute-test-"))
  memoriesDir = path.join(tmpDir, MEMORIES_DIR)
  compressionRunStatsPath = path.join(tmpDir, ".opencode", "memory-run-stats.json")
  mkdirSync(path.join(tmpDir, ".opencode"), { recursive: true })
  index = new MemoryIndex(path.join(tmpDir, ".opencode", "memory-index.db"))
})

afterEach(() => {
  if (index) {
    index.close()
  }
  rmSync(tmpDir, { recursive: true, force: true })
})

describe("createTools execute paths", () => {
  it("writes small core memory directly to memory.md", async () => {
    const tools = createSubject()
    const result = await tools.memrecall_write.execute(
      { content: "# Memory\n\n- concise note" },
      makeToolContext()
    )

    const memoryPath = path.join(tmpDir, MEMORY_FILE)
    expect(existsSync(memoryPath)).toBe(true)
    expect(readFileSync(memoryPath, "utf-8")).toBe("# Memory\n\n- concise note")
    expect(result).toContain("Memory profile written to .opencode/memory.md")
  })

  it("splits oversized memory into generated shards and removes old generated core shards", async () => {
    const tools = createSubject()

    writeShard(memoriesDir, {
      slug: "core-auto-old-topic",
      title: "Old Generated",
      summary: "Old generated shard",
      tags: ["generated"],
      created: "2026-03-16",
      updated: "2026-03-16",
      body: "stale generated body",
    })
    index.upsertShard({
      slug: "core-auto-old-topic",
      title: "Old Generated",
      summary: "Old generated shard",
      tags: ["generated"],
      body: "stale generated body",
      mtime: Date.now(),
      access_count: 0,
    })

    writeShard(memoriesDir, {
      slug: "manual-note",
      title: "Manual Note",
      summary: "User-authored shard",
      tags: ["manual"],
      created: "2026-03-16",
      updated: "2026-03-16",
      body: "keep me",
    })
    index.upsertShard({
      slug: "manual-note",
      title: "Manual Note",
      summary: "User-authored shard",
      tags: ["manual"],
      body: "keep me",
      mtime: Date.now(),
      access_count: 0,
    })

    const largeContent = buildLargeMemory()
    expect(Buffer.byteLength(largeContent, "utf-8")).toBeGreaterThan(MAX_MEMORY_SIZE)

    const result = await tools.memrecall_write.execute(
      { content: largeContent },
      makeToolContext()
    )

    const memoryPath = path.join(tmpDir, MEMORY_FILE)
    const bootstrap = readFileSync(memoryPath, "utf-8")
    const shardSlugs = listShards(memoriesDir).map((shard) => shard.slug)

    expect(bootstrap).toContain("# Core Memory Bootstrap")
    expect(result).toContain("generated")
    expect(readShard(memoriesDir, "core-auto-old-topic")).toBeNull()
    expect(index.search("stale", 5)).toEqual([])
    expect(readShard(memoriesDir, "manual-note")?.body).toBe("keep me")
    expect(shardSlugs.some((slug) => slug.startsWith("core-auto-"))).toBe(true)
    expect(index.search("architecture", 20).some((entry) => entry.slug.startsWith("core-auto-"))).toBe(true)
  })

  it("rejects creating a new shard when the shard limit has been reached", async () => {
    const tools = createSubject()

    for (let i = 0; i < MAX_SHARDS; i++) {
      await tools.memrecall_write_shard.execute(
        {
          slug: `shard-${i}`,
          title: `Shard ${i}`,
          summary: `Summary ${i}`,
          tags: "test,limit",
          body: `Body ${i}`,
        },
        makeToolContext()
      )
    }

    await expect(
      tools.memrecall_write_shard.execute(
        {
          slug: "overflow-shard",
          title: "Overflow",
          summary: "Should fail",
          tags: "test,limit",
          body: "This should not be written",
        },
        makeToolContext()
      )
    ).rejects.toThrow(`the ${MAX_SHARDS}-shard limit has been reached`)
  })

  it("lists stale shards and prunes a selected shard", async () => {
    const tools = createSubject()

    writeShard(memoriesDir, {
      slug: "stale-zero",
      title: "Stale Zero",
      summary: "Never loaded",
      tags: ["stale"],
      created: "2026-03-16",
      updated: "2026-03-16",
      body: "old shard",
    })
    writeShard(memoriesDir, {
      slug: "active-note",
      title: "Active Note",
      summary: "Frequently used",
      tags: ["active"],
      created: "2026-03-16",
      updated: "2026-03-16",
      body: "active shard",
    })

    index.upsertShard({
      slug: "stale-zero",
      title: "Stale Zero",
      summary: "Never loaded",
      tags: ["stale"],
      body: "old shard",
      mtime: Date.now(),
      access_count: 0,
    })
    index.upsertShard({
      slug: "active-note",
      title: "Active Note",
      summary: "Frequently used",
      tags: ["active"],
      body: "active shard",
      mtime: Date.now(),
      access_count: 3,
    })

    const staleList = await tools.memrecall_prune.execute({}, makeToolContext())
    expect(staleList).toContain("stale-zero")
    expect(staleList).not.toContain("active-note")

    const pruneResult = await tools.memrecall_prune.execute(
      { slug: "stale-zero" },
      makeToolContext()
    )

    expect(pruneResult).toBe("Pruned memory shard: stale-zero")
    expect(readShard(memoriesDir, "stale-zero")).toBeNull()
    expect(index.search("old", 5)).toEqual([])
  })
})
