import { MAX_CATALOG_SIZE } from "./constants.ts"
import type { MemoryIndex } from "./index-db.ts"
import { listShards, readShard } from "./shard.ts"
import type { IndexEntry } from "./types.ts"

/**
 * Reconcile FTS index with filesystem shards.
 * - Orphaned FTS entries (in index but not on disk): remove from index
 * - Missing FTS entries (on disk but not in index): add to index
 * Runs ONLY during catalog build, never on search hot path.
 */
export function reconcile(index: MemoryIndex, memoriesDir: string): void {
  const ftsSet = new Set(index.allSlugs())
  const diskShards = listShards(memoriesDir)
  const diskSet = new Set(diskShards.map((s) => s.slug))

  // Remove orphaned FTS entries (in FTS but not on disk)
  for (const slug of ftsSet) {
    if (!diskSet.has(slug)) {
      console.warn(`[memrecall] reconcile: removing orphaned FTS entry "${slug}"`)
      index.removeShard(slug)
    }
  }

  // Add missing FTS entries (on disk but not in FTS)
  for (const meta of diskShards) {
    if (!ftsSet.has(meta.slug)) {
      console.warn(`[memrecall] reconcile: indexing missing shard "${meta.slug}"`)
      const shard = readShard(memoriesDir, meta.slug)
      if (shard) {
        const entry: IndexEntry = {
          slug: shard.slug,
          title: shard.title,
          summary: shard.summary,
          tags: shard.tags,
          body: shard.body,
          mtime: Date.now(),
          access_count: 0,
        }
        index.upsertShard(entry)
      }
    }
  }
}

export function buildCatalog(index: MemoryIndex, memoriesDir?: string): string {
  // Run reconciliation if memoriesDir is provided
  if (memoriesDir) {
    reconcile(index, memoriesDir)
  }

  const entries = index.getCatalog()
  if (entries.length === 0) return "No memory shards available yet."
  let catalog = "Available memory shards:\n"
  let shardCount = 0
  for (const e of entries) {
    const line = `- ${e.slug}: ${e.summary}\n`
    if (Buffer.byteLength(catalog + line, "utf-8") > MAX_CATALOG_SIZE) {
      const remaining = entries.length - shardCount
      catalog += `... and ${remaining} more shards. Use memrecall_search to find them.\n`
      break
    }
    catalog += line
    shardCount++
  }
  return catalog
}
