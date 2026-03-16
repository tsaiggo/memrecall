import { describe, expect, it, beforeEach, afterEach, test } from "bun:test"
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs"
import path from "path"
import os from "os"
import {
  parseFrontmatter,
  serializeShard,
  readShard,
  writeShard,
  listShards,
  deleteShard,
  validateSlug,
} from "../src/shard.ts"
import type { ShardContent } from "../src/types.ts"

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "shard-test-"))
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

function makeShard(overrides: Partial<ShardContent> = {}): ShardContent {
  return {
    slug: "test-topic",
    title: "Test Topic",
    summary: "A brief summary of the test topic.",
    tags: ["typescript", "testing"],
    created: "2026-03-15",
    updated: "2026-03-16",
    body: "# Test Content\n\nThis is the shard body.",
    ...overrides,
  }
}

describe("serializeShard", () => {
  it("serializes a shard into frontmatter + body format", () => {
    const shard = makeShard()
    const result = serializeShard(shard)

    expect(result).toContain("---\n")
    expect(result).toContain("title: Test Topic")
    expect(result).toContain("summary: A brief summary of the test topic.")
    expect(result).toContain("tags: typescript, testing")
    expect(result).toContain("created: 2026-03-15")
    expect(result).toContain("updated: 2026-03-16")
    expect(result).toContain("# Test Content\n\nThis is the shard body.")
  })

  it("handles empty tags array", () => {
    const shard = makeShard({ tags: [] })
    const result = serializeShard(shard)

    expect(result).toContain("tags: ")
  })
})

describe("parseFrontmatter", () => {
  it("parses valid frontmatter into meta + body", () => {
    const input = [
      "---",
      "title: My Title",
      "summary: My Summary",
      "tags: a, b, c",
      "created: 2026-01-01",
      "updated: 2026-02-02",
      "---",
      "",
      "Body content here.",
    ].join("\n")

    const { meta, body } = parseFrontmatter(input)

    expect(meta.title).toBe("My Title")
    expect(meta.summary).toBe("My Summary")
    expect(meta.tags).toEqual(["a", "b", "c"])
    expect(meta.created).toBe("2026-01-01")
    expect(meta.updated).toBe("2026-02-02")
    expect(body).toBe("Body content here.")
  })

  it("returns raw content when no frontmatter is present", () => {
    const input = "Just some plain text without frontmatter."
    const { meta, body } = parseFrontmatter(input)

    expect(meta).toEqual({})
    expect(body).toBe(input)
  })

  it("handles missing optional fields gracefully", () => {
    const input = "---\ntitle: Only Title\n---\nBody text"
    const { meta, body } = parseFrontmatter(input)

    expect(meta.title).toBe("Only Title")
    expect(meta.summary).toBeUndefined()
    expect(meta.tags).toBeUndefined()
    expect(body).toBe("Body text")
  })
})

describe("writeShard + readShard round-trip", () => {
  it("writes and reads back identical content", () => {
    const shard = makeShard()
    writeShard(tmpDir, shard)

    const result = readShard(tmpDir, shard.slug)

    expect(result).not.toBeNull()
    expect(result!.slug).toBe(shard.slug)
    expect(result!.title).toBe(shard.title)
    expect(result!.summary).toBe(shard.summary)
    expect(result!.tags).toEqual(shard.tags)
    expect(result!.created).toBe(shard.created)
    expect(result!.updated).toBe(shard.updated)
    expect(result!.body).toBe(shard.body)
  })

  it("creates the directory if it does not exist", () => {
    const nestedDir = path.join(tmpDir, "nested", "memories")
    const shard = makeShard()
    writeShard(nestedDir, shard)

    expect(existsSync(path.join(nestedDir, `${shard.slug}.md`))).toBe(true)
  })

  it("readShard returns null for non-existent shard", () => {
    const result = readShard(tmpDir, "does-not-exist")
    expect(result).toBeNull()
  })

  it("truncates body when shard exceeds MAX_SHARD_SIZE", () => {
    const largeBody = "x".repeat(40000) // well over 32KB limit
    const shard = makeShard({ body: largeBody })
    writeShard(tmpDir, shard)

    const filePath = path.join(tmpDir, `${shard.slug}.md`)
    const fileSize = Buffer.byteLength(readFileSync(filePath, "utf-8"), "utf-8")

    // File should be at or under the MAX_SHARD_SIZE (32768)
    expect(fileSize).toBeLessThanOrEqual(32768)

    const result = readShard(tmpDir, shard.slug)
    expect(result).not.toBeNull()
    expect(result!.body).toContain("[Content truncated to fit size limit]")
  })
})

