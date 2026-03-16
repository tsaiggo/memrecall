import { describe, expect, it } from "bun:test"
import { AUTO_CORE_SHARD_PREFIX, MAX_MEMORY_SIZE } from "../src/constants.ts"
import { planMemoryWrite } from "../src/memory-planner.ts"

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
