import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BadgeController,
  makeBadgeNotify,
} from '@/background/badge/BadgeController'

declare const browser: {
  action: {
    setIcon: (d: unknown) => Promise<void>
    setBadgeText: (d: { text: string }) => Promise<void>
    setBadgeBackgroundColor: (d: { color: string }) => Promise<void>
    setBadgeTextColor?: (d: { color: string }) => Promise<void>
    setTitle: (d: { title: string }) => Promise<void>
  }
}

const store = (v: boolean) => {
  let cur = v
  return {
    get: vi.fn(async () => cur),
    set: vi.fn(async (n: boolean) => {
      cur = n
    }),
  }
}

beforeEach(() => {
  browser.action = {
    setIcon: vi.fn(async () => {}),
    setBadgeText: vi.fn(async () => {}),
    setBadgeBackgroundColor: vi.fn(async () => {}),
    setBadgeTextColor: vi.fn(async () => {}),
    setTitle: vi.fn(async () => {}),
  }
})

describe('BadgeController.refresh', () => {
  it('connected + idle → colour icon path, empty badge text', async () => {
    const c = new BadgeController({
      getState: () => 'connected',
      hasActiveTasks: () => false,
      errorStore: store(false),
    })
    await c.refresh()
    expect(browser.action.setIcon).toHaveBeenCalledWith({
      path: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png' },
    })
    expect(browser.action.setBadgeText).toHaveBeenCalledWith({ text: '' })
    expect(browser.action.setTitle).toHaveBeenCalled()
  })

  it('connected + active → green ↓ badge', async () => {
    const c = new BadgeController({
      getState: () => 'connected',
      hasActiveTasks: () => true,
      errorStore: store(false),
    })
    await c.refresh()
    expect(browser.action.setBadgeText).toHaveBeenCalledWith({ text: '↓' })
    expect(browser.action.setBadgeBackgroundColor).toHaveBeenCalledWith({
      color: '#12b886',
    })
    expect(browser.action.setBadgeTextColor).toHaveBeenCalledWith({
      color: '#ffffff',
    })
  })

  it('connecting → grey icon without a browser badge', async () => {
    const c = new BadgeController({
      getState: () => 'connecting',
      hasActiveTasks: () => false,
      errorStore: store(false),
    })
    await c.refresh()
    expect(browser.action.setIcon).toHaveBeenCalledWith({
      path: { 16: 'icons/icon-16-grey.png', 32: 'icons/icon-32-grey.png' },
    })
    expect(browser.action.setBadgeText).toHaveBeenCalledWith({ text: '' })
    expect(browser.action.setBadgeBackgroundColor).not.toHaveBeenCalled()
  })

  it('unack error → red ! and grey icon path when disconnected', async () => {
    const c = new BadgeController({
      getState: () => 'disconnected',
      hasActiveTasks: () => false,
      errorStore: store(true),
    })
    await c.refresh()
    expect(browser.action.setIcon).toHaveBeenCalledWith({
      path: { 16: 'icons/icon-16-grey.png', 32: 'icons/icon-32-grey.png' },
    })
    expect(browser.action.setBadgeText).toHaveBeenCalledWith({ text: '!' })
    expect(browser.action.setBadgeBackgroundColor).toHaveBeenCalledWith({
      color: '#e03131',
    })
  })

  it('markError/clearError persist then repaint', async () => {
    const s = store(false)
    const c = new BadgeController({
      getState: () => 'connected',
      hasActiveTasks: () => false,
      errorStore: s,
    })

    await c.markError()
    expect(s.set).toHaveBeenCalledWith(true)
    expect(browser.action.setBadgeText).toHaveBeenCalledTimes(1)
    expect(browser.action.setBadgeText).toHaveBeenCalledWith({ text: '!' })
    expect(browser.action.setIcon).toHaveBeenCalledTimes(1)

    vi.clearAllMocks()

    await c.clearError()
    expect(s.set).toHaveBeenCalledWith(false)
    expect(browser.action.setBadgeText).toHaveBeenCalledTimes(1)
    expect(browser.action.setBadgeText).toHaveBeenCalledWith({ text: '' })
    expect(browser.action.setIcon).toHaveBeenCalledTimes(1)
  })

  it('icon failure does not suppress the badge/tooltip', async () => {
    // setIcon is applied LAST; a failure there must not roll back the badge.
    browser.action.setIcon = vi.fn(async () => {
      throw new Error('setIcon failed')
    })
    const c = new BadgeController({
      getState: () => 'disconnected',
      hasActiveTasks: () => false,
      errorStore: store(true),
    })
    await expect(c.refresh()).resolves.toBeUndefined()
    expect(browser.action.setBadgeText).toHaveBeenCalledWith({ text: '!' })
    expect(browser.action.setBadgeBackgroundColor).toHaveBeenCalledWith({
      color: '#e03131',
    })
    expect(browser.action.setTitle).toHaveBeenCalled()
  })

  it('missing setBadgeTextColor does not throw', async () => {
    browser.action.setBadgeTextColor = undefined
    const c = new BadgeController({
      getState: () => 'connected',
      hasActiveTasks: () => true,
      errorStore: store(false),
    })
    await expect(c.refresh()).resolves.toBeUndefined()
  })
})

describe('makeBadgeNotify', () => {
  it('forwards task progress without marking or clearing a badge', () => {
    const taskProgress = vi.fn()
    const base = Object.assign(vi.fn(), { taskProgress })
    const badge = { markError: vi.fn(), clearError: vi.fn() }
    const notify = makeBadgeNotify(base, badge)
    const progress = {
      taskId: 'task-a',
      bytesDone: 50,
      phase: 'downloading' as const,
      source: {
        endpointId: 'local',
        endpointRevision: 0,
        instanceId: 'instance',
      },
    }
    notify.taskProgress?.(progress)
    expect(taskProgress).toHaveBeenCalledWith(progress)
    expect(base).not.toHaveBeenCalled()
    expect(badge.markError).not.toHaveBeenCalled()
    expect(badge.clearError).not.toHaveBeenCalled()
  })
  it('error → markError, confirm → clearError, reminder → neither; base always called', () => {
    const base = vi.fn()
    const badge = {
      markError: vi.fn(async () => {}),
      clearError: vi.fn(async () => {}),
    }
    const notify = makeBadgeNotify(base, badge)
    notify({ title: 't', message: 'm', severity: 'error' })
    notify({ title: 't', message: 'm', severity: 'confirm' })
    notify({ title: 't', message: 'm', severity: 'reminder' })
    expect(base).toHaveBeenCalledTimes(3)
    expect(badge.markError).toHaveBeenCalledTimes(1)
    expect(badge.clearError).toHaveBeenCalledTimes(1)
  })
})