describe("listShards", () => {
  it("lists all shards in a directory", () => {
    writeShard(tmpDir, makeShard({ slug: "alpha" }))
    writeShard(tmpDir, makeShard({ slug: "beta" }))
    writeShard(tmpDir, makeShard({ slug: "gamma" }))

    const shards = listShards(tmpDir)

    expect(shards).toHaveLength(3)
    const slugs = shards.map((s) => s.slug).sort()
    expect(slugs).toEqual(["alpha", "beta", "gamma"])
  })

  it("returns empty array for non-existent directory", () => {
    const result = listShards(path.join(tmpDir, "nope"))
    expect(result).toEqual([])
  })

  it("ignores non-md files", () => {
    writeShard(tmpDir, makeShard({ slug: "valid" }))
    // Write a non-md file
    const { writeFileSync } = require("fs")
    writeFileSync(path.join(tmpDir, "notes.txt"), "not a shard", "utf-8")

    const shards = listShards(tmpDir)
    expect(shards).toHaveLength(1)
    expect(shards[0]!.slug).toBe("valid")
  })
})

describe("deleteShard", () => {
  it("deletes an existing shard and returns true", () => {
    writeShard(tmpDir, makeShard({ slug: "to-delete" }))
    expect(existsSync(path.join(tmpDir, "to-delete.md"))).toBe(true)

    const result = deleteShard(tmpDir, "to-delete")
    expect(result).toBe(true)
    expect(existsSync(path.join(tmpDir, "to-delete.md"))).toBe(false)
  })

  it("returns false for non-existent shard", () => {
    const result = deleteShard(tmpDir, "ghost")
    expect(result).toBe(false)
  })

  it("readShard returns null after deletion", () => {
    writeShard(tmpDir, makeShard({ slug: "temp" }))
    deleteShard(tmpDir, "temp")

    const result = readShard(tmpDir, "temp")
    expect(result).toBeNull()
  })
})

describe("T5: frontmatter parsing handles --- in body content", () => {
  test("parseFrontmatter handles --- in body content", () => {
    // Previously skipped — BUG: shard.ts:91 used indexOf("---", 3) which broke when body contained ---
    const input = [
      "---",
      "title: Test",
      "summary: Summary",
      "tags: a",
      "created: 2026-01-01",
      "updated: 2026-01-01",
      "---",
      "",
      "Some content",
      "",
      "---",
      "",
      "Content after horizontal rule",
    ].join("\n")

    const { meta, body } = parseFrontmatter(input)
    expect(meta.title).toBe("Test")
    expect(body).toContain("Content after horizontal rule")
    expect(body).toContain("---")
  })

  test("body with --- at start of line preserved after round-trip", () => {
    const shard = makeShard({
      body: "Paragraph one\n\n---\n\nParagraph two after rule\n\n---\n\nParagraph three",
    })
    writeShard(tmpDir, shard)
    const result = readShard(tmpDir, shard.slug)

    expect(result).not.toBeNull()
    expect(result!.body).toContain("Paragraph two after rule")
    expect(result!.body).toContain("Paragraph three")
    expect(result!.body).toContain("---")
  })

  test("body with multiple --- on separate lines preserved", () => {
    const shard = makeShard({
      body: "---\nFirst separator\n---\nSecond separator\n---",
    })
    writeShard(tmpDir, shard)
    const result = readShard(tmpDir, shard.slug)

    expect(result).not.toBeNull()
    expect(result!.body).toContain("First separator")
    expect(result!.body).toContain("Second separator")
  })

  test("truncation with --- in body preserves correct frontmatter", () => {
    // A body that contains --- AND is large enough to trigger truncation
    const largeBody = "---\nSome rule\n---\n" + "x".repeat(40000)
    const shard = makeShard({ body: largeBody })
    writeShard(tmpDir, shard)

    const result = readShard(tmpDir, shard.slug)
    expect(result).not.toBeNull()
    expect(result!.title).toBe("Test Topic") // frontmatter preserved
    expect(result!.body).toContain("[Content truncated to fit size limit]")
  })
})

