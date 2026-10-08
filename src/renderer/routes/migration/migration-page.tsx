import { PanelShell } from '@renderer/components/desktop-kit/panel/panel-shell'
import { Button } from '@renderer/components/ui/button'
import { LegacyImportDialog } from '@renderer/features/legacy-import/legacy-import-dialog'
import { ALL_DOWNLOADS_ROUTE } from '@shared/lib/task-navigation'
import { Component, type ReactNode, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate } from 'react-router'

class MigrationBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

/** The main shell retains this instance so navigation never drops an import run/draft. */
export function MigrationPage({ active }: { active: boolean }) {
  const { t } = useTranslation()
  const location = useLocation()
  const navigate = useNavigate()
  const [started, setStarted] = useState(active)
  const [invitation, setInvitation] = useState(
    active && new URLSearchParams(location.search).get('invitation') === '1'
  )
  useEffect(() => {
    if (active) {
      setStarted(true)
      if (new URLSearchParams(location.search).get('invitation') === '1')
        setInvitation(true)
    }
  }, [active, location.search])
  return (
    <MigrationBoundary
      fallback={
        <PanelShell title={t('legacyImport.page.assistantTitle')}>
          <div role="alert" className="space-y-4 p-6">
            <p className="text-sm text-muted-foreground">
              {t('legacyImport.errors.pageUnavailable')}
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => navigate(ALL_DOWNLOADS_ROUTE)}
            >
              {t('legacyImport.viewTasks')}
            </Button>
          </div>
        </PanelShell>
      }
    >
      <LegacyImportDialog
        open={started}
        active={active}
        presentation="page"
        invitation={invitation}
        onClose={() => {
          setInvitation(false)
          navigate('/')
        }}
        onViewTasks={() => {
          setInvitation(false)
          setStarted(false)
          navigate(ALL_DOWNLOADS_ROUTE)
        }}
      />
    </MigrationBoundary>
  )
}
