import { PanelShell } from '@renderer/components/desktop-kit/panel/panel-shell'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router'
import { findCard, SETTINGS_CARDS } from './card-registry'
import { SettingsCard } from './cards/settings-card'

export function SettingsPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { cardId } = useParams<{ cardId: string }>()
  const activeCard = findCard(cardId)
  const columnsPerRow = 3
  const lastRowStartIndex =
    Math.floor((SETTINGS_CARDS.length - 1) / columnsPerRow) * columnsPerRow

  const closeDialog = () => navigate('/settings')

  return (
    <PanelShell title={t('settings.title')}>
      <div className="grid h-full grid-cols-2 items-stretch border-t-[0.5px] px-6 py-4 min-[914px]:grid-cols-3">
        {SETTINGS_CARDS.map((card, index) => (
          <SettingsCard
            key={card.id}
            icon={card.icon}
            labelKey={card.labelKey}
            descKey={card.descKey}
            onClick={() => navigate(`/settings/${card.id}`)}
            className={
              index < lastRowStartIndex ? 'border-b-[0.5px] border-border' : ''
            }
          />
        ))}
      </div>
      {activeCard && (
        <activeCard.Dialog
          open
          onClose={closeDialog}
          labelKey={activeCard.labelKey}
          descKey={activeCard.descKey}
        />
      )}
    </PanelShell>
  )
}
