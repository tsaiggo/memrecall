# memrecall

> Long-term memory for OpenCode without prompt bloat.

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/runtime-Bun-f472b6?logo=bun)](https://bun.sh)

memrecall helps OpenCode sessions keep useful long-term context without forcing every detail into every prompt.

- `memory.md` stores compact, always-loaded context.
- `memories/*.md` stores deeper topic-specific shards.
- SQLite FTS5 makes those shards searchable when the agent needs them.

In practice, that means you can keep stable project context available in every session while still storing richer notes, decisions, and workflows as load-on-demand memory.

## Table of Contents

- [Getting Started](#getting-started)
- [How It Works](#how-it-works)
- [Common Workflows](#common-workflows)
- [Tools Overview](#tools-overview)
- [Configuration](#configuration)
- [Development](#development)
- [License](#license)

## Getting Started

### Prerequisites

- Bun
- OpenCode
- Access to either:
  - `~/.config/opencode/opencode.json`, or
  - project-level `.opencode/config.json`

### Install

Clone the repository and install dependencies:

```bash
git clone https://github.com/tsaiggo/memrecall.git
cd memrecall
bun install
```

### Register the plugin

Create `~/.opencode/plugins/memrecall.ts`:

```typescript
export { default } from "/path/to/memrecall/src/index"
```

### Enable it in OpenCode

Register the plugin in your OpenCode config using either the global config or a project-level config.

memrecall writes its runtime files under the current project directory inside `.opencode/`.

### Run `/memory-parse`

Open OpenCode in a project with existing chat history, then run:

```text
/memory-parse
```

The command asks the agent to:

1. read prior OpenCode sessions,
2. extract stable context into core memory,
3. split detailed topics into shards, and
4. write the results back into `.opencode/`.

### Expected output

After the first run, memrecall writes files like these inside the current project:

```text
.opencode/
├─ memory.md
├─ memory-index.db
├─ memory-run-stats.json
└─ memories/
   ├─ project-overview.md
   └─ coding-preferences.md
```

- `memory.md` is the compact bootstrap loaded into future sessions.
- `memory-index.db` stores the shard search index.
- `memory-run-stats.json` records token usage for completed compression runs.
- `memories/*.md` holds topic-specific knowledge for progressive loading.

## How It Works

memrecall uses a two-layer memory model.

### Core memory

- Path: `.opencode/memory.md`
- Size cap: `65536` bytes
- Loaded automatically into future sessions when present
- Best for stable, broad context such as user preferences, project conventions, and long-lived background knowledge
- This is the layer that gives future sessions immediate continuity

### Memory shards

- Path: `.opencode/memories/`
- Size cap per shard: `32768` bytes
- One topic per file
- Best for detailed notes, project decisions, architecture details, workflows, and historical context
- This is the layer that keeps deep memory available without loading it all at once

### Search and retrieval

- Path: `.opencode/memory-index.db`
- Built with SQLite FTS5 via `bun:sqlite`
- Search uses BM25 ranking over indexed shard content
- `memrecall_search` finds relevant shards
- `memrecall_load` retrieves the full shard body when needed

The default pattern is: search first, then load the one shard you actually need.

### Automatic overflow handling

If core memory is too large, memrecall does not keep expanding `memory.md` forever.
Instead, it keeps a smaller bootstrap and moves overflow into generated `core-auto-*` shards so the always-loaded context stays compact.

### Session catalog behavior

At session start, memrecall builds a lightweight shard catalog and embeds it into tool descriptions.

- Search can still find newly written shards in the same session.
- The embedded catalog itself refreshes on the next session start.

## Common Workflows

### 1. Initialize project memory

Use `/memory-parse` when you want to build or refresh memory from existing OpenCode history.

Typical result:

- stable facts go into `memory.md`
- detailed topics go into shard files
- the shard index updates automatically

This is usually the first thing to run after installing the plugin in a project you already work in.

### 2. Recall a topic

When you know the subject but not the exact shard name:

1. run `memrecall_search`
2. pick a matching slug from the results
3. run `memrecall_load` for the full content

This keeps the default prompt small while still making deep memory available on demand.

### 3. Update memory directly

Use:

- `memrecall_write` for the core bootstrap
- `memrecall_write_shard` for topic-specific knowledge

Use the core bootstrap for high-signal facts that should always be present, and shards for material that only matters in certain conversations.

When writing an existing shard again, memrecall preserves the original `created` date and refreshes `updated`.

### 4. Clean up stale memory

Run `memrecall_prune` without arguments to list low-value shards, then prune a specific slug when you want to remove it.

### 5. Inspect compression token usage

Run `memrecall_compression_stats` after `/memory-parse` to inspect the recorded token usage for the latest completed compression run, including input, output, reasoning, and cache tokens.

## Tools Overview

memrecall exposes seven tools.

### `memrecall_parse`

Reads OpenCode session history and returns formatted conversation text for analysis.

- **Use it when:** you want source material for memory extraction
- **Arguments:** none
- **Returns:** formatted session history, newest sessions first, capped by `MAX_TOTAL_OUTPUT`
- **Most often used by:** the `/memory-parse` workflow

### `memrecall_write`

Writes the core memory bootstrap to `.opencode/memory.md`.

- **Use it when:** you want to save stable, always-loaded memory
- **Arguments:** `content`
- **Returns:** a success message with byte and token estimates
- **Important:** if the content is too large, memrecall automatically splits overflow into generated shards

### `memrecall_write_shard`

Writes a topic shard to disk and updates the search index.

- **Use it when:** you want to add or update detailed topic memory
- **Arguments:** `slug`, `title`, `summary`, `tags`, `body`
- **Returns:** the shard path and indexing confirmation
- **Important:** summaries matter because they drive shard discoverability in search and catalog views

### `memrecall_search`

Searches shard memory by keyword, topic, or project name.

- **Use it when:** you know the topic but not the shard slug
- **Arguments:** `query`
- **Returns:** up to 5 ranked shard matches with title, slug, summary, and tags
- **Next step:** usually follow with `memrecall_load`

### `memrecall_load`

Loads the full content of a specific shard.

- **Use it when:** you already know the shard slug
- **Arguments:** `slug`
- **Returns:** the shard body plus title, tags, and updated date
- **Important:** successful loads increment shard access counts

### `memrecall_prune`

Lists stale shards or removes one by slug.

- **Use it when:** you want to review or delete low-value memory
- **Arguments:** optional `slug`
- **Returns:** either a stale-shard list or a prune confirmation
- **Important:** listing stale shards is a review step; pruning is a separate explicit action

### `memrecall_compression_stats`

Shows recorded token usage for the latest completed `/memory-parse` compression run.

- **Use it when:** you want actual model usage instead of rough estimates
- **Arguments:** optional `sessionID`
- **Returns:** session metadata, timestamps, cost, and a full token breakdown

## Configuration

These constants come from `src/constants.ts`.

| Constant | Value | Description |
|----------|-------|-------------|
| `MAX_MEMORY_SIZE` | `65536` | Max size in bytes for `.opencode/memory.md` |
| `MAX_SHARD_SIZE` | `32768` | Max size in bytes for a single shard file |
| `MAX_MESSAGE_LENGTH` | `2000` | Max characters kept from a single text message part during parsing |
| `MAX_TOTAL_OUTPUT` | `10485760` | Max total bytes returned by `memrecall_parse` |
| `MAX_CATALOG_SIZE` | `4096` | Max size in bytes for the embedded shard catalog |
| `MAX_SHARDS` | `50` | Max total shard count across generated and user-created shards |
| `CORE_BOOTSTRAP_TARGET_SIZE` | `8192` | Target size for the always-loaded summary when overflow splitting occurs |

Other fixed names and paths:

| Constant | Value |
|----------|-------|
| `PLUGIN_NAME` | `memrecall` |
| `MEMORY_FILE` | `.opencode/memory.md` |
| `MEMORIES_DIR` | `.opencode/memories` |
| `INDEX_DB_FILE` | `.opencode/memory-index.db` |
| `COMPRESSION_RUN_STATS_FILE` | `.opencode/memory-run-stats.json` |

Runtime shard files use this frontmatter shape:

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

The slug comes from the file name, not a frontmatter field.

## Development

### Prerequisites

- Bun 1.x or newer
- TypeScript 5 or newer

### Project structure

- `src/index.ts` — plugin entry point, command registration, bootstrap auto-load, and tool wiring
- `src/tools.ts` — tool implementations and OpenCode-facing behavior
- `src/memory-planner.ts` — bootstrap planning and automatic overflow splitting
- `src/shard.ts` — shard serialization, parsing, truncation, and file I/O
- `src/index-db.ts` — SQLite setup, FTS5 search, ranking, and shard metadata
- `src/catalog.ts` — shard catalog building and index reconciliation
- `src/compression-run.ts` — compression run tracking
- `src/compression-io.ts` — persisted compression stats history
- `src/prompt.ts` — `/memory-parse` prompt template
- `src/token.ts` — local token estimation heuristics
- `src/types.ts` — shared TypeScript interfaces

### Build

```bash
bun build ./src/index.ts --outdir dist --target bun
```

### Test

```bash
bun test
./node_modules/.bin/tsc --noEmit
```

### Local verification flow

1. Link the plugin through `~/.opencode/plugins/memrecall.ts`.
2. Register it in OpenCode config.
3. Start OpenCode in a test project.
4. Run `/memory-parse`.
5. Inspect `.opencode/memory.md`, `.opencode/memories/`, search results, and compression stats.

## License

Apache 2.0, see [LICENSE](LICENSE)
