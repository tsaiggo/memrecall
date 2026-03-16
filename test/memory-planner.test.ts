import { describe, expect, it } from "bun:test"
import { AUTO_CORE_SHARD_PREFIX, MAX_MEMORY_SIZE } from "../src/constants.ts"
import { planMemoryWrite, truncateUtf8 } from "../src/memory-planner.ts"

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

describe("planMemoryWrite", () => {
  it("keeps small memory as direct bootstrap", () => {
    const content = "# Memory\n\n- concise note"
    const plan = planMemoryWrite(content)

    expect(plan.mode).toBe("direct")
    expect(plan.bootstrapContent).toBe(content)
    expect(plan.shards.length).toBe(0)
    expect(plan.metrics.shardCount).toBe(0)
    expect(plan.metrics.estimatedBootstrapTokenDelta).toBe(0)
  })

  it("splits oversized memory into generated shards and smaller bootstrap", () => {
    const content = buildLargeMemory()
    expect(Buffer.byteLength(content, "utf-8")).toBeGreaterThan(MAX_MEMORY_SIZE)

    const plan = planMemoryWrite(content)

    expect(plan.mode).toBe("sharded")
    expect(plan.shards.length).toBeGreaterThan(0)
    expect(plan.bootstrapContent).toContain("# Core Memory Bootstrap")
    expect(plan.bootstrapContent).toContain("## Generated Overflow Shards")
    expect(plan.shards.every((shard) => shard.slug.startsWith(AUTO_CORE_SHARD_PREFIX))).toBe(true)
    expect(plan.metrics.shardCount).toBe(plan.shards.length)
    expect(plan.metrics.shardBytesTotal).toBeGreaterThan(0)
    expect(plan.metrics.estimatedShardTokensTotal).toBeGreaterThan(0)
    expect(plan.metrics.estimatedOriginalTokens).toBeGreaterThan(plan.metrics.estimatedBootstrapTokens)
    expect(plan.metrics.estimatedBootstrapTokenDelta).toBeGreaterThan(0)
  })

  it("creates multipart shard slugs when a single section is very large", () => {

    const veryLargeSection = ["# Memory", "", "## Giant Section"]
    for (let i = 0; i < 2000; i++) {
      veryLargeSection.push(`Paragraph ${i} with extra text to force large output and section splitting across shard boundaries.`)
      veryLargeSection.push("")
    }

    const plan = planMemoryWrite(veryLargeSection.join("\n"))
    expect(plan.mode).toBe("sharded")
    expect(plan.shards.some((shard) => shard.slug.includes("-part-"))).toBe(true)
  })
})

describe("truncateUtf8", () => {
  it("truncates CJK text at character boundary without U+FFFD", () => {
    // "Hello " = 6 bytes, "你" = 3 bytes = 9 total, "好" would be 12
    // maxBytes=10 → should return "Hello 你" (9 bytes), NOT "Hello 你\uFFFD"
    const result = truncateUtf8("Hello 你好世界", 10)
    expect(result).toBe("Hello 你")
    expect(result).not.toContain("\uFFFD")
    expect(Buffer.byteLength(result, "utf-8")).toBeLessThanOrEqual(10)
  })

  it("truncates emoji at 4-byte boundary without U+FFFD", () => {
    // "🎉" = 4 bytes, "🎊" = 4 bytes
    // maxBytes=5 → should return "🎉" (4 bytes), NOT "🎉\uFFFD"
    const result = truncateUtf8("🎉🎊", 5)
    expect(result).toBe("🎉")
    expect(result).not.toContain("\uFFFD")
    expect(Buffer.byteLength(result, "utf-8")).toBeLessThanOrEqual(5)
  })

  it("returns full string when no truncation needed", () => {
    expect(truncateUtf8("abc", 3)).toBe("abc")
    expect(truncateUtf8("abc", 100)).toBe("abc")
  })

  it("returns empty string for empty input", () => {
    expect(truncateUtf8("", 10)).toBe("")
  })

  it("never produces U+FFFD for any mid-character cut", () => {
    // 2-byte char: "é" (U+00E9) = 2 bytes
    const result2 = truncateUtf8("éé", 3)
    expect(result2).not.toContain("\uFFFD")
    expect(Buffer.byteLength(result2, "utf-8")).toBeLessThanOrEqual(3)

    // 3-byte char: "你" (U+4F60) = 3 bytes
    const result3 = truncateUtf8("你好", 4)
    expect(result3).not.toContain("\uFFFD")
    expect(Buffer.byteLength(result3, "utf-8")).toBeLessThanOrEqual(4)

    // 4-byte char: "𝕳" (U+1D573) = 4 bytes
    const result4 = truncateUtf8("𝕳𝕳", 5)
    expect(result4).not.toContain("\uFFFD")
    expect(Buffer.byteLength(result4, "utf-8")).toBeLessThanOrEqual(5)
  })

  it("output byte length never exceeds maxBytes", () => {
    const inputs = ["Hello 你好世界", "🎉🎊🎈🎁", "café résumé naïve", "𝕳𝕴𝕵𝕶"]
    for (const input of inputs) {
      for (let max = 0; max <= 20; max++) {
        const result = truncateUtf8(input, max)
        expect(Buffer.byteLength(result, "utf-8")).toBeLessThanOrEqual(max)
        expect(result).not.toContain("\uFFFD")
      }
    }
  })
})
