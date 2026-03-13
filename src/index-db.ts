import { Database } from "bun:sqlite"
import type { IndexEntry } from "./types.ts"

function withRetry<T>(fn: () => T, attempts = 3): T {
  for (let i = 0; i < attempts; i++) {
    try {
      return fn()
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes("SQLITE_BUSY") && i < attempts - 1) {
        Bun.sleepSync(100)
        continue
      }
      throw err
    }
  }
  throw new Error("withRetry: exhausted attempts")
}

export class MemoryIndex {
  private db: Database

  constructor(dbPath: string) {
    this.db = new Database(dbPath)
    this.db.run("PRAGMA journal_mode=WAL")

    this.db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS shards_fts USING fts5(
        slug,
        title,
        summary,
        tags,
        body,
        tokenize='porter unicode61'
      )
    `)

    this.db.run(`
      CREATE TABLE IF NOT EXISTS shard_meta (
        slug TEXT PRIMARY KEY,
        mtime INTEGER NOT NULL DEFAULT 0,
        access_count INTEGER NOT NULL DEFAULT 0
      )
    `)

    // Verify FTS5 is available
    try {
      this.db.query("SELECT * FROM shards_fts LIMIT 0").all()
    } catch {
      throw new Error("FTS5 not available in this Bun build")
    }
  }

  upsertShard(entry: IndexEntry): void {
    withRetry(() => {
      this.db.run("DELETE FROM shards_fts WHERE slug = ?", [entry.slug])
      this.db.run(
        "INSERT INTO shards_fts (slug, title, summary, tags, body) VALUES (?, ?, ?, ?, ?)",
        [entry.slug, entry.title, entry.summary, entry.tags, entry.body]
      )
      this.db.run(
        "INSERT OR REPLACE INTO shard_meta (slug, mtime, access_count) VALUES (?, ?, ?)",
        [entry.slug, entry.mtime, entry.access_count]
      )
    })
  }

  search(
    query: string,
    limit = 5
  ): Array<{ slug: string; title: string; summary: string; tags: string; rank: number }> {
    const trimmed = query.trim()
    if (!trimmed) {
      // Return most-accessed shards
      const rows = this.db
        .query(
          `SELECT f.slug, f.title, f.summary, f.tags, 0 as rank
           FROM shards_fts f
           JOIN shard_meta m ON f.slug = m.slug
           ORDER BY m.access_count DESC
           LIMIT ?`
        )
        .all(limit) as Array<{ slug: string; title: string; summary: string; tags: string; rank: number }>
      return rows
    }

    try {
      const rows = this.db
        .query(
          `SELECT slug, title, summary, tags, bm25(shards_fts) as rank
           FROM shards_fts
           WHERE shards_fts MATCH ?
           ORDER BY rank
           LIMIT ?`
        )
        .all(trimmed, limit) as Array<{ slug: string; title: string; summary: string; tags: string; rank: number }>
      return rows
    } catch {
      return []
    }
  }

  incrementAccess(slug: string): void {
    withRetry(() => {
      this.db.run("UPDATE shard_meta SET access_count = access_count + 1 WHERE slug = ?", [slug])
    })
  }

  removeShard(slug: string): void {
    withRetry(() => {
      this.db.run("DELETE FROM shards_fts WHERE slug = ?", [slug])
      this.db.run("DELETE FROM shard_meta WHERE slug = ?", [slug])
    })
  }

  getStaleShards(minAccess: number): Array<{ slug: string; access_count: number; mtime: number }> {
    return this.db
      .query("SELECT slug, access_count, mtime FROM shard_meta WHERE access_count < ? ORDER BY access_count ASC")
      .all(minAccess) as Array<{ slug: string; access_count: number; mtime: number }>
  }

  getCatalog(): Array<{ slug: string; title: string; summary: string }> {
    return this.db
      .query("SELECT f.slug, f.title, f.summary FROM shards_fts f ORDER BY f.slug")
      .all() as Array<{ slug: string; title: string; summary: string }>
  }

  close(): void {
    this.db.close()
  }
}
