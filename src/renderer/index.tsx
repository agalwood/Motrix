import { LanguageSync } from '@renderer/components/language-sync'
import { LocaleDirectionProvider } from '@renderer/components/locale-direction-provider'
import { OperatorUnlockGate } from '@renderer/components/operator-unlock-gate'
import { ThemeSync } from '@renderer/components/theme-sync'
import {
  bootstrapRendererLocale,
  type RendererWindowId,
} from '@renderer/lib/bootstrap-locale'
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

function Root({
  children,
  forcedTheme,
  syncSettings = true,
}: {
  children: ReactNode
  forcedTheme?: string
  syncSettings?: boolean
}) {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      forcedTheme={forcedTheme}
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
      <Root syncSettings={false} forcedTheme="light">
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
