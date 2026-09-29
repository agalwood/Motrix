import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import type { TaskTrackerPlan } from '@shared/schemas/task-tracker'
import { useTranslation } from 'react-i18next'

export function TaskTrackerDialog({
  plan,
  open,
  onOpenChange,
  onApply,
  busy,
}: {
  plan: TaskTrackerPlan | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onApply: () => void
  busy: boolean
}) {
  const { t } = useTranslation()
  const key = 'panel.downloads.inspector.trackers.preview'
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!busy) onOpenChange(value)
      }}
    >
      {/* The inspector drawer is non-modal, so this nested dialog needs its own backdrop. */}
      <DialogContent forceRenderOverlay>
        <DialogHeader>
          <DialogTitle>{t(`${key}.title`)}</DialogTitle>
          <DialogDescription>{t(`${key}.description`)}</DialogDescription>
        </DialogHeader>
        {plan && (
          <div className="space-y-3 text-xs">
            {plan.requiresPause && (
              <p className="text-muted-foreground">{t(`${key}.reconnect`)}</p>
            )}
            <div className="max-h-64 overflow-auto rounded-lg border border-border divide-y divide-border">
              {(['added', 'removed'] as const).map((kind) => (
                <section key={kind} className="p-3 space-y-2">
                  <h3 className="font-medium">
                    {t(`${key}.${kind}`, { count: plan[kind].length })}
                  </h3>
                  {plan[kind].length > 0 && (
                    <ul className="space-y-1 text-muted-foreground">
                      {plan[kind].map((url) => (
                        <li className="break-all select-text" key={url}>
                          {url}
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              ))}
            </div>
            <p className="text-muted-foreground">
              {t(`${key}.retained`, { count: plan.retained.length })}
            </p>
            {plan.excluded.length > 0 && (
              <p className="text-muted-foreground">
                {t(`${key}.excluded`, { count: plan.excluded.length })}
              </p>
            )}
          </div>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            {t('common.cancel')}
          </Button>
          <Button
            size="sm"
            disabled={
              busy || !plan || plan.added.length + plan.removed.length === 0
            }
            onClick={onApply}
          >
            {t(`${key}.apply`)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
