import { existsSync, mkdirSync } from "fs"
import path from "path"
import type { Plugin } from "@opencode-ai/plugin"
import {
  MEMORY_FILE,
  MEMORIES_DIR,
  INDEX_DB_FILE,
  COMPRESSION_RUN_STATS_FILE,
} from "./constants.ts"
import type { CompressionRunRecord } from "./compression-run.ts"
import { PARSE_PROMPT_TEMPLATE } from "./prompt.ts"
import { MemoryIndex } from "./index-db.ts"
import { createEventHandler } from "./hooks.ts"
import { buildCatalog } from "./catalog.ts"
import { createTools } from "./tools.ts"

const plugin: Plugin = async (ctx) => {
  // Initialize memory index
  const indexPath = path.join(ctx.directory, INDEX_DB_FILE)
  const indexDir = path.dirname(indexPath)
  if (!existsSync(indexDir)) {
    mkdirSync(indexDir, { recursive: true })
  }
  const index = new MemoryIndex(indexPath)
  // TODO: MemoryIndex.close() exists but @opencode-ai/plugin has no shutdown/destroy hook to wire it.
  const memoriesDir = path.join(ctx.directory, MEMORIES_DIR)
  const compressionRunStatsPath = path.join(
    ctx.directory,
    COMPRESSION_RUN_STATS_FILE
  )
  const pendingCompressionRuns = new Map<string, CompressionRunRecord>()

  // Build dynamic shard catalog for tool descriptions
  const catalog = buildCatalog(index, memoriesDir)

  return {
    event: createEventHandler(pendingCompressionRuns, compressionRunStatsPath),
    config: async (input) => {
      input.command = input.command || {}
      input.command["memory-parse"] = {
        template: PARSE_PROMPT_TEMPLATE,
        description:
          "Analyze chat history and generate memory profile with shards",
      }

      const memoryPath = path.join(ctx.directory, MEMORY_FILE)
      if (existsSync(memoryPath)) {
        input.instructions = input.instructions || []
        input.instructions.push(MEMORY_FILE)
      }
    },
    tool: createTools(
      ctx,
      index,
      memoriesDir,
      compressionRunStatsPath,
      catalog
    ),
  }
}

export default plugin
