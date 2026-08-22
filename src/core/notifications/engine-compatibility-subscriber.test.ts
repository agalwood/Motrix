import { EventBus } from '@core/events/event-bus'
import { Events } from '@shared/protocol/events'
import { NotificationKinds } from '@shared/types/notification'
import { describe, expect, it, vi } from 'vitest'
import { registerEngineCompatibilitySubscriber } from './engine-compatibility-subscriber'

describe('registerEngineCompatibilitySubscriber', () => {
  it('maps the pre-spawn probe warning to a durable notification input', () => {
    const eventBus = new EventBus()
    const notify = vi.fn()
    registerEngineCompatibilitySubscriber({
      eventBus,
      notificationCenter: { notify },
      log: { warn: vi.fn() },
    })

    eventBus.emit(Events.EngineCompatibilityWarning, {
      version: '1.37.0',
      connectionLimit: 16,
    })

    expect(notify).toHaveBeenCalledWith({
      sourceKey: 'engine-compatibility:1.37.0',
      kind: NotificationKinds.EngineCompatibility,
      severity: 'warning',
      titleKey: 'notification.engineCompatibility.title',
      bodyKey: 'notification.engineCompatibility.body',
      bodyParams: { version: '1.37.0', limit: '16' },
    })
  })

  it('isolates notification-store failures from engine startup', () => {
    const eventBus = new EventBus()
    const warn = vi.fn()
    registerEngineCompatibilitySubscriber({
      eventBus,
      notificationCenter: {
        notify: vi.fn(() => {
          throw new Error('SQLITE_FULL')
        }),
      },
      log: { warn },
    })

    expect(() =>
      eventBus.emit(Events.EngineCompatibilityWarning, {
        version: '1.37.0',
        connectionLimit: 16,
      })
    ).not.toThrow()
    expect(warn).toHaveBeenCalledOnce()
  })
})
