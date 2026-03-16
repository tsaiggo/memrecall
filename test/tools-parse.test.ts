import { describe, expect, it } from "bun:test"
import { compareSessionsByCreated, formatSessionDate } from "../src/tools"

describe("compareSessionsByCreated", () => {
  it("sorts sessions descending by time.created", () => {
    const sessions = [
      { time: { created: 3 } },
      { time: { created: 1 } },
      { time: { created: 2 } },
    ]
    sessions.sort(compareSessionsByCreated)
    expect(sessions.map((s) => s.time.created)).toEqual([3, 2, 1])
  })

  it("handles missing time field without crashing", () => {
    const sessions = [
      { time: { created: 5 } },
      {},
      { time: { created: 3 } },
    ] as any[]
    sessions.sort(compareSessionsByCreated)
    expect(sessions[0].time.created).toBe(5)
    expect(sessions[1].time.created).toBe(3)
  })

  it("sorts time.created === 0 to end", () => {
    const sessions: any[] = [
      { time: { created: 0 } },
      { time: { created: 10 } },
      { time: { created: 5 } },
    ]
    sessions.sort(compareSessionsByCreated)
    expect(sessions[0].time.created).toBe(10)
    expect(sessions[1].time.created).toBe(5)
    expect(sessions[2].time.created).toBe(0)
  })

  it("sorts time.created === undefined to end", () => {
    const sessions = [
      { time: { created: undefined } },
      { time: { created: 7 } },
      { time: { created: 4 } },
    ] as any[]
    sessions.sort(compareSessionsByCreated)
    expect(sessions[0].time.created).toBe(7)
    expect(sessions[1].time.created).toBe(4)
  })
})

describe("formatSessionDate", () => {
  it("formats seconds timestamp to YYYY-MM-DD", () => {
    const result = formatSessionDate(1742000000)
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it("formats milliseconds timestamp to YYYY-MM-DD", () => {
    const result = formatSessionDate(1742000000000)
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it("returns 'unknown' for undefined input", () => {
    expect(formatSessionDate(undefined)).toBe("unknown")
  })

  it("returns 'unknown' for zero input", () => {
    expect(formatSessionDate(0)).toBe("unknown")
  })
})
