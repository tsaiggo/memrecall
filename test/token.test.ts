import { describe, expect, it } from "bun:test"
import { estimateTokens } from "../src/token.ts"

describe("estimateTokens", () => {
  it("returns zero for empty text", () => {
    expect(estimateTokens("").estimatedTokens).toBe(0)
  })

  it("estimates tokens deterministically from utf8 bytes", () => {
    const sample = "hello world"
    const result = estimateTokens(sample)

    expect(result.utf8Bytes).toBe(Buffer.byteLength(sample, "utf-8"))
    expect(result.estimatedTokens).toBe(Math.ceil(Buffer.byteLength(sample, "utf-8") / 4))
  })
})
