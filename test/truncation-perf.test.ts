import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, readFileSync } from "fs"
import path from "path"
import os from "os"
import { writeShard } from "../src/shard.ts"
import { planMemoryWrite } from "../src/memory-planner.ts"
import type { ShardContent } from "../src/types.ts"

/**
 * Performance tests for truncation paths in shard.ts and memory-planner.ts.
 *
 * Current O(n) implementations:
 * - shard.ts:119-122: while loop slicing 100 chars per iteration with Buffer.byteLength each step
 * - memory-planner.ts:116-119: while loop slicing 1 char per iteration with Buffer.byteLength each step
 *
 * After optimization these should use binary search (truncateUtf8 or similar)
 * and complete in sub-millisecond time even for multi-MB inputs.
 */

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "trunc-perf-"))
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

function makeShard(overrides: Partial<ShardContent> = {}): ShardContent {
  return {
    slug: "perf-test",
    title: "Performance Test",
    summary: "Testing truncation performance",
    tags: ["test"],
    created: "2026-03-16",
    updated: "2026-03-16",
    body: "placeholder",
    ...overrides,
  }
}

describe("shard.ts truncation performance", () => {
  it("writeShard truncates a 200KB body efficiently (< 50ms)", () => {
    // Generate a body that's ~200KB — well over MAX_SHARD_SIZE (32768)
    // Using CJK characters (3 bytes each in UTF-8) to stress the byte-length mismatch
    const largeBody = "这是中文测试内容用于性能验证。".repeat(7000) // ~7000 * 42 bytes ≈ 294KB
    const shard = makeShard({ body: largeBody })

    const start = performance.now()
    writeShard(tmpDir, shard)
    const elapsed = performance.now() - start

    // The O(n/100) loop in shard.ts should still be fast enough for 200KB,
    // but this establishes a baseline. With binary search it should be <5ms.
    expect(elapsed).toBeLessThan(50)
  })

  it("writeShard truncates a 1MB body efficiently (< 100ms)", () => {
    // Generate ~1MB of CJK text to really stress the O(n/100) loop
    const largeBody = "这是中文测试内容用于性能验证。".repeat(25000) // ~25000 * 42 bytes ≈ 1MB
    const shard = makeShard({ body: largeBody })

    const start = performance.now()
    writeShard(tmpDir, shard)
    const elapsed = performance.now() - start

    // With O(n/100) loop and Buffer.byteLength per iteration, this gets slow.
    // Binary search should handle this in <10ms.
    expect(elapsed).toBeLessThan(100)
  })

  it("writeShard truncated output contains no replacement characters (U+FFFD)", () => {
    // Use multibyte characters to ensure truncation doesn't split in the middle of a codepoint
    const largeBody = "🎯🔥💡🚀✨".repeat(10000) // emoji: 4 bytes each
    const shard = makeShard({ body: largeBody })

    writeShard(tmpDir, shard)

    const content = readFileSync(path.join(tmpDir, "perf-test.md"), "utf-8")
    expect(content).not.toContain("\uFFFD")
    expect(content).toContain("[Content truncated to fit size limit]")
  })

  it("writeShard truncated output fits within MAX_SHARD_SIZE", () => {
    const MAX_SHARD_SIZE = 32 * 1024 // 32768 bytes
    const largeBody = "这是中文测试内容。".repeat(10000)
    const shard = makeShard({ body: largeBody })

    writeShard(tmpDir, shard)

    const content = readFileSync(path.join(tmpDir, "perf-test.md"), "utf-8")
    const byteLength = Buffer.byteLength(content, "utf-8")
    expect(byteLength).toBeLessThanOrEqual(MAX_SHARD_SIZE)
  })
})

describe("memory-planner.ts splitParagraphBlock performance (via planMemoryWrite)", () => {
  it("planMemoryWrite handles 500KB content with single large paragraph efficiently (< 200ms)", () => {
    // Create content that exceeds MAX_MEMORY_SIZE (65536 bytes) and consists of
    // a single giant paragraph — this forces splitParagraphBlock's O(n) char-by-char loop.
    // The paragraph has NO newlines or spaces for splitting, maximizing the O(n) pain.
    const MAX_MEMORY_SIZE = 64 * 1024

    // Build a single heading + one massive paragraph with no natural split points
    // Using CJK chars: each is 3 bytes, no spaces, forces char-by-char loop in splitParagraphBlock
    const hugeNonBreakableParagraph = "这".repeat(170000) // ~510KB, single block
    const content = `# Oversized Memory\n\n${hugeNonBreakableParagraph}`

    const start = performance.now()
    const plan = planMemoryWrite(content)
    const elapsed = performance.now() - start

    // The O(n) char-by-char loop in splitParagraphBlock (sliceLength -= 1) is extremely
    // slow for large inputs. With a 170K-char string and ~32KB target per shard,
    // each split iteration scans up to 170K times. Binary search would be O(log n).
    expect(elapsed).toBeLessThan(200)

    // Verify the plan was sharded (content exceeds MAX_MEMORY_SIZE)
    expect(plan.mode).toBe("sharded")
    expect(plan.shards.length).toBeGreaterThan(0)
  })

  it("planMemoryWrite handles 1MB content with mixed paragraphs efficiently (< 500ms)", () => {
    // More realistic: large content with some paragraph breaks but some large paragraphs
    const bigParagraph = "测试内容验证".repeat(20000) // ~120KB per paragraph, no spaces
    const content = [
      "# Section A",
      "",
      bigParagraph,
      "",
      "# Section B",
      "",
      bigParagraph,
      "",
      "# Section C",
      "",
      bigParagraph,
    ].join("\n")

    const start = performance.now()
    const plan = planMemoryWrite(content)
    const elapsed = performance.now() - start

    // Each ~120KB paragraph triggers splitParagraphBlock's O(n) loop multiple times.
    // Total is ~360KB of CJK content. Current implementation can take seconds.
    expect(elapsed).toBeLessThan(500)

    expect(plan.mode).toBe("sharded")
    expect(plan.shards.length).toBeGreaterThan(0)

    // Verify no shard body contains U+FFFD
    for (const shard of plan.shards) {
      expect(shard.body).not.toContain("\uFFFD")
    }
  })

  it("planMemoryWrite shard bodies contain no replacement characters", () => {
    // Use emoji (4-byte UTF-8) to maximize risk of mid-codepoint truncation
    const emojiParagraph = "🎯🔥💡🚀✨🎯🔥💡🚀✨".repeat(5000) // ~200KB
    const content = `# Emoji Memory\n\n${emojiParagraph}`

    const plan = planMemoryWrite(content)

    expect(plan.mode).toBe("sharded")
    for (const shard of plan.shards) {
      expect(shard.body).not.toContain("\uFFFD")
    }
  })
})
