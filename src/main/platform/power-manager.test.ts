import { beforeEach, describe, expect, it, vi } from 'vitest'

// ─── Hoisted mocks (available before vi.mock factory runs) ──

const { mockStart, mockStop } = vi.hoisted(() => ({
  mockStart: vi.fn().mockReturnValue(42),
  mockStop: vi.fn(),
}))

vi.mock('electron', () => ({
  powerSaveBlocker: {
    start: mockStart,
    stop: mockStop,
  },
}))

import { EventBus } from '@core/events/event-bus'
import { Events } from '@shared/protocol/events'
import { setupPowerManager } from './power-manager'

// ─── Tests ──────────────────────────────────────────────────

describe('setupPowerManager', () => {
  let eventBus: EventBus

  beforeEach(() => {
    vi.clearAllMocks()
    eventBus = new EventBus()
    setupPowerManager(eventBus)
  })

  it('starts power save blocker when active', () => {
    eventBus.emit(Events.EngineActiveChanged, true)
    expect(mockStart).toHaveBeenCalledWith('prevent-app-suspension')
  })

  it('stops power save blocker when inactive', () => {
    eventBus.emit(Events.EngineActiveChanged, true)
    eventBus.emit(Events.EngineActiveChanged, false)
    expect(mockStop).toHaveBeenCalledWith(42)
  })

  it('does not start twice', () => {
    eventBus.emit(Events.EngineActiveChanged, true)
    eventBus.emit(Events.EngineActiveChanged, true)
    expect(mockStart).toHaveBeenCalledTimes(1)
  })

  it('does not stop when not started', () => {
    eventBus.emit(Events.EngineActiveChanged, false)
    expect(mockStop).not.toHaveBeenCalled()
  })
})
