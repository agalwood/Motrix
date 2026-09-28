import { EventEmitter } from 'node:events'
import { EventBus } from '@core/events/event-bus'
import { Events } from '@shared/protocol/events'
import { DEFAULT_APP_SETTINGS } from '@shared/schemas/app-settings'
import {
  type AppNotification,
  getHiddenNotificationKinds,
  NotificationKinds,
} from '@shared/types/notification'
import { describe, expect, it, vi } from 'vitest'
import { setupEventForwarding } from '../ipc/events'
import type { WindowManager } from '../window/window-manager'
import { createOsNotificationBridge } from './os-bridge'

vi.mock('electron', () => ({ Notification: {} }))

describe.each([NotificationKinds.TaskComplete, NotificationKinds.TaskError])(
  'desktop delivery of %s',
  (kind) => {
    it.each([true, false])(
      'applies all four channel choices without restarting (foreground=%s)',
      (foreground) => {
        const eventBus = new EventBus()
        const settings = { ...DEFAULT_APP_SETTINGS }
        const broadcast = vi.fn()
        const nativeShow = vi.fn()
        const warn = vi.fn()
        setupEventForwarding(
          eventBus,
          { broadcast } as unknown as WindowManager,
          () => getHiddenNotificationKinds(settings)
        )
        const bridge = createOsNotificationBridge({
          subscribe: (channel, listener) => {
            eventBus.on(channel, (payload) =>
              listener(payload as AppNotification)
            )
          },
          getAppSettings: () => settings,
          getMainWindow: () => ({
            isVisible: () => foreground,
            isFocused: () => foreground,
          }),
          showMainWindow: vi.fn(),
          translate: (key) => key,
          getTaskStatus: () => null,
          navigateToTask: vi.fn(),
          navigateToDownloads: vi.fn(),
          revealTaskInFolder: vi.fn(async () => {}),
          isSupported: () => true,
          createNotification: () =>
            Object.assign(new EventEmitter(), { show: nativeShow }),
          log: { warn },
        })

        for (const [system, inside] of [
          [false, false],
          [true, false],
          [false, true],
          [true, true],
        ]) {
          const completed = kind === NotificationKinds.TaskComplete
          settings[completed ? 'notifyOnComplete' : 'notifyOnError'] = system
          settings[completed ? 'notifyInAppOnComplete' : 'notifyInAppOnError'] =
            inside
          const payload: AppNotification = {
            id: `${kind}-${system}-${inside}`,
            sourceKey: null,
            kind,
            severity: completed ? 'info' : 'error',
            titleKey: completed
              ? 'notification.taskComplete.title'
              : 'notification.taskError.title',
            titleParams: { name: 'file.zip' },
            bodyKey: null,
            bodyParams: null,
            taskId: 't-1',
            createdAt: 1000,
            readAt: null,
          }
          nativeShow.mockClear()
          broadcast.mockClear()
          eventBus.emit(Events.NotificationAdded, payload)
          expect(nativeShow).toHaveBeenCalledTimes(system ? 1 : 0)
          expect(broadcast).toHaveBeenCalledTimes(inside ? 1 : 0)
          if (inside)
            expect(broadcast).toHaveBeenCalledWith(
              Events.NotificationAdded,
              payload
            )
        }
        expect(warn).not.toHaveBeenCalled()
        bridge.dispose()
      }
    )
  }
)
