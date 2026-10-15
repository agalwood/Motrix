import { useTranslation } from 'react-i18next'
import {
  CompactContentCard,
  CompactSectionToolbar,
} from '@/popup/CompactPopupLayout'
import { ConnectionStatusPanel } from '@/popup/ConnectionStatusPanel'
import type { PopupState } from '@/popup/usePopupState'

export function ConnectionPanel({
  title,
  state,
  onReconnect,
  onShowPairing,
  onNewTask,
  actionLabel,
}: {
  title: string
  state: PopupState
  onReconnect: () => void
  onShowPairing?: () => void
  onNewTask?: () => void
  actionLabel?: string
}): React.ReactElement {
  const { t } = useTranslation()

  return (
    <section aria-label={title} className="flex h-full min-h-0 flex-col">
      <CompactSectionToolbar title={title || t('popup.tasks.title')} />
      <CompactContentCard className="overflow-hidden [overflow-wrap:anywhere]">
        <ConnectionStatusPanel
          state={state}
          onReconnect={onReconnect}
          {...(onNewTask ? { onNewTask } : {})}
          {...(onShowPairing ? { onShowPairing } : {})}
          {...(actionLabel ? { actionLabel } : {})}
        />
      </CompactContentCard>
    </section>
  )
}
