import { existsSync, mkdirSync, writeFileSync } from "fs"
import path from "path"
import { tool, type Plugin } from "@opencode-ai/plugin"
import {
  MEMORY_FILE,
  MAX_MESSAGE_LENGTH,
  MAX_TOTAL_OUTPUT,
  MAX_MEMORY_SIZE,
  MEMORIES_DIR,
  INDEX_DB_FILE,
  MAX_CATALOG_SIZE,
} from "./constants.ts"
import { PARSE_PROMPT_TEMPLATE } from "./prompt.ts"
import { readShard, writeShard, deleteShard } from "./shard.ts"
import { MemoryIndex } from "./index-db.ts"
import type { IndexEntry } from "./types.ts"

const plugin: Plugin = async (ctx) => {
  // Initialize memory index
  const indexPath = path.join(ctx.directory, INDEX_DB_FILE)
  const indexDir = path.dirname(indexPath)
  if (!existsSync(indexDir)) {
    mkdirSync(indexDir, { recursive: true })
  }
  const index = new MemoryIndex(indexPath)
  const memoriesDir = path.join(ctx.directory, MEMORIES_DIR)

  // Build dynamic shard catalog for tool descriptions
  function buildCatalog(): string {
    const entries = index.getCatalog()
    if (entries.length === 0) return "No memory shards available yet."
    let catalog = "Available memory shards:\n"
    for (const e of entries) {
      const line = `- ${e.slug}: ${e.summary}\n`
      if (Buffer.byteLength(catalog + line, "utf-8") > MAX_CATALOG_SIZE) {
        const remaining = entries.length - catalog.split("\n").length + 1
        catalog += `... and ${remaining} more shards. Use memrecall_search to find them.\n`
        break
      }
      catalog += line
    }
    return catalog
  }

  const catalog = buildCatalog()

  return {
    config: async (input) => {
      input.command = input.command || {}
      input.command["memory-parse"] = {
        template: PARSE_PROMPT_TEMPLATE,
        description: "Analyze chat history and generate memory profile with shards",
      }

      const memoryPath = path.join(ctx.directory, MEMORY_FILE)
      if (existsSync(memoryPath)) {
        input.instructions = input.instructions || []
        input.instructions.push(MEMORY_FILE)
      }
    },
    tool: {
      // --- V1 tools (preserved) ---
      memrecall_parse: tool({
        description:
          "Read all chat history from OpenCode sessions. Returns formatted conversation text for analysis.",
        args: {},
        async execute(_args, context) {
          context.metadata({ title: "Reading chat history..." })

          const sessions = await ctx.client.session.list()
          if (!sessions.data || sessions.data.length === 0) {
            return "No sessions found. Start some conversations first, then run memory-parse again."
          }

          const sorted = sessions.data.sort((a: any, b: any) => {
            const timeA = a.time?.created ?? ""
            const timeB = b.time?.created ?? ""
            return timeB.localeCompare(timeA)
          })

          let output = ""
          let totalBytes = 0
          let sessionCount = 0

          for (const session of sorted) {
            if (totalBytes >= MAX_TOTAL_OUTPUT) break

            try {
              const msgs = await ctx.client.session.messages({
                path: { id: session.id },
              })
              if (!msgs.data || msgs.data.length === 0) continue

              let sessionOutput = `[Session: ${session.title || "Untitled"}] [${session.time?.created || "unknown"}]\n`

              for (const msg of msgs.data) {
                if (!msg.parts) continue
                for (const part of msg.parts) {
                  if (part.type !== "text") continue
                  let text = part.text || ""
                  if (text.length > MAX_MESSAGE_LENGTH) {
                    text = text.slice(0, MAX_MESSAGE_LENGTH) + "..."
                  }
                  sessionOutput += `${msg.info?.role || "unknown"}: ${text}\n`
                }
              }

              sessionOutput += "---\n"
              const bytes = Buffer.byteLength(sessionOutput, "utf-8")

              if (totalBytes + bytes > MAX_TOTAL_OUTPUT) break

              output += sessionOutput
              totalBytes += bytes
              sessionCount++
            } catch {
              continue
            }
          }

          if (!output) {
            return "Sessions found but no text content could be extracted."
          }

          context.metadata({ title: `Read ${sessionCount} sessions` })
          return `Found ${sessions.data.length} sessions. History below:\n\n${output}`
        },
      }),

      memrecall_write: tool({
        description: "Write the generated memory profile to .opencode/memory.md",
        args: {
          content: tool.schema
            .string()
            .describe("The markdown content of the memory profile"),
        },
        async execute(args, context) {
          context.metadata({ title: "Writing memory profile..." })

          let content = args.content
          const byteLength = Buffer.byteLength(content, "utf-8")

          if (byteLength > MAX_MEMORY_SIZE) {
            const truncated = Buffer.from(content, "utf-8").subarray(0, MAX_MEMORY_SIZE)
            content = truncated.toString("utf-8")
            content += "\n\n<!-- Memory truncated to fit size limit -->"
          }

          const memoryPath = path.join(ctx.directory, MEMORY_FILE)
          const memoryDir = path.dirname(memoryPath)
          if (!existsSync(memoryDir)) {
            mkdirSync(memoryDir, { recursive: true })
          }
          writeFileSync(memoryPath, content, "utf-8")

          const finalSize = Buffer.byteLength(content, "utf-8")
          context.metadata({ title: "Memory profile saved" })
          return `Memory profile written to ${MEMORY_FILE} (${finalSize} bytes). It will be automatically loaded in future sessions.`
        },
      }),

      // --- V2 new tools ---
      memrecall_load: tool({
        description: `Load full content of a specific memory shard by slug.\n\n${catalog}`,
        args: {
          slug: tool.schema
            .string()
            .describe("The slug of the memory shard to load"),
        },
        async execute(args, context) {
          context.metadata({ title: "Loading: " + args.slug })
          const shard = readShard(memoriesDir, args.slug)
          if (!shard) {
            return `Memory shard '${args.slug}' not found. Use memrecall_search to find available shards.`
          }
          index.incrementAccess(args.slug)
          return `<memory_shard slug="${shard.slug}">\n# ${shard.title}\nTags: ${shard.tags.join(", ")}\nLast updated: ${shard.updated}\n\n${shard.body}\n</memory_shard>`
        },
      }),

      memrecall_search: tool({
        description: `Search memory shards by keyword, topic, or project name. Returns ranked results.\n\n${catalog}\n\nSupports FTS5 query syntax: AND, OR, NOT, prefix* matching.`,
        args: {
          query: tool.schema
            .string()
            .describe(
              "Search query to find relevant memory shards. Use keywords, topics, or project names."
            ),
        },
        async execute(args, context) {
          context.metadata({ title: "Search: " + args.query })
          const results = index.search(args.query, 5)
          if (results.length === 0) {
            const cat = buildCatalog()
            return `No memory shards found for '${args.query}'. ${cat}`
          }
          let output = `Found ${results.length} relevant memory shards:\n\n`
          results.forEach((r, i) => {
            output += `${i + 1}. **${r.title}** (\`${r.slug}\`)\n   ${r.summary}\n   Tags: ${r.tags}\n\n`
          })
          output += "Use memrecall_load with the slug to read full content."
          return output
        },
      }),

      memrecall_prune: tool({
        description:
          "Remove stale memory shards or list candidates for pruning.",
        args: {
          slug: tool.schema
            .string()
            .optional()
            .describe(
              "Specific shard slug to prune. If omitted, shows stale shards for review."
            ),
        },
        async execute(args, context) {
          if (args.slug) {
            context.metadata({ title: "Pruning: " + args.slug })
            const deleted = deleteShard(memoriesDir, args.slug)
            index.removeShard(args.slug)
            if (!deleted) return `Memory shard '${args.slug}' not found.`
            return `Pruned memory shard: ${args.slug}`
          }

          context.metadata({ title: "Reviewing stale shards" })
          const stale = index.getStaleShards(2)
          if (stale.length === 0) {
            return "No stale shards found. All memory shards are being actively used."
          }
          let output = "Stale shards (accessed fewer than 2 times):\n"
          for (const s of stale) {
            output += `- ${s.slug} (accessed ${s.access_count} times)\n`
          }
          output += "\nUse memrecall_prune with a specific slug to remove."
          return output
        },
      }),

      memrecall_write_shard: tool({
        description:
          "Write a memory shard to disk and index it for search.",
        args: {
          slug: tool.schema
            .string()
            .describe("Kebab-case topic name, e.g. 'nextjs-patterns'"),
          title: tool.schema.string().describe("Human-readable title"),
          summary: tool.schema
            .string()
            .describe("1-2 sentence summary for the catalog"),
          tags: tool.schema
            .string()
            .describe("Comma-separated tags, e.g. 'nextjs,react,routing'"),
          body: tool.schema
            .string()
            .describe("Full markdown content for this shard"),
        },
        async execute(args, context) {
          context.metadata({ title: "Writing shard: " + args.slug })

          const now = new Date().toISOString().slice(0, 10)
          const tags = args.tags.split(",").map((t) => t.trim())

          // Check if existing shard to preserve created date
          const existing = readShard(memoriesDir, args.slug)

          const shard = {
            slug: args.slug,
            title: args.title,
            summary: args.summary,
            tags,
            created: existing ? existing.created : now,
            updated: now,
            body: args.body,
          }

          writeShard(memoriesDir, shard)

          const entry: IndexEntry = {
            slug: args.slug,
            title: args.title,
            summary: args.summary,
            tags: args.tags,
            body: args.body,
            mtime: Date.now(),
            access_count: existing ? 1 : 0,
          }
          index.upsertShard(entry)

          return `Memory shard '${args.slug}' written to ${MEMORIES_DIR}/${args.slug}.md and indexed.`
        },
      }),
    },
  }
}

export default plugin
