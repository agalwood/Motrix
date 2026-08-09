// Tests for createOsNotificationBridge (Task 16, spec §6).
//
// Mocks Electron's Notification class the same way
// src/main/plugin/notify-electron.test.ts does — vi.mock() is hoisted, so
// anything the factory references must come from vi.hoisted(). Relative
// import for the module under test because vitest.config.ts does not alias
// @main (see CLAUDE.md gotchas); @shared/@core aliases still work in tests.

import type { EventChannel } from '@shared/protocol/events'
import { Events } from '@shared/protocol/events'
import { DEFAULT_APP_SETTINGS } from '@shared/schemas/app-settings'
import type { AppNotification } from '@shared/types/notification'
import { NotificationKinds } from '@shared/types/notification'
import type { MotrixAppSettings } from '@shared/types/settings'
import { afterEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Electron mock — only exercised by the "uses real Electron Notification by
// default" test; every other test injects createNotification/isSupported
// directly. The module still imports `Notification` from 'electron' at top
// level, so it must resolve to something even when unused.
// ---------------------------------------------------------------------------

const { FakeNotification } = vi.hoisted(() => {
  class FakeNotification {
    static isSupported = vi.fn(() => true)
    show = vi.fn()
    on = vi.fn()
    constructor(public readonly opts: { title: string; body?: string }) {}
  }
  return { FakeNotification }
})

vi.mock('electron', () => ({ Notification: FakeNotification }))

// ---------------------------------------------------------------------------
// Import under test (after mock is registered via vi.hoisted + vi.mock)
// ---------------------------------------------------------------------------

import type {
  OsNotificationHandle,
  OsNotificationMainWindow,
} from './os-bridge'
import { createOsNotificationBridge } from './os-bridge'

// ---------------------------------------------------------------------------
// Fixtures & helpers
// ---------------------------------------------------------------------------

function makeNotification(
  overrides: Partial<AppNotification> = {}
): AppNotification {
  return {
    id: 'n-1',
    sourceKey: 'src-1',
    kind: NotificationKinds.TaskComplete,
    severity: 'info',
    titleKey: 'notification.taskComplete.title',
    titleParams: null,
    bodyKey: null,
    bodyParams: null,
    taskId: null,
    createdAt: 1000,
    readAt: null,
    ...overrides,
  }
}

function makeSettings(
  overrides: Partial<MotrixAppSettings> = {}
): MotrixAppSettings {
  return { ...DEFAULT_APP_SETTINGS, ...overrides }
}

function makeWindow(
  isVisible: boolean,
  isFocused: boolean
): OsNotificationMainWindow {
  return {
    isVisible: vi.fn(() => isVisible),
    isFocused: vi.fn(() => isFocused),
    show: vi.fn(),
    focus: vi.fn(),
  }
}

interface FakeHandle extends OsNotificationHandle {
  opts: { title: string; body?: string }
  click(): void
}

function makeNotificationFactory() {
  const instances: FakeHandle[] = []
  const createNotification = vi.fn(
    (opts: { title: string; body?: string }): OsNotificationHandle => {
      const clickListeners: Array<() => void> = []
      const handle: FakeHandle = {
        opts,
        show: vi.fn(),
        on: vi.fn((event: 'click', listener: () => void) => {
          if (event === 'click') clickListeners.push(listener)
        }),
        click: () => {
          for (const listener of clickListeners) listener()
        },
      }
      instances.push(handle)
      return handle
    }
  )
  return { createNotification, instances }
}

/** Captures the listener the bridge registers via `subscribe`. */
function makeCapturingSubscribe() {
  let captured: ((payload: AppNotification) => void) | null = null
  const subscribe = vi.fn(
    (_channel: EventChannel, listener: (payload: AppNotification) => void) => {
      captured = listener
    }
  )
  return {
    subscribe,
    deliver: (payload: AppNotification) => {
      if (!captured) throw new Error('subscribe was never called')
      captured(payload)
    },
  }
}

// Bare `vi.fn()` with no explicit type argument and no contextual type
// infers as `Mock<Procedure>`, i.e. `(...args: any[]) => any` — assignable to
// pino's overloaded `LogFn` because `any` short-circuits the overload check.
// `ReturnType<typeof vi.fn>` does NOT have this property (it resolves to a
// different, wider overload), so the field type below is deliberately
// inferred through a real function rather than spelled out by hand.
function makeLog() {
  return { warn: vi.fn() }
}

function baseDeps(overrides: {
  window?: OsNotificationMainWindow | null
  settings?: MotrixAppSettings
  createNotification?: ReturnType<
    typeof makeNotificationFactory
  >['createNotification']
  isSupported?: () => boolean
  log?: ReturnType<typeof makeLog>
  navigateToTask?: (taskId: string) => void
  translate?: (key: string, params?: Record<string, string>) => string
}) {
  const { subscribe, deliver } = makeCapturingSubscribe()
  const navigateToTask = overrides.navigateToTask ?? vi.fn()
  const log = overrides.log ?? makeLog()
  const translate = overrides.translate ?? ((key: string) => key)
  const window = overrides.window ?? null
  const settings = overrides.settings ?? makeSettings()

  return {
    deliver,
    log,
    navigateToTask,
    deps: {
      subscribe,
      getMainWindow: () => window,
      getAppSettings: () => settings,
      translate,
      navigateToTask,
      isSupported: overrides.isSupported ?? (() => true),
      createNotification: overrides.createNotification,
      log,
    },
  }
}

// ---------------------------------------------------------------------------
// Full gating matrix: (window state) x (kind) x (toggle on/off)
// ---------------------------------------------------------------------------

const WINDOW_STATES: Array<{
  label: string
  isVisible: boolean
  isFocused: boolean
  foreground: boolean
}> = [
  {
    label: 'visible+focused',
    isVisible: true,
    isFocused: true,
    foreground: true,
  },
  { label: 'hidden', isVisible: false, isFocused: true, foreground: false },
  {
    label: 'visible+unfocused',
    isVisible: true,
    isFocused: false,
    foreground: false,
  },
]

const KIND_CASES: Array<{
  label: string
  kind: string
  settingKey: 'notifyOnComplete' | 'notifyOnError'
}> = [
  {
    label: 'task-complete',
    kind: NotificationKinds.TaskComplete,
    settingKey: 'notifyOnComplete',
  },
  {
    label: 'task-error',
    kind: NotificationKinds.TaskError,
    settingKey: 'notifyOnError',
  },
  {
    label: 'engine-failure',
    kind: NotificationKinds.EngineFailure,
    settingKey: 'notifyOnError',
  },
  {
    label: 'unknown kind',
    kind: 'some-unrecognized-kind',
    settingKey: 'notifyOnError',
  },
]

describe('createOsNotificationBridge — gating matrix', () => {
  for (const windowState of WINDOW_STATES) {
    describe(`window: ${windowState.label}`, () => {
      for (const kindCase of KIND_CASES) {
        describe(`kind: ${kindCase.label}`, () => {
          for (const toggleOn of [true, false]) {
            it(`toggle ${kindCase.settingKey}=${toggleOn}`, () => {
              const { createNotification } = makeNotificationFactory()
              const window = makeWindow(
                windowState.isVisible,
                windowState.isFocused
              )
              const settings = makeSettings({
                [kindCase.settingKey]: toggleOn,
              } as Partial<MotrixAppSettings>)
              const { deps, deliver } = baseDeps({
                window,
                settings,
                createNotification,
              })

              createOsNotificationBridge(deps)
              deliver(makeNotification({ kind: kindCase.kind }))

              const expectSend = !windowState.foreground && toggleOn
              if (expectSend) {
                expect(createNotification).toHaveBeenCalledOnce()
              } else {
                expect(createNotification).not.toHaveBeenCalled()
              }
            })
          }
        })
      }
    })
  }

  it('win == null is treated as non-foreground (sends when toggle on)', () => {
    const { createNotification } = makeNotificationFactory()
    const { deps, deliver } = baseDeps({
      window: null,
      settings: makeSettings({ notifyOnComplete: true }),
      createNotification,
    })

    createOsNotificationBridge(deps)
    deliver(makeNotification({ kind: NotificationKinds.TaskComplete }))

    expect(createNotification).toHaveBeenCalledOnce()
  })

  it('win == null with the toggle off still skips silently', () => {
    const { createNotification } = makeNotificationFactory()
    const { deps, deliver } = baseDeps({
      window: null,
      settings: makeSettings({ notifyOnComplete: false }),
      createNotification,
    })

    createOsNotificationBridge(deps)
    deliver(makeNotification({ kind: NotificationKinds.TaskComplete }))

    expect(createNotification).not.toHaveBeenCalled()
  })
})

describe('createOsNotificationBridge — subscription', () => {
  it('subscribes to Events.NotificationAdded', () => {
    const { createNotification } = makeNotificationFactory()
    const subscribe = vi.fn()
    createOsNotificationBridge({
      subscribe,
      getMainWindow: () => null,
      getAppSettings: () => makeSettings(),
      translate: (key) => key,
      navigateToTask: vi.fn(),
      isSupported: () => true,
      createNotification,
      log: { warn: vi.fn() },
    })

    expect(subscribe).toHaveBeenCalledWith(
      Events.NotificationAdded,
      expect.any(Function)
    )
  })
})

// ---------------------------------------------------------------------------
// isSupported() gate
// ---------------------------------------------------------------------------

describe('createOsNotificationBridge — isSupported gate', () => {
  it('isSupported() === false skips silently even when everything else says send', () => {
    const { createNotification } = makeNotificationFactory()
    const translate = vi.fn((key: string) => key)
    const { deps, deliver } = baseDeps({
      window: null,
      settings: makeSettings({ notifyOnComplete: true }),
      createNotification,
      isSupported: () => false,
      translate,
    })

    createOsNotificationBridge(deps)
    deliver(makeNotification({ kind: NotificationKinds.TaskComplete }))

    expect(createNotification).not.toHaveBeenCalled()
    // Short-circuits before doing any translation work.
    expect(translate).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Body rendering: only when bodyKey is non-null
// ---------------------------------------------------------------------------

describe('createOsNotificationBridge — body rendering', () => {
  it('omits body when bodyKey is null', () => {
    const { createNotification, instances } = makeNotificationFactory()
    const { deps, deliver } = baseDeps({
      window: null,
      settings: makeSettings({ notifyOnComplete: true }),
      createNotification,
      translate: (key) => `T:${key}`,
    })

    createOsNotificationBridge(deps)
    deliver(
      makeNotification({
        kind: NotificationKinds.TaskComplete,
        titleKey: 'notification.taskComplete.title',
        bodyKey: null,
      })
    )

    expect(instances).toHaveLength(1)
    expect(instances[0].opts).toEqual({
      title: 'T:notification.taskComplete.title',
    })
    expect(instances[0].opts.body).toBeUndefined()
  })

  it('includes body when bodyKey is non-null, translated with bodyParams', () => {
    const { createNotification, instances } = makeNotificationFactory()
    const translate = vi.fn((key: string, params?: Record<string, string>) =>
      params ? `T:${key}:${JSON.stringify(params)}` : `T:${key}`
    )
    const { deps, deliver } = baseDeps({
      window: null,
      settings: makeSettings({ notifyOnError: true }),
      createNotification,
      translate,
    })

    createOsNotificationBridge(deps)
    deliver(
      makeNotification({
        kind: NotificationKinds.TaskError,
        titleKey: 'notification.taskError.title',
        titleParams: { name: 'movie.mp4' },
        bodyKey: 'task.error.reason.timeout',
        bodyParams: { seconds: '30' },
      })
    )

    expect(translate).toHaveBeenCalledWith('notification.taskError.title', {
      name: 'movie.mp4',
    })
    expect(translate).toHaveBeenCalledWith('task.error.reason.timeout', {
      seconds: '30',
    })
    expect(instances[0].opts).toEqual({
      title: 'T:notification.taskError.title:{"name":"movie.mp4"}',
      body: 'T:task.error.reason.timeout:{"seconds":"30"}',
    })
  })

  it('translate is called with undefined params when titleParams is null', () => {
    const { createNotification } = makeNotificationFactory()
    const translate = vi.fn((key: string) => key)
    const { deps, deliver } = baseDeps({
      window: null,
      settings: makeSettings({ notifyOnComplete: true }),
      createNotification,
      translate,
    })

    createOsNotificationBridge(deps)
    deliver(
      makeNotification({
        kind: NotificationKinds.TaskComplete,
        titleKey: 'notification.taskComplete.title',
        titleParams: null,
      })
    )

    expect(translate).toHaveBeenCalledWith(
      'notification.taskComplete.title',
      undefined
    )
  })
})

// ---------------------------------------------------------------------------
// Click behavior
// ---------------------------------------------------------------------------

describe('createOsNotificationBridge — click behavior', () => {
  it('click shows and focuses the main window, then navigates when taskId is set', () => {
    const { createNotification, instances } = makeNotificationFactory()
    const window = makeWindow(false, true)
    const navigateToTask = vi.fn()
    const { deps, deliver } = baseDeps({
      window,
      settings: makeSettings({ notifyOnComplete: true }),
      createNotification,
      navigateToTask,
    })

    createOsNotificationBridge(deps)
    deliver(
      makeNotification({ kind: NotificationKinds.TaskComplete, taskId: 't-1' })
    )

    instances[0].click()

    expect(window.show).toHaveBeenCalledOnce()
    expect(window.focus).toHaveBeenCalledOnce()
    expect(navigateToTask).toHaveBeenCalledWith('t-1')
  })

  it('click shows and focuses but does not navigate when taskId is null', () => {
    const { createNotification, instances } = makeNotificationFactory()
    const window = makeWindow(false, true)
    const navigateToTask = vi.fn()
    const { deps, deliver } = baseDeps({
      window,
      settings: makeSettings({ notifyOnComplete: true }),
      createNotification,
      navigateToTask,
    })

    createOsNotificationBridge(deps)
    deliver(
      makeNotification({ kind: NotificationKinds.TaskComplete, taskId: null })
    )

    instances[0].click()

    expect(window.show).toHaveBeenCalledOnce()
    expect(window.focus).toHaveBeenCalledOnce()
    expect(navigateToTask).not.toHaveBeenCalled()
  })

  it('navigateToTask throwing inside the click callback is caught and logged via log.warn, not thrown', () => {
    const { createNotification, instances } = makeNotificationFactory()
    const window = makeWindow(false, true)
    const err = new Error('EventBus listener threw')
    const navigateToTask = vi.fn(() => {
      throw err
    })
    const { deps, deliver, log } = baseDeps({
      window,
      settings: makeSettings({ notifyOnComplete: true }),
      createNotification,
      navigateToTask,
    })

    createOsNotificationBridge(deps)
    deliver(
      makeNotification({ kind: NotificationKinds.TaskComplete, taskId: 't-1' })
    )

    expect(() => instances[0].click()).not.toThrow()
    expect(log.warn).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// Throw isolation: a throwing createNotification is logged, never thrown
// ---------------------------------------------------------------------------

describe('createOsNotificationBridge — throw isolation', () => {
  it('createNotification throwing is caught, logged via log.warn, and not re-thrown', () => {
    const err = new Error('boom')
    const createNotification = vi.fn(() => {
      throw err
    })
    const { deps, deliver, log } = baseDeps({
      window: null,
      settings: makeSettings({ notifyOnComplete: true }),
      createNotification,
    })

    createOsNotificationBridge(deps)

    expect(() =>
      deliver(makeNotification({ kind: NotificationKinds.TaskComplete }))
    ).not.toThrow()
    expect(log.warn).toHaveBeenCalledOnce()
  })

  it('translate throwing is also caught and logged, not thrown', () => {
    const { createNotification } = makeNotificationFactory()
    const translate = vi.fn(() => {
      throw new Error('translate exploded')
    })
    const { deps, deliver, log } = baseDeps({
      window: null,
      settings: makeSettings({ notifyOnComplete: true }),
      createNotification,
      translate,
    })

    createOsNotificationBridge(deps)

    expect(() =>
      deliver(makeNotification({ kind: NotificationKinds.TaskComplete }))
    ).not.toThrow()
    expect(log.warn).toHaveBeenCalledOnce()
    expect(createNotification).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// dispose()
// ---------------------------------------------------------------------------

describe('createOsNotificationBridge — dispose', () => {
  it('after dispose(), a delivered notification no longer calls createNotification', () => {
    const { createNotification } = makeNotificationFactory()
    const { deps, deliver } = baseDeps({
      window: null,
      settings: makeSettings({ notifyOnComplete: true }),
      createNotification,
    })

    const bridge = createOsNotificationBridge(deps)
    bridge.dispose()
    deliver(makeNotification({ kind: NotificationKinds.TaskComplete }))

    expect(createNotification).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Default isSupported/createNotification wire to the real Electron API
// ---------------------------------------------------------------------------

describe('createOsNotificationBridge — Electron defaults', () => {
  // These two bypass baseDeps() entirely and omit isSupported/
  // createNotification from the deps object, so the bridge falls through to
  // its own defaults (`Notification.isSupported()` / `new Notification()`).
  // baseDeps() always supplies both, which is what every other test wants.

  it('uses Notification.isSupported() and `new Notification()` when not overridden', () => {
    FakeNotification.isSupported.mockReturnValue(true)
    const { subscribe, deliver } = makeCapturingSubscribe()

    createOsNotificationBridge({
      subscribe,
      getMainWindow: () => null,
      getAppSettings: () => makeSettings({ notifyOnComplete: true }),
      translate: (key) => key,
      navigateToTask: vi.fn(),
      log: { warn: vi.fn() },
    })
    deliver(
      makeNotification({
        kind: NotificationKinds.TaskComplete,
        titleKey: 'notification.taskComplete.title',
      })
    )

    expect(FakeNotification.isSupported).toHaveBeenCalled()
  })

  it('Notification.isSupported() === false falls through the same skip path', () => {
    FakeNotification.isSupported.mockReturnValue(false)
    const { subscribe, deliver } = makeCapturingSubscribe()

    createOsNotificationBridge({
      subscribe,
      getMainWindow: () => null,
      getAppSettings: () => makeSettings({ notifyOnComplete: true }),
      translate: (key) => key,
      navigateToTask: vi.fn(),
      log: { warn: vi.fn() },
    })
    expect(() =>
      deliver(makeNotification({ kind: NotificationKinds.TaskComplete }))
    ).not.toThrow()

    FakeNotification.isSupported.mockReturnValue(true)
  })
})

// ---------------------------------------------------------------------------
// Real i18n: translate reflects a runtime language switch
// ---------------------------------------------------------------------------

describe('createOsNotificationBridge — real i18n language switch', () => {
  afterEach(async () => {
    const { i18n } = await import('../lib/i18n')
    await i18n.changeLanguage('en-US')
  })

  it('a later notification translates through the newly switched language', async () => {
    const { i18n } = await import('../lib/i18n')
    const translate = i18n.t.bind(i18n)
    const { createNotification, instances } = makeNotificationFactory()
    const { deps, deliver } = baseDeps({
      window: null,
      settings: makeSettings({ notifyOnComplete: true }),
      createNotification,
      translate,
    })

    createOsNotificationBridge(deps)

    deliver(
      makeNotification({
        id: 'n-en',
        kind: NotificationKinds.TaskComplete,
        titleKey: 'notification.taskComplete.title',
        titleParams: { name: 'movie.mp4' },
      })
    )
    expect(instances[0].opts.title).toBe('movie.mp4 finished downloading')

    await i18n.changeLanguage('zh-CN')

    deliver(
      makeNotification({
        id: 'n-zh',
        kind: NotificationKinds.TaskComplete,
        titleKey: 'notification.taskComplete.title',
        titleParams: { name: 'movie.mp4' },
      })
    )
    expect(instances[1].opts.title).toBe('movie.mp4 下载完成')
  })
})
