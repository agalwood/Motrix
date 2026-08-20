import { Events } from '@shared/protocol/events'
import { NotificationKinds } from '@shared/types/notification'
import { describe, expect, it, vi } from 'vitest'
import {
  type PublishEngineRestartRequiredDeps,
  publishEngineRestartRequired,
} from './engine-restart-required'

function makeDeps(): PublishEngineRestartRequiredDeps {
  return {
    eventBus: { emit: vi.fn() } as never,
    notificationCenter: { notify: vi.fn(() => ({ fresh: true })) },
    log: { warn: vi.fn() } as never,
  }
}

describe('publishEngineRestartRequired', () => {
  it('writes a durable warning and emits the action-toast event', () => {
    const deps = makeDeps()

    publishEngineRestartRequired(deps, ['rpcPort', 'diskCache'])

    expect(deps.notificationCenter.notify).toHaveBeenCalledWith({
      sourceKey: expect.stringMatching(/^engine-restart-required:/),
      kind: NotificationKinds.EngineRestartRequired,
      severity: 'warning',
      titleKey: 'notification.engineRestartRequired.title',
      bodyKey: 'notification.engineRestartRequired.body',
    })
    expect(deps.eventBus.emit).toHaveBeenCalledWith(
      Events.EngineRestartRequired,
      { changedKeys: ['rpcPort', 'diskCache'] }
    )
  })

  it('still emits the toast event when the notification store fails', () => {
    const deps = makeDeps()
    vi.mocked(deps.notificationCenter.notify).mockImplementation(() => {
      throw new Error('disk full')
    })

    expect(() => publishEngineRestartRequired(deps, ['rpcPort'])).not.toThrow()
    expect(deps.log.warn).toHaveBeenCalledOnce()
    expect(deps.eventBus.emit).toHaveBeenCalledWith(
      Events.EngineRestartRequired,
      { changedKeys: ['rpcPort'] }
    )
  })
})
