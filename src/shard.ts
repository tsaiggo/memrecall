import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from "fs"
import path from "path"
import type { ShardMeta, ShardContent } from "./types.ts"
import { MAX_SHARD_SIZE } from "./constants.ts"

const FRONTMATTER_REGEX = /^---\n([\s\S]*?)\n---\n?([\s\S]*)/

const VALID_SLUG_REGEX = /^[a-z0-9][a-z0-9_-]*$/

export function validateSlug(slug: string): void {
  if (!slug || typeof slug !== "string") {
    throw new Error("Shard slug must be a non-empty string")
  }
  if (slug.includes("..") || slug.includes("/") || slug.includes("\\")) {
    throw new Error(`Invalid shard slug "${slug}": contains path traversal characters`)
  }
  if (!VALID_SLUG_REGEX.test(slug)) {
    throw new Error(`Invalid shard slug "${slug}": must be lowercase alphanumeric with hyphens or underscores, starting with alphanumeric`)
  }
}

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
    // Warn on invalid slug but don't crash — backward compatibility for existing shards
    if (!slug || slug.includes("..") || slug.includes("/") || slug.includes("\\") || !VALID_SLUG_REGEX.test(slug)) {
      console.warn(`[memrecall] readShard: invalid slug "${slug}", skipping`)
      return null
    }
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
  validateSlug(shard.slug)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  let serialized = serializeShard(shard)
  const byteLength = Buffer.byteLength(serialized, "utf-8")

  if (byteLength > MAX_SHARD_SIZE) {
    // Truncate body to fit within MAX_SHARD_SIZE
    // Find the closing frontmatter delimiter properly — search for \n---\n after the opening ---
    const closingIndex = serialized.indexOf("\n---\n", 3)
    if (closingIndex === -1) {
      throw new Error("Malformed shard: could not find closing frontmatter delimiter")
    }
    const frontmatter = serialized.slice(0, closingIndex + 5) // includes "\n---\n"
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
    // Skip shards with invalid slugs (warn, don't crash)
    if (!slug || slug.includes("..") || slug.includes("/") || slug.includes("\\") || !VALID_SLUG_REGEX.test(slug)) {
      console.warn(`[memrecall] listShards: skipping file with invalid slug "${slug}"`)
      continue
    }
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
  validateSlug(slug)
  try {
    const filePath = path.join(dir, `${slug}.md`)
    if (!existsSync(filePath)) return false
    unlinkSync(filePath)
    return true
  } catch {
    return false
  }
}
