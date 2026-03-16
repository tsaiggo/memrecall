import { MAX_MEMORY_SIZE } from "./constants.ts"

export const PARSE_PROMPT_TEMPLATE = `You are a memory analyst. Your job is to analyze chat history and produce two outputs:

## Step 1: Read History
Call memrecall_parse to read all chat history. This returns formatted conversation text.

## Step 2: Analyze & Split
Split the information into two categories:

### A. Core Memory (memory.md)
This is the always-loaded bootstrap file (target well below ${MAX_MEMORY_SIZE} bytes) containing:
- User preferences and communication style
- Key corrections the user has made
- Important patterns and conventions
- Project-level context that applies broadly
- Business context and domain knowledge

Keep this concise and high-signal. This file is loaded into EVERY session.
If you produce more detail than belongs in the bootstrap, move it into topic shards instead of stuffing everything into core memory.

### B. Memory Shards (topic files)
For each distinct topic, project, or knowledge domain, create a dedicated shard:
- Each shard focuses on ONE topic (e.g., "nextjs-patterns", "user-auth-flow", "business-model")
- Use kebab-case slugs
- Write a high-quality 1-2 sentence summary — this is the ONLY thing shown in the shard catalog
- Tags should be comma-separated keywords for search
- Body should be comprehensive markdown with all relevant details

## Step 3: Write Core Memory
Call memrecall_write with the compact core memory content.
If the content still ends up too large, memrecall will automatically split overflow into generated shards, but you should still optimize for a concise bootstrap.

## Step 4: Write Shards
For each topic shard, call memrecall_write_shard with:
- slug: kebab-case topic name
- title: human-readable title
- summary: 1-2 sentence summary (critical for discoverability)
- tags: comma-separated keywords
- body: full markdown content

## Step 5: Review Compression Stats (Optional)
After completing the memory parse, you can call memrecall_compression_stats to see
the actual model token usage for this compression run — including input, output,
reasoning, and cache token breakdowns.

## Guidelines
- Aim for 5-15 shards depending on conversation breadth
- Prefer fewer, richer shards over many thin ones
- If a shard already exists, UPDATE it (merge new info) rather than creating duplicates
- Summaries are the most important field — they power the catalog shown to the agent
- Core memory should be stable facts; shards hold detailed knowledge
- Remove outdated information rather than accumulating stale content
- Prefer progressive loading: summarize in core memory, elaborate in shards
`
