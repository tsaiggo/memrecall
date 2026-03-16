import { existsSync, mkdirSync, writeFileSync } from "fs"
import path from "path"
import { tool } from "@opencode-ai/plugin"
import {
  MEMORY_FILE,
  MAX_MESSAGE_LENGTH,
  MAX_TOTAL_OUTPUT,
  MAX_MEMORY_SIZE,
  MEMORIES_DIR,
  MAX_SHARD_SIZE,
  MAX_SHARDS,
  AUTO_CORE_SHARD_PREFIX,
} from "./constants.ts"
import { readShard, writeShard, deleteShard, listShards, serializeShard } from "./shard.ts"
import type { MemoryIndex } from "./index-db.ts"
import type { IndexEntry } from "./types.ts"
import { planMemoryWrite } from "./memory-planner.ts"
import { buildCatalog } from "./catalog.ts"
import { readCompressionRunHistory } from "./compression-io.ts"
import type { CompressionRunRecord } from "./compression-run.ts"

function getGeneratedCoreShardSlugs(memoriesDir: string): string[] {
  return listShards(memoriesDir)
    .map((shard) => shard.slug)
    .filter((slug) => slug.startsWith(AUTO_CORE_SHARD_PREFIX))
}

export function createTools(
  ctx: any,
  index: MemoryIndex,
  memoriesDir: string,
  compressionRunStatsPath: string,
  catalog: string
): Record<string, any> {
  return {
    memrecall_parse: tool({
      description:
        "Read all chat history from OpenCode sessions. Returns formatted conversation text for analysis.",
      args: {},
      async execute(_args: {}, context: any) {
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
      description:
        "Write the generated memory profile to .opencode/memory.md. Oversized core memory is automatically split into progressive shards.",
      args: {
        content: tool.schema
          .string()
          .describe("The markdown content of the memory profile"),
      },
      async execute(args: { content: string }, context: any) {
        context.metadata({ title: "Writing memory profile..." })

        const content = args.content
        const byteLength = Buffer.byteLength(content, "utf-8")

        const memoryPath = path.join(ctx.directory, MEMORY_FILE)
        const memoryDir = path.dirname(memoryPath)
        if (!existsSync(memoryDir)) {
          mkdirSync(memoryDir, { recursive: true })
        }

        const generatedCoreSlugs = getGeneratedCoreShardSlugs(memoriesDir)
        for (const slug of generatedCoreSlugs) {
          deleteShard(memoriesDir, slug)
          index.removeShard(slug)
        }

        const plan = planMemoryWrite(content)

        if (plan.mode === "direct") {
          writeFileSync(memoryPath, plan.bootstrapContent, "utf-8")
          const finalSize = Buffer.byteLength(plan.bootstrapContent, "utf-8")
          context.metadata({ title: "Memory profile saved" })
          return `Memory profile written to ${MEMORY_FILE} (${finalSize} bytes, ~${plan.metrics.estimatedBootstrapTokens} tokens). It will be automatically loaded in future sessions.`
        }

        const generatedShards = plan.shards
        const existingNonGeneratedCount = listShards(memoriesDir).filter(
          (shard) => !shard.slug.startsWith(AUTO_CORE_SHARD_PREFIX)
        ).length

        if (existingNonGeneratedCount + generatedShards.length > MAX_SHARDS) {
          const availableSlots = Math.max(0, MAX_SHARDS - existingNonGeneratedCount)
          throw new Error(
            `Core memory overflow would create ${generatedShards.length} shards, but only ${availableSlots} shard slots remain out of the ${MAX_SHARDS} limit.`
          )
        }

        const now = new Date().toISOString().slice(0, 10)
        for (const shard of generatedShards) {
          const shardContent = {
            slug: shard.slug,
            title: shard.title,
            summary: shard.summary,
            tags: shard.tags,
            created: now,
            updated: now,
            body: shard.body,
          }

          // Validate size BEFORE writing to disk (fix: was write-then-validate)
          const serialized = serializeShard(shardContent)
          if (Buffer.byteLength(serialized, "utf-8") > MAX_SHARD_SIZE) {
            throw new Error(`Generated shard '${shard.slug}' exceeded the shard size limit after splitting.`)
          }

          writeShard(memoriesDir, shardContent)

          index.upsertShard({
            slug: shard.slug,
            title: shard.title,
            summary: shard.summary,
            tags: shard.tags,
            body: shard.body,
            mtime: Date.now(),
            access_count: 0,
          })
        }

        writeFileSync(memoryPath, plan.bootstrapContent, "utf-8")

        const finalSize = Buffer.byteLength(plan.bootstrapContent, "utf-8")
        context.metadata({ title: "Memory profile split into shards" })
        return `Memory profile exceeded ${MAX_MEMORY_SIZE} bytes, so memrecall kept a compact bootstrap in ${MEMORY_FILE} (${finalSize} bytes, ~${plan.metrics.estimatedBootstrapTokens} tokens) and generated ${generatedShards.length} progressive shard(s) under ${MEMORIES_DIR}. Estimated always-loaded token savings: ~${plan.metrics.estimatedBootstrapTokenDelta} tokens from ~${plan.metrics.estimatedOriginalTokens} to ~${plan.metrics.estimatedBootstrapTokens}; shard payload: ${plan.metrics.shardCount} shard(s), ${plan.metrics.shardBytesTotal} bytes, ~${plan.metrics.estimatedShardTokensTotal} tokens.`
      },
    }),

    memrecall_compression_stats: tool({
      description:
        "Show actual model token usage recorded for the latest /memory-parse compression run.",
      args: {
        sessionID: tool.schema
          .string()
          .optional()
          .describe("Optional session ID to filter compression runs."),
      },
      async execute(args: { sessionID?: string }, context: any) {
        context.metadata({ title: "Reading compression run stats" })
        const history = readCompressionRunHistory(compressionRunStatsPath).filter((run: CompressionRunRecord) => run.status === "completed")
        const selected = args.sessionID
          ? history.find((run: CompressionRunRecord) => run.sessionID === args.sessionID)
          : history[0]

        if (!selected || !selected.tokens) {
          return "No completed memory compression runs recorded yet. Run /memory-parse first, then check again."
        }

        return [
          `Latest memory compression run`,
          `- Session: ${selected.sessionID}`,
          `- Command message: ${selected.commandMessageID}`,
          `- Assistant message: ${selected.assistantMessageID ?? "unknown"}`,
          `- Started: ${new Date(selected.startedAt).toISOString()}`,
          `- Completed: ${selected.completedAt ? new Date(selected.completedAt).toISOString() : "unknown"}`,
          `- Cost: ${selected.cost ?? 0}`,
          `- Tokens total: ${selected.tokens.total}`,
          `  - input: ${selected.tokens.input}`,
          `  - output: ${selected.tokens.output}`,
          `  - reasoning: ${selected.tokens.reasoning}`,
          `  - cache.read: ${selected.tokens.cache.read}`,
          `  - cache.write: ${selected.tokens.cache.write}`,
        ].join("\n")
      },
    }),

    memrecall_load: tool({
      description: `Load full content of a specific memory shard by slug.\n\n${catalog}`,
      args: {
        slug: tool.schema
          .string()
          .describe("The slug of the memory shard to load"),
      },
      async execute(args: { slug: string }, context: any) {
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
      async execute(args: { query: string }, context: any) {
        context.metadata({ title: "Search: " + args.query })
        const results = index.search(args.query, 5)
        if (results.length === 0) {
          const cat = buildCatalog(index)
          return `No memory shards found for '${args.query}'. ${cat}`
        }
        let output = `Found ${results.length} relevant memory shards:\n\n`
        results.forEach((r, i) => {
          output += `${i + 1}. **${r.title}** (\`${r.slug}\`)\n   ${r.summary}\n   Tags: ${r.tags.join(", ")}\n\n`
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
      async execute(args: { slug?: string }, context: any) {
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
      async execute(args: { slug: string; title: string; summary: string; tags: string; body: string }, context: any) {
        context.metadata({ title: "Writing shard: " + args.slug })

        const now = new Date().toISOString().slice(0, 10)
        const tags = args.tags.split(",").map((t) => t.trim())

        // Check if existing shard to preserve created date
        const existing = readShard(memoriesDir, args.slug)
        const isNewShard = !existing
        const existingShardCount = listShards(memoriesDir).length
        if (isNewShard && existingShardCount >= MAX_SHARDS) {
          throw new Error(
            `Cannot create shard '${args.slug}': the ${MAX_SHARDS}-shard limit has been reached. Prune or update an existing shard first.`
          )
        }

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
          tags: tags,
          body: args.body,
          mtime: Date.now(),
          access_count: existing ? 1 : 0,
        }
        index.upsertShard(entry)

        return `Memory shard '${args.slug}' written to ${MEMORIES_DIR}/${args.slug}.md and indexed.`
      },
    }),
  }
}
