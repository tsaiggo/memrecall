import { describe, expect, it, beforeEach, afterEach, test } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import path from "path"
import os from "os"
import { MemoryIndex } from "../src/index-db.ts"
import type { IndexEntry } from "../src/types.ts"

let tmpDir: string
let dbPath: string
let index: MemoryIndex

function makeEntry(overrides: Partial<IndexEntry> = {}): IndexEntry {
  return {
    slug: "test-entry",
    title: "Test Entry",
    summary: "A test index entry for verification.",
    tags: ["typescript", "testing"],
    body: "# Test\n\nThis is the body of the test entry.",
    mtime: Date.now(),
    access_count: 0,
    ...overrides,
  }
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "indexdb-test-"))
  dbPath = path.join(tmpDir, "test-index.db")
  index = new MemoryIndex(dbPath)
})

afterEach(() => {
  try {
    index.close()
  } catch {
    // ignore close errors during cleanup
  }
  rmSync(tmpDir, { recursive: true, force: true })
})

describe("MemoryIndex constructor", () => {
  it("creates FTS5 and shard_meta tables on first open", () => {
    // If constructor didn't throw, tables were created successfully
    // Verify by doing a search (would fail if FTS5 table didn't exist)
    const results = index.search("", 5)
    expect(Array.isArray(results)).toBe(true)
  })

  it("opens an existing database without error", () => {
    index.close()
    // Re-open the same database file
    const index2 = new MemoryIndex(dbPath)
    const results = index2.search("", 5)
    expect(Array.isArray(results)).toBe(true)
    index2.close()
    // Re-assign so afterEach cleanup doesn't double-close
    index = new MemoryIndex(dbPath)
  })
})

describe("upsertShard", () => {
  it("inserts a new entry that can be found by search", () => {
    const entry = makeEntry({ slug: "new-entry", title: "New Entry", body: "Unique searchable content" })
    index.upsertShard(entry)

    const results = index.search("searchable", 5)
    expect(results.length).toBe(1)
    expect(results[0]!.slug).toBe("new-entry")
    expect(results[0]!.title).toBe("New Entry")
  })

  it("updates an existing entry on re-insert with same slug", () => {
    const entry1 = makeEntry({ slug: "update-me", title: "Original Title", body: "original content" })
    index.upsertShard(entry1)

    const entry2 = makeEntry({ slug: "update-me", title: "Updated Title", body: "updated content" })
    index.upsertShard(entry2)

    const results = index.search("updated", 5)
    expect(results.length).toBe(1)
    expect(results[0]!.title).toBe("Updated Title")

    // Original content should no longer match
    const oldResults = index.search("original", 5)
    expect(oldResults.length).toBe(0)
  })
})

describe("search", () => {
  it("returns BM25-ranked results for valid FTS5 queries", () => {
    index.upsertShard(makeEntry({ slug: "react-patterns", title: "React Patterns", body: "React hooks and components" }))
    index.upsertShard(makeEntry({ slug: "vue-patterns", title: "Vue Patterns", body: "Vue composition API" }))
    index.upsertShard(makeEntry({ slug: "react-testing", title: "React Testing", body: "Testing React apps" }))

    const results = index.search("React", 5)
    expect(results.length).toBe(2)
    // Both React entries should be returned
    const slugs = results.map((r) => r.slug).sort()
    expect(slugs).toEqual(["react-patterns", "react-testing"])
  })

  it("returns most-accessed shards for empty query", () => {
    index.upsertShard(makeEntry({ slug: "popular", title: "Popular", access_count: 10 }))
    index.upsertShard(makeEntry({ slug: "unpopular", title: "Unpopular", access_count: 0 }))

    const results = index.search("", 5)
    expect(results.length).toBe(2)
    // Most accessed should come first
    expect(results[0]!.slug).toBe("popular")
  })

  it("returns empty array for invalid FTS5 syntax (current behavior)", () => {
    index.upsertShard(makeEntry({ slug: "entry1" }))

    // Invalid FTS5 syntax — unbalanced quotes
    const results = index.search('"unclosed', 5)
    expect(results).toEqual([])
  })

  it("respects the limit parameter", () => {
    for (let i = 0; i < 10; i++) {
      index.upsertShard(makeEntry({ slug: `entry-${i}`, title: `Entry ${i}`, body: `Common keyword content ${i}` }))
    }

    const results = index.search("keyword", 3)
    expect(results.length).toBe(3)
  })
})

describe("incrementAccess", () => {
  it("increments access_count for an existing shard", () => {
    index.upsertShard(makeEntry({ slug: "tracked", access_count: 0 }))

    index.incrementAccess("tracked")
    index.incrementAccess("tracked")

    // Verify via getStaleShards (access_count < threshold)
    const stale = index.getStaleShards(3)
    const entry = stale.find((s) => s.slug === "tracked")
    expect(entry).toBeDefined()
    expect(entry!.access_count).toBe(2)
  })
})

describe("removeShard", () => {
  it("removes a shard from both FTS and meta tables", () => {
    index.upsertShard(makeEntry({ slug: "doomed" }))

    // Verify it exists first
    const before = index.search("doomed", 5)
    expect(before.length).toBe(1)

    index.removeShard("doomed")

    // Should no longer be found
    const after = index.search("doomed", 5)
    expect(after.length).toBe(0)

    // Also not in stale list
    const stale = index.getStaleShards(100)
    expect(stale.find((s) => s.slug === "doomed")).toBeUndefined()
  })
})

