import { AUTO_CORE_SHARD_PREFIX, CORE_BOOTSTRAP_TARGET_SIZE, MAX_MEMORY_SIZE, MAX_SHARD_SIZE } from "./constants.ts"
import { serializeShard } from "./shard.ts"
import { estimateTokens } from "./token.ts"

export interface GeneratedShardDraft {
  slug: string
  title: string
  summary: string
  tags: string[]
  body: string
}

export interface MemoryCompressionMetrics {
  originalBytes: number
  bootstrapBytes: number
  shardBytesTotal: number
  shardCount: number
  estimatedOriginalTokens: number
  estimatedBootstrapTokens: number
  estimatedShardTokensTotal: number
  estimatedBootstrapTokenDelta: number
}

export interface MemoryPlan {
  mode: "direct" | "sharded"
  originalContent: string
  bootstrapContent: string
  shards: GeneratedShardDraft[]
  metrics: MemoryCompressionMetrics
}

function truncateUtf8(input: string, maxBytes: number): string {
  if (Buffer.byteLength(input, "utf-8") <= maxBytes) {
    return input
  }

  return Buffer.from(input, "utf-8").subarray(0, maxBytes).toString("utf-8")
}

function sanitizeSlugPart(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return sanitized || "section"
}

function stripMarkdown(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/^\d+\.\s+/gm, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
}

function summarizeText(text: string, maxLength = 160): string {
  const flattened = stripMarkdown(text)
  if (!flattened) {
    return "Detailed memory notes preserved for progressive loading."
  }
  if (flattened.length <= maxLength) {
    return flattened
  }
  return flattened.slice(0, maxLength - 3).trimEnd() + "..."
}

function splitMarkdownSections(content: string): Array<{ title: string; body: string }> {
  const normalized = content.replace(/\r\n/g, "\n").trim()
  if (!normalized) {
    return []
  }

  const lines = normalized.split("\n")
  const sections: Array<{ title: string; body: string }> = []
  let currentTitle = "Overview"
  let currentLines: string[] = []

  const pushCurrent = () => {
    const body = currentLines.join("\n").trim()
    if (!body) {
      return
    }
    sections.push({ title: currentTitle, body })
  }

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/)
    if (headingMatch) {
      pushCurrent()
      currentTitle = (headingMatch[2] ?? "Overview").trim()
      currentLines = [line]
      continue
    }
    currentLines.push(line)
  }

  pushCurrent()
  return sections
}

function splitParagraphBlock(block: string, maxBytes: number): string[] {
  const chunks: string[] = []
  let remaining = block.trim()

  while (remaining) {
    if (Buffer.byteLength(remaining, "utf-8") <= maxBytes) {
      chunks.push(remaining)
      break
    }

    let sliceLength = remaining.length
    while (sliceLength > 0 && Buffer.byteLength(remaining.slice(0, sliceLength), "utf-8") > maxBytes) {
      sliceLength -= 1
    }

    if (sliceLength <= 0) {
      break
    }

    const candidate = remaining.slice(0, sliceLength)
    const splitAt = Math.max(candidate.lastIndexOf("\n"), candidate.lastIndexOf(" "))
    const safeIndex = splitAt > Math.floor(sliceLength / 2) ? splitAt : sliceLength
    chunks.push(remaining.slice(0, safeIndex).trim())
    remaining = remaining.slice(safeIndex).trim()
  }

  return chunks.filter(Boolean)
}

function splitOversizedSection(sectionBody: string): string[] {
  const paragraphs = sectionBody
    .split(/\n\s*\n/g)
    .map((part) => part.trim())
    .filter(Boolean)

  if (paragraphs.length === 0) {
    return [sectionBody.trim()].filter(Boolean)
  }

  const chunks: string[] = []
  let current = ""
  const bodyBudget = Math.max(1024, MAX_SHARD_SIZE - 512)

  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph
    if (Buffer.byteLength(candidate, "utf-8") <= bodyBudget) {
      current = candidate
      continue
    }

    if (current) {
      chunks.push(current)
    }

    if (Buffer.byteLength(paragraph, "utf-8") <= bodyBudget) {
      current = paragraph
      continue
    }

    const splitParagraphs = splitParagraphBlock(paragraph, bodyBudget)
    if (splitParagraphs.length === 0) {
      current = paragraph
      continue
    }

    chunks.push(...splitParagraphs.slice(0, -1))
    current = splitParagraphs[splitParagraphs.length - 1] ?? ""
  }

  if (current) {
    chunks.push(current)
  }

  return chunks.filter(Boolean)
}

