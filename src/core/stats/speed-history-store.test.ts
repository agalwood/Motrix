// src/core/stats/speed-history-store.test.ts
import type { GlobalStats } from '@shared/types/stats'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SpeedHistoryStore } from './speed-history-store'

const stats = (down: number, up: number): GlobalStats => ({
  totalDownloadSpeed: down,
  totalUploadSpeed: up,
  activeTasks: 0,
  waitingTasks: 0,
  stoppedTasks: 0,
})

describe('SpeedHistoryStore', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-07T12:00:00Z'))
  })

  it('appends points with current timestamp', () => {
    const store = new SpeedHistoryStore()
    store.append(stats(100, 20))
    expect(store.snapshot()).toEqual([{ t: Date.now(), down: 100, up: 20 }])
  })

  it('returns a defensive copy from snapshot', () => {
    const store = new SpeedHistoryStore()
    store.append(stats(1, 2))
    const a = store.snapshot()
    store.append(stats(3, 4))
    expect(a).toHaveLength(1)
  })

  it('trims buffer at MAX_POINTS', () => {
    const store = new SpeedHistoryStore()
    for (let i = 0; i < 250; i += 1) store.append(stats(i, 0))
    const points = store.snapshot()
    expect(points).toHaveLength(200)
    expect(points[0]?.down).toBe(50) // oldest 50 dropped
    expect(points[199]?.down).toBe(249)
  })

  it('honours snapshot(limit) when limit < buffer.length', () => {
    const store = new SpeedHistoryStore()
    for (let i = 0; i < 30; i += 1) store.append(stats(i, 0))
    expect(store.snapshot(10)).toHaveLength(10)
    expect(store.snapshot(10)[0]?.down).toBe(20)
  })

  it('clear() empties the buffer', () => {
    const store = new SpeedHistoryStore()
    store.append(stats(1, 2))
    store.clear()
    expect(store.snapshot()).toEqual([])
  })
})
