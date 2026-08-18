import { transport } from '@renderer/lib/transport'
import { cn } from '@renderer/lib/utils'
import { Commands } from '@shared/protocol/commands'
import type React from 'react'
import { useTranslation } from 'react-i18next'

function LinuxWindowControls({ pushToEnd }: { pushToEnd: boolean }) {
  const { t } = useTranslation()
  const minimize = () => {
    void transport.invoke(Commands.MinimizeCurrentWindow)
  }
  const close = () => {
    void transport.invoke(Commands.CloseCurrentWindow)
  }

  return (
    <div
      className={cn('window-controls app-no-drag', pushToEnd && 'ml-auto')}
      style={{ display: 'flex', gap: 8 }}
    >
      <button
        type="button"
        onClick={minimize}
        style={controlButtonStyle}
        aria-label={t('chrome.minimize')}
      >
        &#x2013;
      </button>
      <button
        type="button"
        onClick={close}
        style={controlButtonStyle}
        aria-label={t('chrome.close')}
      >
        &#x2715;
      </button>
    </div>
  )
}

const controlButtonStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'var(--color-foreground)',
  cursor: 'pointer',
  fontSize: 14,
  padding: '4px 8px',
  borderRadius: 4,
  lineHeight: 1,
}

interface WindowChromeProps {
  actionsPosition?: 'start' | 'end'
  compact?: boolean
  title?: string
  variant?: 'overlay' | 'titled'
  leading?: React.ReactNode
  children?: React.ReactNode
}

export function WindowChrome({
  actionsPosition = 'start',
  compact: _compact,
  title,
  variant = 'titled',
  leading,
  children,
}: WindowChromeProps) {
  const platform = transport.platform
  const height = 40
  const showLinuxControls = platform === 'linux'
  const isOverlay = variant === 'overlay'
  const isMac = platform === 'darwin'
  const showTrafficLight =
    __MOTRIX_TARGET__ === 'electron' && isMac && !__MOTRIX_PREVIEW_MAC_MENU__

  const containerStyle: React.CSSProperties = {
    height,
    display: 'flex',
    alignItems: 'center',
    paddingLeft: showTrafficLight ? 93 : 12,
    paddingRight: platform === 'win32' ? 148 : 20,
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

  return (
    <div className="window-chrome app-drag" style={containerStyle}>
      {!isOverlay && title && (
        <div className="text-[13px] font-[600] pt-[14px]">{title}</div>
      )}
      {leading && (
        <div
          data-slot="window-chrome-leading"
          className="app-no-drag relative z-[60] mr-1.5 flex shrink-0 items-center pt-3.5 empty:hidden"
        >
          {leading}
        </div>
      )}
      <div
        data-slot="window-chrome-actions"
        className={cn(
          'app-no-drag relative z-[60] flex shrink-0 items-center gap-2',
          actionsPosition === 'end' && 'ml-auto'
        )}
      >
        {children}
      </div>
      {showLinuxControls && (
        <LinuxWindowControls pushToEnd={actionsPosition === 'start'} />
      )}
    </div>
  )
}
