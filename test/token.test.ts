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

  it("estimates more tokens for CJK text than pure utf8Bytes/4", () => {
    // CJK chars are 3 bytes each in UTF-8 but typically ~1-2 tokens each in BPE
    // Current impl: Math.ceil(36/4) = 9 tokens for 12 CJK chars
    // Better estimate: ~12 tokens (1 token per CJK char is common in modern tokenizers)
    const cjkText = "这是一段中文测试文本内容呢"  // 12 CJK chars = 36 UTF-8 bytes
    const result = estimateTokens(cjkText)
    const naiveEstimate = Math.ceil(result.utf8Bytes / 4)

    // The improved estimator should return MORE tokens than the naive utf8Bytes/4
    expect(result.estimatedTokens).toBeGreaterThan(naiveEstimate)
  })

  it("estimates similar tokens for English text as utf8Bytes/4", () => {
    // English text: ~4 bytes per token is reasonable
    // This test ensures the improvement doesn't break English estimation
    const englishText = "This is a test of the English language token estimation system"
    const result = estimateTokens(englishText)
    const naiveEstimate = Math.ceil(result.utf8Bytes / 4)

    // For English, the estimate should be close to the naive approach (within 2x)
    expect(result.estimatedTokens).toBeGreaterThanOrEqual(naiveEstimate)
    expect(result.estimatedTokens).toBeLessThan(naiveEstimate * 2)
  })

  it("handles mixed CJK and English text", () => {
    const mixedText = "Hello 世界 World 你好"
    const result = estimateTokens(mixedText)
    // Mixed text should also account for CJK portions
    expect(result.estimatedTokens).toBeGreaterThan(0)
    expect(result.utf8Bytes).toBeGreaterThan(result.textLength) // CJK chars are multi-byte
  })
})
