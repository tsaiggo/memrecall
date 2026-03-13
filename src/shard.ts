import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from "fs"
import path from "path"
import type { ShardMeta, ShardContent } from "./types.ts"
import { MAX_SHARD_SIZE } from "./constants.ts"

const FRONTMATTER_REGEX = /^---\n([\s\S]*?)\n---\n?([\s\S]*)/

export function parseFrontmatter(content: string): { meta: Partial<ShardMeta>; body: string } {
  const match = content.match(FRONTMATTER_REGEX)
  if (!match) {
    return { meta: {}, body: content }
  }

  const yamlBlock = match[1] ?? ""
  const body = (match[2] ?? "").trim()
  const meta: Partial<ShardMeta> = {}

  for (const line of yamlBlock.split("\n")) {
    const colonIndex = line.indexOf(":")
    if (colonIndex === -1) continue
    const key = line.slice(0, colonIndex).trim()
    const value = line.slice(colonIndex + 1).trim()

    switch (key) {
      case "title":
        meta.title = value
        break
      case "summary":
        meta.summary = value
        break
      case "tags":
        meta.tags = value.split(",").map((t) => t.trim()).filter(Boolean)
        break
      case "created":
        meta.created = value
        break
      case "updated":
        meta.updated = value
        break
    }
  }

  return { meta, body }
}

export function serializeShard(shard: ShardContent): string {
  const lines = [
    "---",
    `title: ${shard.title}`,
    `summary: ${shard.summary}`,
    `tags: ${shard.tags.join(", ")}`,
    `created: ${shard.created}`,
    `updated: ${shard.updated}`,
    "---",
    "",
    shard.body,
  ]
  return lines.join("\n")
}

export function readShard(dir: string, slug: string): ShardContent | null {
  try {
    const filePath = path.join(dir, `${slug}.md`)
    if (!existsSync(filePath)) return null
    const content = readFileSync(filePath, "utf-8")
    const { meta, body } = parseFrontmatter(content)
    return {
      slug,
      title: meta.title ?? slug,
      summary: meta.summary ?? "",
      tags: meta.tags ?? [],
      created: meta.created ?? "",
      updated: meta.updated ?? "",
      body,
    }
  } catch {
    return null
  }
}

export function writeShard(dir: string, shard: ShardContent): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  let serialized = serializeShard(shard)
  const byteLength = Buffer.byteLength(serialized, "utf-8")

  if (byteLength > MAX_SHARD_SIZE) {
    // Truncate body to fit within MAX_SHARD_SIZE
    const frontmatter = serialized.slice(0, serialized.indexOf("---", 3) + 4)
    const frontmatterBytes = Buffer.byteLength(frontmatter, "utf-8")
    const availableBytes = MAX_SHARD_SIZE - frontmatterBytes - 50 // Reserve for truncation notice
    let truncatedBody = shard.body
    while (Buffer.byteLength(truncatedBody, "utf-8") > availableBytes) {
      truncatedBody = truncatedBody.slice(0, truncatedBody.length - 100)
    }
    truncatedBody += "\n\n[Content truncated to fit size limit]"
    serialized = serializeShard({ ...shard, body: truncatedBody })
  }

  const filePath = path.join(dir, `${shard.slug}.md`)
  writeFileSync(filePath, serialized, "utf-8")
}

export function listShards(dir: string): ShardMeta[] {
  if (!existsSync(dir)) return []

  const shards: ShardMeta[] = []
  const files = readdirSync(dir)

  for (const file of files) {
    if (!file.endsWith(".md")) continue
    const slug = file.slice(0, -3)
    try {
      const content = readFileSync(path.join(dir, file), "utf-8")
      const { meta } = parseFrontmatter(content)
      shards.push({
        slug,
        title: meta.title ?? slug,
        summary: meta.summary ?? "",
        tags: meta.tags ?? [],
        created: meta.created ?? "",
        updated: meta.updated ?? "",
      })
    } catch {
      continue
    }
  }

  return shards
}

export function deleteShard(dir: string, slug: string): boolean {
  try {
    const filePath = path.join(dir, `${slug}.md`)
    if (!existsSync(filePath)) return false
    unlinkSync(filePath)
    return true
  } catch {
    return false
  }
}
