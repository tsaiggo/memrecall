import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import path from "path"
import {
  upsertCompressionRunHistory,
  type CompressionRunRecord,
} from "./compression-run.ts"

export function readCompressionRunHistory(statsPath: string): CompressionRunRecord[] {
  if (!existsSync(statsPath)) {
    return []
  }

  try {
    const content = readFileSync(statsPath, "utf-8")
    const parsed = JSON.parse(content)
    return Array.isArray(parsed) ? parsed as CompressionRunRecord[] : []
  } catch {
    return []
  }
}

export function writeCompressionRunHistory(statsPath: string, history: CompressionRunRecord[]): void {
  const dir = path.dirname(statsPath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(statsPath, JSON.stringify(history, null, 2), "utf-8")
}

export function persistCompressionRun(statsPath: string, run: CompressionRunRecord): void {
  const history = readCompressionRunHistory(statsPath)
  writeCompressionRunHistory(statsPath, upsertCompressionRunHistory(history, run))
}
