import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { EXTERNAL_URLS } from '@shared/external-urls'
import { useTranslation } from 'react-i18next'
import { AppUpdateSection, shouldShowAppUpdate } from './app-update-section'
import { AutomaticUpdateSetting } from './automatic-update-setting'
import type { SettingsCardDialogProps } from './card-types'

const appIconUrl = `${import.meta.env.BASE_URL}app-icon.png`

interface CompactLinkProps {
  href: string
  title: string
}

function CompactLink({ href, title }: CompactLinkProps) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="rounded-md px-2 py-1 text-xs font-medium text-muted-foreground outline-none transition-[color,background-color] hover:bg-accent/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      {title}
    </a>
  )
}

export function AboutDialog({
  open,
  onClose,
  labelKey,
  descKey,
}: SettingsCardDialogProps) {
  const { t } = useTranslation()
  const metadata = __MOTRIX_APP_METADATA__
  const showUpdates = shouldShowAppUpdate(__MOTRIX_TARGET__)

  return (
    <Dialog open={open} onOpenChange={(value) => !value && onClose()}>
      <DialogContent
        className="flex max-h-[calc(100svh-2rem)] flex-col gap-0 overflow-hidden rounded-2xl border-border/70 bg-background/95 p-0 shadow-2xl backdrop-blur-xl sm:max-w-[700px]"
        initialFocus={false}
        showCloseButton={false}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{t(labelKey)}</DialogTitle>
          <DialogDescription>{t(descKey)}</DialogDescription>
        </DialogHeader>

        <section
          className="shrink-0 border-b border-border/70 bg-muted/25 px-6 py-5"
          aria-labelledby="about-product-name"
        >
          <div className="flex gap-4">
            <img
              src={appIconUrl}
              alt={t('settings.about.appIconAlt')}
              className="size-20 shrink-0 drop-shadow-sm sm:size-22"
              draggable={false}
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
                <h2
                  id="about-product-name"
                  className="text-[1.35rem] leading-tight font-semibold tracking-[-0.018em]"
                >
                  {metadata.name}
                </h2>
                <p className="text-sm font-medium tabular-nums text-muted-foreground">
                  {t('settings.about.version', {
                    version: metadata.version,
                  })}
                </p>
              </div>
              <p className="mt-1 max-w-md text-xs leading-[1.45] text-muted-foreground">
                {t('settings.about.tagline')}
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-muted-foreground">
                <span>
                  {t('settings.about.details.createdBy')}{' '}
                  <a
                    href={EXTERNAL_URLS.github.author}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-foreground outline-none hover:underline hover:underline-offset-4 focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {metadata.author.name}
                  </a>
                </span>
                <a
                  href={EXTERNAL_URLS.github.repository}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-foreground outline-none hover:underline hover:underline-offset-4 focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {t('settings.about.resources.repository')}
                </a>
                <span>
                  {t('settings.about.details.licenseValue', {
                    license: metadata.license,
                  })}
                </span>
              </div>
            </div>
          </div>

          <nav
            aria-label={t('settings.about.resources.title')}
            className="-mb-1 -ml-2 mt-4 flex flex-wrap items-center gap-0.5 border-t border-border/60 pt-3"
          >
            <CompactLink
              href={EXTERNAL_URLS.motrix.home}
              title={t('settings.about.resources.website')}
            />
            <CompactLink
              href={EXTERNAL_URLS.motrix.manual.home}
              title={t('settings.about.resources.manual')}
            />
            <CompactLink
              href={EXTERNAL_URLS.motrix.plugins}
              title={t('settings.about.resources.plugins')}
            />
            <CompactLink
              href={EXTERNAL_URLS.motrix.changelog}
              title={t('settings.about.resources.changelog')}
            />
            <CompactLink
              href={EXTERNAL_URLS.motrix.acknowledgments}
              title={t('settings.about.resources.acknowledgments')}
            />
          </nav>
        </section>

        <div
          data-testid="about-dialog-scroll"
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain scrollbar-gutter-stable"
        >
          {showUpdates ? (
            <AppUpdateSection />
          ) : (
            <p className="px-6 py-5 text-xs text-muted-foreground">
              {t('settings.about.webVersionNote')}
            </p>
          )}
        </div>

        <DialogFooter className="shrink-0 flex-row items-center justify-between gap-4 border-t border-border/70 bg-background/85 px-6 py-3.5 backdrop-blur-xl sm:justify-between">
          {showUpdates ? <AutomaticUpdateSetting /> : <span />}
          <Button onClick={onClose} size="sm" className="min-w-20">
            {t('common.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
