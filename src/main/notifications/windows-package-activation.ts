import type { Logger } from '@core/logger'
import windowsPackageConfig from '@shared/config/windows-package.json'
import { z } from 'zod'

// Electron's default body-click XML has no launch arguments. Accept the empty
// string, but never interpret these OS-supplied arguments as a URL, path or task.
const bodyActivationSchema = z.object({
  type: z.literal('click'),
  arguments: z.string().max(4096),
})

interface WindowsPackageActivationDeps {
  isWindowsPackage: boolean
  setToastActivatorCLSID: (clsid: string) => void
  handleActivation: (callback: (details: unknown) => void) => void
  isSupported: () => boolean
  openMainWindow: () => void
  log: Pick<Logger, 'warn'>
}

/** Package-only toast activation; initialization and navigation stay separate. */
export function createWindowsPackageActivation(
  deps: WindowsPackageActivationDeps
) {
  let disposed = false
  let ready = false
  let presenterInitialized = false
  let pending = false
  let liveClaimed = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const accepting = () => deps.isWindowsPackage && !disposed

  function scheduleTurn(): void {
    if (timer !== null) return
    timer = setTimeout(() => {
      timer = null
      const shouldOpen = accepting() && ready && pending && !liveClaimed
      liveClaimed = false
      if (!shouldOpen) return
      pending = false
      try {
        deps.openMainWindow()
      } catch (err) {
        deps.log.warn({ err }, 'windows-package notification activation failed')
      }
    }, 0)
  }

  function handleLiveClick(): void {
    if (!accepting() || liveClaimed) return
    // One flag bounds the queue even if many activations arrive during startup.
    pending = true
    if (ready) scheduleTurn()
  }

  if (deps.isWindowsPackage) {
    // Set the manifest's stable CLSID before any code initializes the presenter.
    // Electron 44.4.3 otherwise generates a new CLSID on every process launch.
    deps.setToastActivatorCLSID(windowsPackageConfig.toastActivatorClsid)
    deps.handleActivation((details) => {
      if (!accepting() || !bodyActivationSchema.safeParse(details).success) {
        return
      }
      handleLiveClick()
    })
  }

  return {
    initializePresenter(): void {
      if (!accepting() || presenterInitialized) return
      presenterInitialized = true
      // handleActivation only stores a callback. In Electron 44.4.3,
      // Notification.isSupported creates the presenter and registers its COM
      // activator; the packaged branch skips shortcut/registry registration.
      // Call after app.ready, even if the user has disabled new notifications.
      try {
        if (!deps.isSupported()) {
          deps.log.warn('windows-package notifications are unavailable')
        }
      } catch (err) {
        deps.log.warn(
          { err },
          'windows-package notification presenter initialization failed'
        )
      }
    },
    flush(): void {
      if (!accepting()) return
      ready = true
      if (pending) scheduleTurn()
    },
    handleLiveClick,
    claimLiveClick(): void {
      if (!accepting()) return
      // Electron 44.4.3's COM handler calls the global callback before the
      // instance event in the same dispatch. Let the existing task/reveal
      // handler win over that turn's generic fallback. This does not promise
      // deduplication across separate OS dispatches.
      pending = false
      liveClaimed = true
      if (timer !== null) clearTimeout(timer)
      timer = null
      scheduleTurn()
    },
    dispose(): void {
      disposed = true
      pending = false
      liveClaimed = false
      if (timer !== null) clearTimeout(timer)
      timer = null
    },
  }
}
