import { useIpcEvent } from '@renderer/hooks/use-ipc-event'
import { transport } from '@renderer/lib/transport'
import { cn } from '@renderer/lib/utils'
import { DESKTOP_WINDOW_CHROME_HEIGHT } from '@shared/constants/window-chrome'
import { Commands } from '@shared/protocol/commands'
import {
  Events,
  type WindowMaximizedChangedPayload,
} from '@shared/protocol/events'
import type React from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

type CaptionIconName = 'close' | 'maximize' | 'minimize' | 'restore'

export function WindowChromeCaptionIcon({ name }: { name: CaptionIconName }) {
  return (
    <svg
      aria-hidden
      className="size-2.5"
      data-caption-icon={name}
      viewBox="0 0 10 10"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {name === 'minimize' && <path d="M0 5h10v1H0z" fill="currentColor" />}
      {name === 'maximize' && (
        <rect
          x="0.5"
          y="0.5"
          width="9"
          height="9"
          rx="1.5"
          stroke="currentColor"
        />
      )}
      {name === 'restore' && (
        <>
          <path
            d="M2.5 2V1.5a1 1 0 0 1 1-1h4a2 2 0 0 1 2 2v4a1 1 0 0 1-1 1H8"
            stroke="currentColor"
          />
          <rect
            x="0.5"
            y="2.5"
            width="7"
            height="7"
            rx="1"
            stroke="currentColor"
          />
        </>
      )}
      {name === 'close' && (
        <path
          d="m0.5 0.5 9 9m0-9-9 9"
          stroke="currentColor"
          strokeLinecap="round"
        />
      )}
    </svg>
  )
}

function DesktopWindowControls({
  maximizable,
  separateFromActions,
}: {
  maximizable: boolean
  separateFromActions: boolean
}) {
  const { t } = useTranslation()
  const [maximized, setMaximized] = useState(false)
  useIpcEvent(Events.WindowMaximizedChanged, (...args) => {
    const payload = args[0] as WindowMaximizedChangedPayload | undefined
    if (typeof payload?.maximized === 'boolean') {
      setMaximized(payload.maximized)
    }
  })

  const minimize = () => {
    void transport.invoke(Commands.MinimizeCurrentWindow)
  }
  const toggleMaximize = () => {
    void transport.invoke(Commands.ToggleMaximizeCurrentWindow)
  }
  const close = () => {
    void transport.invoke(Commands.CloseCurrentWindow)
  }

  const buttonClassName =
    'app-no-drag flex size-7 shrink-0 items-center justify-center rounded-md border-0 bg-transparent text-foreground outline-none transition-colors [&>svg]:opacity-65 hover:[&>svg]:opacity-90 focus-visible:[&>svg]:opacity-90 focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-30'
  const standardButtonClassName = cn(
    buttonClassName,
    'hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50'
  )
  const maximizeLabel = maximized ? t('chrome.restore') : t('chrome.maximize')

  return (
    <div
      data-slot="desktop-window-controls"
      className={cn(
        'flex shrink-0 items-center gap-2 pe-3.5 pt-3.5',
        separateFromActions && 'ms-4'
      )}
    >
      <button
        type="button"
        className={standardButtonClassName}
        onClick={minimize}
        aria-label={t('chrome.minimize')}
        title={t('chrome.minimize')}
      >
        <WindowChromeCaptionIcon name="minimize" />
      </button>
      <button
        type="button"
        className={standardButtonClassName}
        disabled={!maximizable}
        onClick={toggleMaximize}
        aria-label={maximizeLabel}
        title={maximizeLabel}
      >
        <WindowChromeCaptionIcon name={maximized ? 'restore' : 'maximize'} />
      </button>
      <button
        type="button"
        className={cn(
          buttonClassName,
          'hover:bg-destructive hover:text-white hover:[&>svg]:opacity-100 dark:hover:bg-destructive/80'
        )}
        onClick={close}
        aria-label={t('chrome.close')}
        title={t('chrome.close')}
      >
        <WindowChromeCaptionIcon name="close" />
      </button>
    </div>
  )
}

interface WindowChromeProps {
  actionsPosition?: 'start' | 'end'
  compact?: boolean
  maximizable?: boolean
  previewDesktopControls?: boolean
  title?: string
  variant?: 'overlay' | 'titled'
  leading?: React.ReactNode
  children?: React.ReactNode
}

export function shouldShowDesktopWindowControls(
  platform: NodeJS.Platform | 'web',
  previewMacMenu: boolean
): boolean {
  return (
    platform === 'linux' ||
    platform === 'win32' ||
    (platform === 'darwin' && previewMacMenu)
  )
}

export function WindowChrome({
  actionsPosition = 'start',
  compact: _compact,
  maximizable = true,
  previewDesktopControls = false,
  title,
  variant = 'titled',
  leading,
  children,
}: WindowChromeProps) {
  const platform = transport.platform
  const showDesktopControls = shouldShowDesktopWindowControls(
    platform,
    previewDesktopControls
  )
  const isOverlay = variant === 'overlay'
  const isMac = platform === 'darwin'
  const showTrafficLight =
    __MOTRIX_TARGET__ === 'electron' && isMac && !previewDesktopControls
  const offsetStartActionsForDesktopMenu =
    showDesktopControls && leading != null && actionsPosition === 'start'

  const containerStyle: React.CSSProperties = {
    height: DESKTOP_WINDOW_CHROME_HEIGHT,
    display: 'flex',
    alignItems: 'center',
    paddingLeft: showTrafficLight ? 94 : undefined,
    paddingInlineStart: showTrafficLight ? undefined : 12,
    paddingInlineEnd: showDesktopControls ? 0 : 20,
    flexShrink: 0,
    userSelect: 'none',
    ...(isOverlay && {
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      zIndex: 30,
      background: 'transparent',
    }),
  } as React.CSSProperties

  const actionSlot = (
    <div
      data-slot="window-chrome-actions"
      className={cn(
        'app-no-drag relative z-[60] flex shrink-0 items-center gap-2 pt-3.5 empty:hidden',
        offsetStartActionsForDesktopMenu && 'ms-1'
      )}
    >
      {children}
    </div>
  )

  return (
    <div className="window-chrome app-drag" style={containerStyle}>
      {!isOverlay && title && (
        <div className="pt-[14px] text-[13px] font-[600]">{title}</div>
      )}
      {leading && (
        <div
          data-slot="window-chrome-leading"
          className="app-no-drag relative z-[60] me-1.5 flex shrink-0 items-center pt-3.5 empty:hidden"
        >
          {leading}
        </div>
      )}
      {actionsPosition === 'start' && actionSlot}
      <div
        aria-hidden
        data-slot="window-chrome-drag-region"
        className="min-w-16 flex-1"
      />
      {actionsPosition === 'end' && actionSlot}
      {showDesktopControls && (
        <DesktopWindowControls
          maximizable={maximizable}
          separateFromActions={actionsPosition === 'end'}
        />
      )}
    </div>
  )
}