describe("T6: slug validation", () => {
  test("validateSlug accepts valid slugs", () => {
    expect(() => validateSlug("valid-slug")).not.toThrow()
    expect(() => validateSlug("valid-slug-123")).not.toThrow()
    expect(() => validateSlug("a")).not.toThrow()
    expect(() => validateSlug("my_shard")).not.toThrow()
    expect(() => validateSlug("test-topic")).not.toThrow()
  })

  test("validateSlug rejects path traversal slugs", () => {
    expect(() => validateSlug("../etc/passwd")).toThrow(/path traversal/)
    expect(() => validateSlug("foo/../../bar")).toThrow(/path traversal/)
    expect(() => validateSlug("..")).toThrow(/path traversal/)
    expect(() => validateSlug("foo\\bar")).toThrow(/path traversal/)
  })

  test("validateSlug rejects empty slug", () => {
    expect(() => validateSlug("")).toThrow(/non-empty/)
  })

  test("validateSlug rejects slugs with invalid characters", () => {
    expect(() => validateSlug("UPPER-CASE")).toThrow()
    expect(() => validateSlug("has spaces")).toThrow()
    expect(() => validateSlug("-starts-with-dash")).toThrow()
    expect(() => validateSlug("_starts-with-underscore")).toThrow()
  })

  test("writeShard rejects path traversal slug", () => {
    // Previously skipped — BUG: No slug validation allowed path traversal
    const shard = makeShard({ slug: "../../../etc/malicious" })
    expect(() => writeShard(tmpDir, shard)).toThrow()
  })

  test("writeShard rejects foo/../../bar slug", () => {
    const shard = makeShard({ slug: "foo/../../bar" })
    expect(() => writeShard(tmpDir, shard)).toThrow()
  })

  test("writeShard rejects empty slug", () => {
    const shard = makeShard({ slug: "" })
    expect(() => writeShard(tmpDir, shard)).toThrow()
  })

  test("writeShard accepts valid slug", () => {
    const shard = makeShard({ slug: "valid-slug-123" })
    expect(() => writeShard(tmpDir, shard)).not.toThrow()
    const result = readShard(tmpDir, "valid-slug-123")
    expect(result).not.toBeNull()
  })

  test("readShard returns null for path traversal slug", () => {
    const result = readShard(tmpDir, "../secret")
    expect(result).toBeNull()
  })

  test("readShard returns null for empty slug", () => {
    const result = readShard(tmpDir, "")
    expect(result).toBeNull()
  })

  test("deleteShard rejects path traversal slug", () => {
    expect(() => deleteShard(tmpDir, "../important")).toThrow()
  })

  test("deleteShard rejects empty slug", () => {
    expect(() => deleteShard(tmpDir, "")).toThrow()
  })

  test("listShards skips files with invalid slug patterns", () => {
    // Write a valid shard
    writeShard(tmpDir, makeShard({ slug: "valid" }))
    // Manually write a file with uppercase name (invalid slug)
    const { writeFileSync } = require("fs")
    writeFileSync(path.join(tmpDir, "INVALID.md"), "---\ntitle: Bad\n---\nBody", "utf-8")

    const shards = listShards(tmpDir)
    expect(shards).toHaveLength(1)
    expect(shards[0]!.slug).toBe("valid")
  })
})

describe("T7: write-before-validate — overflow path size check", () => {
  test("serializeShard + size check validates BEFORE disk write", () => {
    // The fix in index.ts ensures serializeShard() and size check happen
    // BEFORE writeShard() call. This test validates the building block:
    // serializeShard produces a consistent output whose size can be checked.
    const { serializeShard } = require("../src/shard.ts")
    const { MAX_SHARD_SIZE } = require("../src/constants.ts")

    const largeShard = makeShard({ body: "x".repeat(40000) })
    const serialized = serializeShard(largeShard)
    const byteLength = Buffer.byteLength(serialized, "utf-8")

    // Verify the serialized form exceeds MAX_SHARD_SIZE
    expect(byteLength).toBeGreaterThan(MAX_SHARD_SIZE)
  })

  test("writeShard truncates oversized content (does not reject)", () => {
    // writeShard itself handles truncation internally — it doesn't throw.
    // The overflow path in index.ts is the one that should validate BEFORE calling writeShard.
    const largeBody = "x".repeat(40000)
    const shard = makeShard({ body: largeBody })

    // writeShard should NOT throw — it truncates
    expect(() => writeShard(tmpDir, shard)).not.toThrow()

    // Verify truncation happened
    const result = readShard(tmpDir, shard.slug)
    expect(result).not.toBeNull()
    expect(result!.body).toContain("[Content truncated to fit size limit]")
  })
})