describe("getStaleShards", () => {
  it("returns shards with access_count below threshold", () => {
    index.upsertShard(makeEntry({ slug: "active", access_count: 5 }))
    index.upsertShard(makeEntry({ slug: "stale", access_count: 1 }))
    index.upsertShard(makeEntry({ slug: "fresh", access_count: 0 }))

    const stale = index.getStaleShards(2)
    expect(stale.length).toBe(2)
    const slugs = stale.map((s) => s.slug)
    expect(slugs).toContain("stale")
    expect(slugs).toContain("fresh")
    expect(slugs).not.toContain("active")
  })
})

describe("getCatalog", () => {
  it("returns all shards ordered by slug", () => {
    index.upsertShard(makeEntry({ slug: "charlie", title: "Charlie" }))
    index.upsertShard(makeEntry({ slug: "alpha", title: "Alpha" }))
    index.upsertShard(makeEntry({ slug: "bravo", title: "Bravo" }))

    const catalog = index.getCatalog()
    expect(catalog.length).toBe(3)
    expect(catalog[0]!.slug).toBe("alpha")
    expect(catalog[1]!.slug).toBe("bravo")
    expect(catalog[2]!.slug).toBe("charlie")
  })
})

describe("search error handling", () => {
  it("returns empty array for FTS5 syntax errors", () => {
    index.upsertShard(makeEntry({ slug: "entry1" }))

    // Invalid FTS5 syntax — unbalanced quotes
    const r1 = index.search('"unclosed', 5)
    expect(r1).toEqual([])

    // Another common FTS5 syntax error — lone AND/OR
    const r2 = index.search("AND", 5)
    expect(r2).toEqual([])
  })

  it("propagates real database errors instead of swallowing them", () => {
    index.upsertShard(makeEntry({ slug: "entry1" }))
    // Close the database to force a real error
    index.close()

    expect(() => index.search("test", 5)).toThrow()
  })
})

describe("allSlugs", () => {
  it("returns all slugs from shard_meta ordered alphabetically", () => {
    index.upsertShard(makeEntry({ slug: "charlie" }))
    index.upsertShard(makeEntry({ slug: "alpha" }))
    index.upsertShard(makeEntry({ slug: "bravo" }))

    const slugs = index.allSlugs()
    expect(slugs).toEqual(["alpha", "bravo", "charlie"])
  })

  it("returns empty array when no shards exist", () => {
    expect(index.allSlugs()).toEqual([])
  })
})

describe("reconcile", () => {
  it("removes orphaned FTS entries that have no matching file on disk", () => {
    // Insert an entry into FTS — but don't create a file on disk
    index.upsertShard(makeEntry({ slug: "orphan-entry", title: "Orphan" }))
    index.upsertShard(makeEntry({ slug: "another-orphan", title: "Another Orphan" }))

    // Verify entries exist in FTS before reconciliation
    expect(index.allSlugs()).toEqual(["another-orphan", "orphan-entry"])

    // Use the temp dir as memoriesDir — it has NO .md files, so both entries are orphans
    const { reconcile } = require("../src/catalog.ts")
    reconcile(index, tmpDir)

    // Both should be removed
    expect(index.allSlugs()).toEqual([])
    expect(index.search("orphan", 5)).toEqual([])
  })

  it("indexes missing shards that exist on disk but not in FTS", () => {
    // Write a shard file to disk — but don't insert into FTS
    const { writeShard } = require("../src/shard.ts")
    writeShard(tmpDir, {
      slug: "missing-shard",
      title: "Missing Shard",
      summary: "A shard that exists on disk but not in the index",
      tags: ["test", "reconcile"],
      body: "This shard should be discovered by reconciliation.",
      created: "2026-03-16",
      updated: "2026-03-16",
    })

    // Verify shard is NOT in FTS yet
    expect(index.allSlugs()).toEqual([])

    // Reconcile should find and index it
    const { reconcile } = require("../src/catalog.ts")
    reconcile(index, tmpDir)

    // Now it should be searchable
    const slugs = index.allSlugs()
    expect(slugs).toEqual(["missing-shard"])

    const results = index.search("reconciliation", 5)
    expect(results.length).toBe(1)
    expect(results[0]!.slug).toBe("missing-shard")
  })

  it("handles mixed state: some orphans + some missing + some valid", () => {
    const { writeShard } = require("../src/shard.ts")

    // Create a valid shard (in both FTS and on disk)
    const validShard = {
      slug: "valid-shard",
      title: "Valid Shard",
      summary: "Exists in both FTS and disk",
      tags: ["test"],
      body: "Valid content.",
      created: "2026-03-16",
      updated: "2026-03-16",
    }
    writeShard(tmpDir, validShard)
    index.upsertShard(makeEntry({ slug: "valid-shard", title: "Valid Shard", summary: "Exists in both FTS and disk", body: "Valid content." }))

    // Create an orphan (in FTS only, no file on disk)
    index.upsertShard(makeEntry({ slug: "orphan-only", title: "Orphan Only" }))

    // Create a missing shard (on disk only, not in FTS)
    writeShard(tmpDir, {
      slug: "disk-only",
      title: "Disk Only",
      summary: "On disk but not in FTS",
      tags: ["disk"],
      body: "Disk-only content.",
      created: "2026-03-16",
      updated: "2026-03-16",
    })

    // Before reconcile: FTS has valid-shard + orphan-only
    expect(index.allSlugs().sort()).toEqual(["orphan-only", "valid-shard"])

    const { reconcile } = require("../src/catalog.ts")
    reconcile(index, tmpDir)

    // After reconcile: orphan removed, disk-only added, valid-shard kept
    const slugs = index.allSlugs().sort()
    expect(slugs).toEqual(["disk-only", "valid-shard"])
  })
})
