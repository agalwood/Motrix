import { Button } from '@renderer/components/ui/button'
import { applyRendererLocale } from '@renderer/lib/i18n'
import { NasDialog } from '@renderer/routes/settings/cards/nas-dialog'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

export function NasStorageRecovery({ roots }: { roots: readonly string[] }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  useEffect(() => {
    void applyRendererLocale(navigator.language)
  }, [])
  return (
    <main className="flex min-h-svh items-center justify-center bg-background p-6 text-foreground">
      <div className="w-full max-w-lg space-y-4">
        <h1 className="text-lg font-semibold">
          {t('settings.nas.storageUnavailable')}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t('settings.nas.storageRecoveryHint')}
        </p>
        <ul className="max-h-48 overflow-auto rounded border p-3 font-mono text-xs">
          {roots.map((root) => (
            <li className="select-text break-all" key={root}>
              {root}
            </li>
          ))}
        </ul>
        <Button size="sm" onClick={() => setOpen(true)}>
          {t('settings.nas.roots')}
        </Button>
        {open && (
          <NasDialog
            open
            onClose={() => setOpen(false)}
            labelKey="settings.nas.roots"
            descKey="settings.nas.rootsHint"
          />
        )}
      </div>
    </main>
  )
}
