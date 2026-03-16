export interface TokenEstimate {
  textLength: number
  utf8Bytes: number
  estimatedTokens: number
}

export function estimateTokens(text: string): TokenEstimate {
  const normalized = text.replace(/\r\n/g, "\n")
  const utf8Bytes = Buffer.byteLength(normalized, "utf-8")

  if (!normalized) {
    return {
      textLength: 0,
      utf8Bytes,
      estimatedTokens: 0,
    }
  }

  // Count CJK characters (CJK Unified Ideographs + Extension A)
  // CJK chars are 3 UTF-8 bytes but ~1.5 tokens each in modern BPE tokenizers (cl100k_base, o200k_base)
  const cjkMatches = normalized.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g)
  const cjkCount = cjkMatches ? cjkMatches.length : 0

  const cjkBytes = cjkCount * 3
  const nonCjkBytes = utf8Bytes - cjkBytes
  const cjkTokens = cjkCount * 1.5
  const nonCjkTokens = nonCjkBytes / 4

  const estimatedTokens = Math.max(1, Math.ceil(cjkTokens + nonCjkTokens))

  return {
    textLength: normalized.length,
    utf8Bytes,
    estimatedTokens,
  }
}
