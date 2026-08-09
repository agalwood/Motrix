import { migrate } from '@core/session/migrations'
import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { PluginStateStore } from './plugin-state-store'

describe('PluginStateStore', () => {
  let db: Database.Database
  let store: PluginStateStore

  beforeEach(() => {
    db = new Database(':memory:')
    migrate(db)
    store = new PluginStateStore(db)
  })

  it('upserts and reads a state row', () => {
    store.upsert({
      pluginId: 'alice.demo',
      enabled: true,
      status: 'inactive',
      errorCount: 0,
      installedAt: 1_715_000_000_000,
    })
    const r = store.get('alice.demo')
    expect(r?.enabled).toBe(true)
    expect(r?.errorCount).toBe(0)
  })

  it('lists all records', () => {
    store.upsert({
      pluginId: 'a.x',
      enabled: true,
      status: 'inactive',
      errorCount: 0,
      installedAt: 0,
    })
    store.upsert({
      pluginId: 'b.y',
      enabled: false,
      status: 'disabled',
      errorCount: 0,
      installedAt: 0,
    })
    expect(store.list()).toHaveLength(2)
  })

  it('setEnabled toggles enabled flag', () => {
    store.upsert({
      pluginId: 'a.x',
      enabled: true,
      status: 'inactive',
      errorCount: 0,
      installedAt: 0,
    })
    store.setEnabled('a.x', false)
    expect(store.get('a.x')?.enabled).toBe(false)
  })

  it('recordError increments error_count and stores last_error', () => {
    store.upsert({
      pluginId: 'a.x',
      enabled: true,
      status: 'inactive',
      errorCount: 0,
      installedAt: 0,
    })
    store.recordError('a.x', 'boom')
    expect(store.get('a.x')?.errorCount).toBe(1)
    expect(store.get('a.x')?.lastError).toBe('boom')
  })

  it('clearError zeroes the counter and last_error', () => {
    store.upsert({
      pluginId: 'a.x',
      enabled: true,
      status: 'inactive',
      errorCount: 0,
      installedAt: 0,
    })
    store.recordError('a.x', 'boom')
    store.clearError('a.x')
    expect(store.get('a.x')?.errorCount).toBe(0)
    expect(store.get('a.x')?.lastError).toBeUndefined()
  })

  it('remove deletes a row', () => {
    store.upsert({
      pluginId: 'a.x',
      enabled: true,
      status: 'inactive',
      errorCount: 0,
      installedAt: 0,
    })
    store.remove('a.x')
    expect(store.get('a.x')).toBeUndefined()
  })
})
