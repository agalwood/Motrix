import { LanguageSync } from '@renderer/components/language-sync'
import { LocaleDirectionProvider } from '@renderer/components/locale-direction-provider'
import { OperatorUnlockGate } from '@renderer/components/operator-unlock-gate'
import { ThemeSync } from '@renderer/components/theme-sync'
import {
  bootstrapRendererLocale,
  type RendererWindowId,
} from '@renderer/lib/bootstrap-locale'
import { applyInitialRendererTheme } from '@renderer/lib/initial-theme'
import { transport } from '@renderer/lib/transport'
import { ThemeProvider } from 'next-themes'
import { lazy, type ReactNode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router'
import { router } from './router'
import './lib/i18n'
import './styles/globals.css'

const AddTaskWindow = lazy(() =>
  import('./windows/add-task-window').then((m) => ({
    default: m.AddTaskWindow,
  }))
)

const OnboardingWindow = lazy(() =>
  import('./windows/onboarding-window').then((module) => ({
    default: module.OnboardingWindow,
  }))
)

const container = document.getElementById('root')
if (!container) {
  throw new Error('Root element not found')
}

const params = new URLSearchParams(window.location.search)
const windowParam = params.get('w')
const windowId: RendererWindowId =
  windowParam === 'add-task'
    ? 'add-task'
    : windowParam === 'onboarding'
      ? 'onboarding'
      : 'main'

document.documentElement.classList.add(`platform-${transport.platform}`)
document.documentElement.classList.add(`window-${windowId}`)
// Apply the resolved class before the locale IPC and React mount. The native
// BrowserWindow background uses the same Electron nativeTheme value, so the
// compositor and renderer agree from the first visible frame.
applyInitialRendererTheme()

function Root({
  children,
  syncSettings = true,
}: {
  children: ReactNode
  syncSettings?: boolean
}) {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      <LocaleDirectionProvider>
        {syncSettings && <ThemeSync />}
        <LanguageSync windowId={windowId} />
        {children}
      </LocaleDirectionProvider>
    </ThemeProvider>
  )
}

async function startRenderer(rootContainer: HTMLElement): Promise<void> {
  await bootstrapRendererLocale(windowId)
  const root = createRoot(rootContainer)

  if (windowId === 'add-task') {
    root.render(
      <Root>
        <Suspense>
          <AddTaskWindow />
        </Suspense>
      </Root>
    )
  } else if (windowId === 'onboarding') {
    root.render(
      <Root syncSettings={false}>
        <Suspense>
          <OnboardingWindow />
        </Suspense>
      </Root>
    )
  } else {
    root.render(
      <Root>
        <OperatorUnlockGate>
          <RouterProvider router={router} />
        </OperatorUnlockGate>
      </Root>
    )
  }
}

void startRenderer(container)
