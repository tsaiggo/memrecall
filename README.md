# memrecall

> Progressive memory loading for OpenCode agents.

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/runtime-Bun-f472b6?logo=bun)](https://bun.sh)

## Table of Contents

- [Why memrecall?](#why-memrecall)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [How It Works](#how-it-works)
- [Architecture](#architecture)
- [Tools Reference](#tools-reference)
- [Configuration](#configuration)
- [File Structure](#file-structure)
- [Memory Lifecycle](#memory-lifecycle)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [License](#license)

## Why memrecall?

AI coding agents lose context between sessions.

Every new OpenCode session starts with a blank slate. The agent doesn't remember
your projects, preferences, patterns, or past decisions unless that context is
reintroduced.

memrecall solves that with progressive memory loading.

- A small **Core Memory** file, capped at 64 KB, is loaded into every session.
- Deep **Memory Shards** are stored as topic files and loaded only when needed.
- A local **SQLite FTS5** index finds the right shard fast, with BM25 ranking.

This gives you a practical middle ground.

You keep a stable memory profile for broad context, and you keep detailed notes
in topic shards that don't need to live in every prompt.

The result is better continuity, lower prompt bloat, and a memory system that
matches how real projects grow over time.

## Installation

**Prerequisite:** Bun is required. The plugin uses `bun:sqlite` for embedded
full-text search.

1. Clone the repository:

   ```bash
   git clone https://github.com/tsaiggo/memrecall.git
   ```

2. Enter the project directory and install dependencies:

   ```bash
   bun install
   ```

3. Create the plugin bridge file at `~/.opencode/plugins/memrecall.ts`:

   ```typescript
   export { default } from "/path/to/memrecall/src/index"
   ```

4. Register the plugin in your OpenCode config.

   Use either:

   - `~/.config/opencode/opencode.json`
   - project-level `.opencode/config.json`

5. Start OpenCode in any project where you want memory support.

At runtime, the plugin writes memory files under the current project directory,
inside `.opencode/`.

## Quick Start

You can get useful memory in about a minute.

1. Open OpenCode in any project.
2. Run `/memory-parse`.
3. The agent reads your chat history and splits it into:
   - `memory.md` for stable, always-loaded context
   - `memories/*.md` for topic-specific details
4. On the next session, memrecall auto-loads the core profile and exposes a
   shard catalog in tool descriptions.

What gets created:

```text
.opencode/
├─ memory.md
├─ memory-index.db
└─ memories/
   ├─ project-overview.md
   └─ coding-preferences.md
```

Example `memory.md`:

```markdown
# User Memory

## Communication
- Prefers concise answers
- Wants exact command examples

## Project Context
- Maintains OpenCode plugins in TypeScript
- Uses Bun for local development

## Conventions
- Keep docs professional and direct
- Avoid unnecessary prompt noise
```

Example shard file:

```markdown
---
title: OpenCode Plugin Patterns
summary: Notes about plugin structure, tool design, and session memory flow.
tags: opencode, plugin, memory, typescript
created: 2026-03-13
updated: 2026-03-13
---

## Key points

- Register tools in `src/index.ts`
- Keep summaries short because the catalog shows only summary text
- Load full shard content only when the topic becomes relevant
```

The slug is the file name, not a frontmatter field. For the example above, the
file would be `opencode-plugin-patterns.md`.

## How It Works

memrecall uses a two-tier memory design.

**Core Memory**

- File: `.opencode/memory.md`
- Size cap: 65,536 bytes
- Loaded into every session as an instruction if the file exists
- Best for user preferences, project overview, business context, and stable
  conventions

**Memory Shards**

- Directory: `.opencode/memories/`
- Size cap per shard: 32,768 bytes
- One topic per file
- Best for project notes, workflows, architecture details, and past decisions

**FTS5 Index**

- File: `.opencode/memory-index.db`
- Built with SQLite FTS5 through `bun:sqlite`
- Tokenizer: `porter unicode61`
- Search uses `bm25(shards_fts)` and orders by rank ascending
- Porter stemming means related word forms can match the same shard

**Shard Catalog**

- Built at session start from `index.getCatalog()`
- Embedded into the descriptions for `memrecall_load` and
  `memrecall_search`
- Capped at 4,096 bytes
- Gives the agent a lightweight index of available topics before it runs a tool

Important behavior:

- The catalog is a session-start snapshot.
- New shards written during a session can appear in search results.
- They won't appear in the embedded catalog until the next session starts.

The `/memory-parse` command ties this together.

It instructs the agent to read session history, split stable knowledge from
topic knowledge, write the core profile, then write or update shards.

## Architecture

Diagram 1, plugin structure:

```text
OpenCode Session
|
+-- Plugin init
|   +-- load .opencode/memory.md
|   +-- build shard catalog
|   `-- register interfaces
|
+-- Tools (6)
|   +-- memrecall_parse
|   +-- memrecall_write
|   +-- memrecall_write_shard
|   +-- memrecall_search
|   +-- memrecall_load
|   `-- memrecall_prune
|
`-- Command (1)
    `-- /memory-parse
```

Diagram 2, data flow:

```text
Memory creation
Chat sessions -> /memory-parse -> memrecall_parse -> analyze + split
                                              |-> memrecall_write
                                              |   -> .opencode/memory.md
                                              `-> memrecall_write_shard
                                                  -> .opencode/memories/*.md
                                                  -> .opencode/memory-index.db

Memory recall
Session start -> auto-load .opencode/memory.md
             -> build shard catalog in tool descriptions
             -> memrecall_search -> memrecall_load
```

This design keeps the always-loaded context small, while still making deep
project knowledge easy to find.

## Tools Reference

The plugin exposes six tools.

### `memrecall_parse`

Read all chat history from OpenCode sessions. Returns formatted conversation
text for analysis.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| None | - | No | This tool takes no parameters. |

**Notes**

- Reads sessions through the OpenCode client.
- Sorts sessions by creation time, newest first.
- Truncates each text part to `MAX_MESSAGE_LENGTH`.
- Stops when total output reaches `MAX_TOTAL_OUTPUT`.

### `memrecall_write`

Write the generated memory profile to .opencode/memory.md

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `content` | `string` | Yes | The markdown content of the memory profile |

**Notes**

- Writes `.opencode/memory.md`.
- Truncates content if it exceeds `MAX_MEMORY_SIZE`.
- Appends `<!-- Memory truncated to fit size limit -->` when truncated.

### `memrecall_write_shard`

Write a memory shard to disk and index it for search.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `slug` | `string` | Yes | Kebab-case topic name, e.g. `nextjs-patterns` |
| `title` | `string` | Yes | Human-readable title |
| `summary` | `string` | Yes | 1-2 sentence summary for the catalog |
| `tags` | `string` | Yes | Comma-separated tags, e.g. `nextjs,react,routing` |
| `body` | `string` | Yes | Full markdown content for this shard |

**Notes**

- Splits `tags` on commas and trims whitespace.
- Preserves the existing `created` date when updating a shard.
- Sets `updated` to the current ISO date.
- Writes the shard file, then upserts the index entry.

### `memrecall_search`

Source description template:

`Search memory shards by keyword, topic, or project name. Returns ranked results.\n\n${catalog}\n\nSupports FTS5 query syntax: AND, OR, NOT, prefix* matching.`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | `string` | Yes | Search query to find relevant memory shards. Use keywords, topics, or project names. |

**Notes**

- Calls `index.search(args.query, 5)`.
- Returns up to 5 results.
- If the query is empty after trimming, the index returns the most-accessed
  shards.
- On no match, the tool rebuilds the catalog and returns it with the message.

### `memrecall_load`

Source description template:

`Load full content of a specific memory shard by slug.\n\n${catalog}`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `slug` | `string` | Yes | The slug of the memory shard to load |

**Notes**

- Reads the shard from `.opencode/memories/<slug>.md`.
- Increments the shard access counter on successful load.
- Returns XML-like wrapper text with slug, title, tags, updated date, and body.

### `memrecall_prune`

Remove stale memory shards or list candidates for pruning.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `slug` | `string` | No | Specific shard slug to prune. If omitted, shows stale shards for review. |

**Notes**

- If `slug` is provided, deletes the shard file and removes it from the index.
- If `slug` is omitted, lists stale shards where `access_count < 2`.
- Stale shards are sorted by lowest access count first.

## Configuration

These constants come from `src/constants.ts`.

| Constant | Value | Description |
|----------|-------|-------------|
| `MAX_MEMORY_SIZE` | `65536` | Max size in bytes for `.opencode/memory.md` |
| `MAX_SHARD_SIZE` | `32768` | Max size in bytes for a single memory shard file |
| `MAX_MESSAGE_LENGTH` | `2000` | Max characters kept from one text message part when parsing history |
| `MAX_TOTAL_OUTPUT` | `10485760` | Max total bytes returned by `memrecall_parse` |
| `MAX_CATALOG_SIZE` | `4096` | Max size in bytes for the embedded shard catalog |
| `MAX_SHARDS` | `50` | Declared shard count limit constant |

Other fixed paths and names:

| Constant | Value |
|----------|-------|
| `PLUGIN_NAME` | `memrecall` |
| `MEMORY_FILE` | `.opencode/memory.md` |
| `MEMORIES_DIR` | `.opencode/memories` |
| `INDEX_DB_FILE` | `.opencode/memory-index.db` |

In the current source, `MAX_SHARDS` is defined but not enforced inside the tool
implementation.

## File Structure

Runtime layout inside a project:

```text
.opencode/
├─ memory.md
├─ memory-index.db
└─ memories/
   ├─ topic-a.md
   ├─ topic-b.md
   └─ topic-c.md
```

What each file does:

- `memory.md` holds stable, broad context for every session.
- `memory-index.db` stores the FTS5 search index and shard metadata.
- `memories/*.md` stores topic-specific shards with YAML frontmatter.

Shard file format from `src/shard.ts`:

```markdown
---
title: <title>
summary: <summary>
tags: <tag1>, <tag2>, <tag3>
created: <YYYY-MM-DD>
updated: <YYYY-MM-DD>
---

<markdown body>
```

Notes about the format:

- The file name provides the shard slug.
- `tags` are stored in frontmatter as a comma-separated line.
- The body is trimmed when parsed.
- If a shard grows past the size cap, the body is truncated and a notice is
  appended.

## Memory Lifecycle

memrecall follows a simple lifecycle.

1. **Create**
   - Run `/memory-parse`.
   - The agent reads chat history with `memrecall_parse`.
   - It writes the core profile with `memrecall_write`.
   - It writes topic shards with `memrecall_write_shard`.

2. **Search**
   - Use `memrecall_search` with a keyword, topic, or project name.
   - The query runs against SQLite FTS5.
   - Results are ranked with BM25 and returned in ascending rank order.

3. **Load**
   - Use `memrecall_load` with a shard slug.
   - The full shard content is returned.
   - Each successful load increments `access_count` in the index.

4. **Update**
   - Write a shard again with the same slug.
   - The existing `created` date is preserved.
   - `updated` is refreshed to the current date.
   - The FTS table is deleted then reinserted for that slug.

5. **Prune**
   - Use `memrecall_prune` with no slug to review stale shards.
   - Use `memrecall_prune` with a slug to remove a shard.
   - A shard is considered stale when `access_count < 2`.

This gives you a memory system that can grow, refresh, and clean itself over
time without forcing every detail into every session.

## Troubleshooting

**`/memory-parse` says no sessions were found**

Make sure you already have OpenCode chat history available. The parser only
works on existing sessions.

**Search returns no results**

Try simpler keywords, topic names, or project names. FTS5 supports operators
such as `AND`, `OR`, `NOT`, and `prefix*` matching.

**A shard exists on disk but does not show up in the catalog**

The catalog is built once at session start. Search can still find newly written
shards, but the embedded catalog updates on the next session.

**A large memory file or shard was cut off**

This is expected when the size cap is exceeded. Core memory is capped at 65,536
bytes. Each shard is capped at 32,768 bytes.

**The plugin fails with an FTS5 error**

The source checks FTS5 availability during index initialization and throws
`FTS5 not available in this Bun build` if support is missing. Use a Bun build
with SQLite FTS5 enabled.

## Development

For contributors working on the plugin itself:

**Prerequisites**

- Bun 1.x or newer
- TypeScript 5 or newer

**Project structure**

- `src/index.ts`, plugin entry point, command registration, tool registration,
  core memory auto-load, and shard catalog injection
- `src/constants.ts`, shared paths and size limits
- `src/types.ts`, TypeScript interfaces for `ShardMeta`, `ShardContent`, and
  `IndexEntry`
- `src/index-db.ts`, SQLite setup, FTS5 search, BM25 ranking, access counters,
  stale shard queries, and catalog reads
- `src/shard.ts`, shard serialization, YAML frontmatter parsing, file I/O,
  truncation, and deletion helpers
- `src/prompt.ts`, the `/memory-parse` command template used to drive memory
  extraction

**Build**

```bash
bun build ./src/index.ts --outdir dist --target bun
```

**Local testing**

1. Link the plugin through `~/.opencode/plugins/memrecall.ts`.
2. Register it in OpenCode config.
3. Start OpenCode in a test project.
4. Run `/memory-parse`.
5. Inspect `.opencode/memory.md`, `.opencode/memories/`, and search behavior.

**Implementation notes**

- `listShards()` exists in `src/shard.ts` as a utility.
- The plugin currently uses `index.getCatalog()` for the runtime catalog.
- The FTS table is updated by deleting the old row, then inserting the new row.
- `memrecall_load` increments access counts through `index.incrementAccess()`.

**TypeScript types**

| Type | Purpose |
|------|---------|
| `ShardMeta` | Frontmatter and metadata for a shard |
| `ShardContent` | `ShardMeta` plus the markdown body |
| `IndexEntry` | Search index payload plus `mtime` and `access_count` |

## License

Apache 2.0, see [LICENSE](LICENSE)