function buildGeneratedCoreShards(content: string): GeneratedShardDraft[] {
  const sections = splitMarkdownSections(content)
  const fallbackSections = sections.length > 0 ? sections : [{ title: "Core Memory", body: content.trim() }]
  const shards: GeneratedShardDraft[] = []

  for (const section of fallbackSections) {
    const chunks = splitOversizedSection(section.body)
    const baseSlug = `${AUTO_CORE_SHARD_PREFIX}${sanitizeSlugPart(section.title)}`

    chunks.forEach((chunk, index) => {
      const partNumber = index + 1
      const isMultipart = chunks.length > 1
      const slug = isMultipart ? `${baseSlug}-part-${partNumber}` : baseSlug
      const title = isMultipart ? `${section.title} (Part ${partNumber})` : section.title
      const summary = summarizeText(chunk)

      shards.push({
        slug,
        title,
        summary,
        tags: ["core-memory", "generated", "overflow"],
        body: chunk,
      })
    })
  }

  return shards
}

function buildBootstrapMemory(originalContent: string, shards: GeneratedShardDraft[]): string {
  const summary = truncateUtf8(originalContent.trim(), CORE_BOOTSTRAP_TARGET_SIZE).trim()
  const shardLines = shards.map((shard) => `- \`${shard.slug}\`: ${shard.summary}`)
  const parts = [
    "# Core Memory Bootstrap",
    "",
    "This always-loaded file is the high-signal bootstrap for the project. Detailed memory was split into searchable shards to keep startup context compact.",
    "",
    "## Core Summary",
    summary || "- Detailed memory moved into generated shards.",
    "",
    "## Generated Overflow Shards",
    ...shardLines,
    "",
    "Use `memrecall_search` to discover the right shard by topic, or `memrecall_load` with a slug to pull the full detail on demand.",
  ]

  return truncateUtf8(parts.join("\n"), MAX_MEMORY_SIZE).trimEnd()
}

function buildMetrics(originalContent: string, bootstrapContent: string, shards: GeneratedShardDraft[]): MemoryCompressionMetrics {
  const original = estimateTokens(originalContent)
  const bootstrap = estimateTokens(bootstrapContent)
  const serializedShards = shards.map((shard) =>
    serializeShard({
      slug: shard.slug,
      title: shard.title,
      summary: shard.summary,
      tags: shard.tags,
      created: "1970-01-01",
      updated: "1970-01-01",
      body: shard.body,
    })
  )
  const shardBytesTotal = serializedShards.reduce((sum, shard) => sum + Buffer.byteLength(shard, "utf-8"), 0)
  const estimatedShardTokensTotal = shards.reduce(
    (sum, _shard, index) => sum + estimateTokens(serializedShards[index] ?? "").estimatedTokens,
    0
  )

  return {
    originalBytes: original.utf8Bytes,
    bootstrapBytes: bootstrap.utf8Bytes,
    shardBytesTotal,
    shardCount: shards.length,
    estimatedOriginalTokens: original.estimatedTokens,
    estimatedBootstrapTokens: bootstrap.estimatedTokens,
    estimatedShardTokensTotal,
    estimatedBootstrapTokenDelta: original.estimatedTokens - bootstrap.estimatedTokens,
  }
}

export function planMemoryWrite(content: string): MemoryPlan {
  const originalContent = content
  const originalBytes = Buffer.byteLength(originalContent, "utf-8")

  if (originalBytes <= MAX_MEMORY_SIZE) {
    const bootstrapContent = originalContent
    return {
      mode: "direct",
      originalContent,
      bootstrapContent,
      shards: [],
      metrics: buildMetrics(originalContent, bootstrapContent, []),
    }
  }

  const shards = buildGeneratedCoreShards(originalContent)
  const bootstrapContent = buildBootstrapMemory(originalContent, shards)

  return {
    mode: "sharded",
    originalContent,
    bootstrapContent,
    shards,
    metrics: buildMetrics(originalContent, bootstrapContent, shards),
  }
}
