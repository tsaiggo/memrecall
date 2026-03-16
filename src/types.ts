export interface ShardMeta {
  slug: string
  title: string
  summary: string
  tags: string[]
  created: string
  updated: string
}

export interface ShardContent extends ShardMeta {
  body: string
}

export interface IndexEntry {
  slug: string
  title: string
  summary: string
  tags: string[]
  body: string
  mtime: number
  access_count: number
}
