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

  // Lightweight approximation tuned to be deterministic and local-only.
  // For English-heavy markdown this tracks reasonably close to common BPE tokenizers.
  const estimatedTokens = Math.max(1, Math.ceil(utf8Bytes / 4))

  return {
    textLength: normalized.length,
    utf8Bytes,
    estimatedTokens,
  }
}
