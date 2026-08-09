import { Button } from '@renderer/components/ui/button'
import { Card } from '@renderer/components/ui/card'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip'
import { usePlatformServices } from '@renderer/platform/services'
import { EXTERNAL_URLS } from '@shared/external-urls'
import { ShieldCheck, Store } from 'lucide-react'
import { useTranslation } from 'react-i18next'

interface PluginGuidanceProps {
  hasUserManagedPlugin: boolean
}

export function PluginGuidance({ hasUserManagedPlugin }: PluginGuidanceProps) {
  const { t } = useTranslation()
  const services = usePlatformServices()

  if (hasUserManagedPlugin) {
    return (
      <div
        data-testid="plugin-safety-reminder"
        className="flex items-start gap-2 rounded-lg bg-muted/40 px-3 py-2.5"
      >
        <ShieldCheck
          aria-hidden
          className="mt-0.5 size-4 shrink-0 text-muted-foreground"
        />
        <p className="text-sm leading-5 text-muted-foreground">
          {t('plugins.help.guidance.ongoing')}
        </p>
      </div>
    )
  }

  // Guidance only — the page header owns the one persistent "Add plugin"
  // entry point, so the first-use card deliberately carries no CTA.
  return (
    <Card
      data-testid="plugin-first-use-guide"
      className="gap-3 rounded-lg p-4 shadow-none"
    >
      <div className="min-w-0">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <ShieldCheck
              aria-hidden
              className="size-4 shrink-0 text-muted-foreground"
            />
            <h2 className="text-sm font-medium">
              {t('plugins.help.guidance.firstUse.title')}
            </h2>
          </div>
          {/* Low-key discovery entry in the card's top-right corner —
              icon-only so it never competes with the header's primary
              "Add plugin" action; the browse copy lives in the tooltip. */}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="-mr-1.5 -mt-1.5 shrink-0 text-muted-foreground"
                  onClick={() =>
                    services.openExternal(EXTERNAL_URLS.motrix.plugins)
                  }
                  aria-label={t('plugins.help.guidance.firstUse.browse')}
                  data-testid="plugin-guide-browse-link"
                >
                  <Store aria-hidden className="size-4" />
                </Button>
              }
            />
            <TooltipContent side="left">
              {t('plugins.help.guidance.firstUse.browse')}
            </TooltipContent>
          </Tooltip>
        </div>
        <p className="mt-2 text-sm leading-5 text-muted-foreground">
          {t('plugins.help.guidance.firstUse.body')}
        </p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          {t('plugins.help.guidance.firstUse.safety')}
        </p>
      </div>
    </Card>
  )
}
