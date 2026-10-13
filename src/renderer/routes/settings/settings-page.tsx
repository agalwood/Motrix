import { PanelShell } from '@renderer/components/desktop-kit/panel/panel-shell'
import { cn } from '@renderer/lib/utils'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate, useParams } from 'react-router'
import { findCard, SETTINGS_CARDS } from './card-registry'
import { SettingsCard } from './cards/settings-card'

export function SettingsPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const location = useLocation()
  const visible = /^\/settings(?:\/|$)/.test(location.pathname)
  const { cardId } = useParams<{ cardId: string }>()
  const activeCard = findCard(cardId)
  const lastRowStart = (columns: number) =>
    Math.floor((SETTINGS_CARDS.length - 1) / columns) * columns

  const closeDialog = () => navigate('/settings')

  return (
    <PanelShell
      title={t('settings.title')}
      contentClassName="@container/settings min-w-0"
    >
      <div
        data-slot="settings-grid"
        className="grid min-h-0 flex-1 grid-cols-1 content-start items-stretch overflow-y-auto border-t-[0.5px] px-2 py-2 @min-[400px]/settings:grid-cols-2 @min-[400px]/settings:px-6 @min-[400px]/settings:py-4 @min-[600px]/settings:grid-cols-3"
      >
        {SETTINGS_CARDS.map((card, index) => (
          <SettingsCard
            key={card.id}
            icon={card.icon}
            labelKey={card.labelKey}
            descKey={card.descKey}
            onClick={() => navigate(`/settings/${card.id}`)}
            className={cn(
              'border-border',
              index < lastRowStart(1) && 'border-b-[0.5px]',
              index >= lastRowStart(2) && '@min-[400px]/settings:border-b-0',
              index < lastRowStart(3)
                ? '@min-[600px]/settings:border-b-[0.5px]'
                : '@min-[600px]/settings:border-b-0'
            )}
          />
        ))}
      </div>
      {activeCard && (
        <activeCard.Dialog
          open={visible}
          onClose={closeDialog}
          labelKey={activeCard.labelKey}
          descKey={activeCard.descKey}
        />
      )}
    </PanelShell>
  )
}
