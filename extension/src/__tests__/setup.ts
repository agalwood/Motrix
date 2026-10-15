// Install the Node RAL for the jsdom (Node) test process so an MdxpConnection
// can process messages (vscode-jsonrpc v9 requires a platform RAL). The real
// extension installs the browser RAL at SW startup (see background/service-worker.ts);
// here the test process is Node, so the Node RAL is the correct one.
import '@motrix/mdxp/node'
import { cleanup } from '@testing-library/react'
import { afterEach, beforeEach, vi } from 'vitest'

const sessionStorageState = new Map<string, unknown>()

// Minimal chrome.runtime / chrome.storage stubs. Individual tests override
// these per-test when they need fuller behavior.
const chromeStub = {
  runtime: {
    id: 'test-extension-id',
    connectNative: vi.fn(),
    sendNativeMessage: vi.fn(),
    getManifest: vi.fn(() => ({ version: '0.1.14', permissions: [] })),
    openOptionsPage: vi.fn(async () => undefined),
    // `computeVerifiedOrigin` (mbp1/verified-origin.ts) calls this on every
    // MBP1 local-endpoint connect attempt. The literal string is arbitrary —
    // `verified-origin.test.ts` overrides `getURL` with its own fixtures per
    // test and drives the real global `URL` against them (no `URL` stub at
    // all; see that file's own header), which sidesteps jsdom's `URL.origin`
    // returning the opaque string "null" for chrome-extension: URLs.
    getURL: vi.fn(
      (path: string) => `chrome-extension://test-extension-id${path}`
    ),
    onMessage: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
    lastError: undefined as undefined | { message: string },
  },
  storage: {
    local: {
      get: vi.fn(async (_keys: string | string[] | null) => ({})),
      set: vi.fn(async (_items: Record<string, unknown>) => undefined),
      remove: vi.fn(async (_keys: string | string[]) => undefined),
    },
    session: {
      get: vi.fn(async (key: string) => ({
        [key]: sessionStorageState.get(key),
      })),
      set: vi.fn(async (items: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(items)) {
          sessionStorageState.set(key, value)
        }
      }),
      remove: vi.fn(async (key: string) => {
        sessionStorageState.delete(key)
      }),
    },
    onChanged: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
  },
  tabs: {
    // Default stub: returns an empty array (no active tab). Tests override as needed.
    query: vi.fn(async () => []),
  },
  notifications: {
    create: vi.fn(async () => 'test-notification'),
  },
  // Default stub: behaves like the real, always-present API (mbp1/
  // permission-gate.ts's own tests mock the API-absent branch directly by
  // deleting this property, not by overriding these return values).
  permissions: {
    contains: vi.fn(async () => true),
    request: vi.fn(async () => true),
  },
  alarms: {
    create: vi.fn(),
    onAlarm: { addListener: vi.fn() },
  },
  i18n: {
    getUILanguage: vi.fn(() => 'en-US'),
  },
}

;(globalThis as unknown as { chrome: typeof chromeStub }).chrome = chromeStub
;(globalThis as unknown as { browser: typeof chromeStub }).browser = chromeStub

// Headless UI primitives (Select, Switch, …) call DOM APIs jsdom does not
// implement. Polyfill them once so component tests can drive these widgets.
if (typeof Element !== 'undefined') {
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => undefined
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => undefined
  }
  if (!Element.prototype.getAnimations) {
    Element.prototype.getAnimations = () => []
  }
}
// jsdom deliberately has no layout engine and therefore omits
// `document.elementFromPoint`. input-otp uses it after focus only to detect a
// password-manager badge. In a layout-less document the closest stable hit is
// the active control's visual container; returning that matches the library's
// "no badge" branch while leaving all input/selection behaviour under test.
if (typeof document !== 'undefined' && !document.elementFromPoint) {
  document.elementFromPoint = () =>
    document.activeElement?.closest('[data-input-otp-container]') ?? null
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
}

beforeEach(() => {
  sessionStorageState.clear()
  vi.clearAllMocks()
})

// testing-library/react does not auto-cleanup in vitest the way it does
// in jest; without this, mounted components accumulate in document.body
// and queries fail with "Found multiple elements".
afterEach(() => {
  cleanup()
})
