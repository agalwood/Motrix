import { MiddleEllipsis } from '@renderer/components/desktop-kit/middle-ellipsis'
import {
  CheckIcon,
  EditIcon,
  RefreshIcon,
  SecurityWarningIcon,
} from '@renderer/components/icons'
import { SettingsFormRow } from '@renderer/components/settings-kit/settings-form-row'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@renderer/components/ui/collapsible'
import {
  FormControl,
  FormDescription,
  FormField,
  FormLabel,
} from '@renderer/components/ui/form'
import { Input } from '@renderer/components/ui/input'
import { Switch } from '@renderer/components/ui/switch'
import { transport } from '@renderer/lib/transport'
import { cn } from '@renderer/lib/utils'
import { EXTERNAL_URLS } from '@shared/external-urls'
import { Queries } from '@shared/protocol/queries'
import { useEffect, useState } from 'react'
import { useFormContext } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import type { IntegrationFormValues } from './integration-dialog'

/**
 * yt-dlp detection result. Structural mirror of the core locator result —
 * the renderer may not import from @core (see architecture.md layer matrix).
 */
interface YtdlpDetectionUI {
  enabled: boolean
  available: boolean
  binaryPath: string | null
  version: string | null
}

/**
 * Settings → Integration → Media → yt-dlp.
 *
 * yt-dlp is the extractor that turns a media-site URL (YouTube, Vimeo,
 * bilibili, …) into real stream URLs. Detection is informational only: the
 * resolver simply stays dormant when no binary is found, so every other
 * download is unaffected.
 */
export function YtdlpToolsSection() {
  const { t } = useTranslation()
  const form = useFormContext<IntegrationFormValues>()
  const [detection, setDetection] = useState<YtdlpDetectionUI | null>(null)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [pathEditing, setPathEditing] = useState(false)
  const pathError = form.formState.errors.media?.ytdlpBinaryPath
  const editingPath = pathEditing || Boolean(pathError)

  useEffect(() => {
    let cancelled = false
    transport
      .invoke(Queries.GetYtdlpDetection)
      .then((result) => {
        if (!cancelled) setDetection(result as YtdlpDetectionUI)
      })
      .catch(() => {
        // A shell without the query (older server build) leaves the
        // indicator blank rather than failing the whole settings card.
        if (!cancelled) setDetection(null)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const refresh = async () => {
    try {
      const result = (await transport.invoke(
        Queries.GetYtdlpDetection
      )) as YtdlpDetectionUI
      setDetection(result)
    } catch {
      setDetection(null)
    }
  }

  return (
    <section
      data-testid="ytdlp-tools-section"
      className="space-y-4 rounded-lg border border-border bg-card p-3"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <div className="text-sm font-medium">
              {t('settings.integration.media.ytdlp.title')}
            </div>
            {detection?.available && (
              <Badge variant="secondary" className="rounded-md">
                {t('settings.integration.media.ytdlp.detected', {
                  version: detection.version ?? '',
                })}
              </Badge>
            )}
            {detection && !detection.available && (
              <SecurityWarningIcon
                className="size-4 text-muted-foreground"
                aria-hidden
              />
            )}
          </div>
          <div className="text-xs text-muted-foreground">
            {t('settings.integration.media.ytdlp.description')}
          </div>
        </div>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={t('settings.integration.media.ytdlp.refresh')}
          title={t('settings.integration.media.ytdlp.refresh')}
          onClick={refresh}
        >
          <RefreshIcon className="size-4 text-muted-foreground" aria-hidden />
        </Button>
      </div>

      <FormField
        control={form.control}
        name="media.ytdlpEnabled"
        render={({ field }) => (
          <SettingsFormRow>
            <div className="space-y-1">
              <FormLabel>
                {t('settings.integration.media.ytdlp.enabled')}
              </FormLabel>
              <FormDescription className="text-xs">
                {t('settings.integration.media.ytdlp.enabledDesc')}
              </FormDescription>
            </div>
            <FormControl>
              <Switch
                checked={field.value}
                onCheckedChange={field.onChange}
                data-testid="ytdlp-enabled-switch"
              />
            </FormControl>
          </SettingsFormRow>
        )}
      />

      <FormField
        control={form.control}
        name="media.ytdlpBinaryPath"
        render={({ field }) => (
          <SettingsFormRow>
            <div className="space-y-1">
              <FormLabel>
                {t('settings.integration.media.ytdlp.binaryPath')}
              </FormLabel>
              <FormDescription className="text-xs">
                {t('settings.integration.media.ytdlp.binaryPathDesc')}
              </FormDescription>
            </div>
            <div className="grid min-h-7 min-w-0 max-w-60 grid-cols-[minmax(0,1fr)_1.75rem] items-center gap-1">
              {editingPath ? (
                <FormControl>
                  <Input
                    {...field}
                    autoFocus
                    data-testid="ytdlp-binary-path-input"
                    title={field.value || undefined}
                    aria-label={t(
                      'settings.integration.media.ytdlp.binaryPath'
                    )}
                    placeholder={t(
                      'settings.integration.media.ytdlp.binaryPathPlaceholder'
                    )}
                    className="h-8 min-w-0 px-2 font-mono text-xs md:text-xs"
                    onKeyDown={async (event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        if (await form.trigger('media.ytdlpBinaryPath')) {
                          setPathEditing(false)
                          await refresh()
                        }
                      } else if (event.key === 'Escape') {
                        setPathEditing(false)
                      }
                    }}
                  />
                </FormControl>
              ) : field.value ? (
                <MiddleEllipsis
                  text={field.value}
                  className="text-muted-foreground"
                />
              ) : (
                <span className="truncate text-muted-foreground">
                  {detection?.binaryPath
                    ? detection.binaryPath
                    : t(
                        'settings.integration.media.ytdlp.binaryPathPlaceholder'
                      )}
                </span>
              )}
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                className="shrink-0 text-muted-foreground"
                aria-label={t(
                  editingPath
                    ? 'settings.integration.media.ytdlp.finishEditing'
                    : 'settings.integration.media.ytdlp.editPath'
                )}
                title={t(
                  editingPath
                    ? 'settings.integration.media.ytdlp.finishEditing'
                    : 'settings.integration.media.ytdlp.editPath'
                )}
                onClick={async () => {
                  if (!editingPath) setPathEditing(true)
                  else if (await form.trigger('media.ytdlpBinaryPath')) {
                    setPathEditing(false)
                    await refresh()
                  }
                }}
              >
                {editingPath ? (
                  <CheckIcon aria-hidden />
                ) : (
                  <EditIcon aria-hidden />
                )}
              </Button>
            </div>
          </SettingsFormRow>
        )}
      />

      <FormField
        control={form.control}
        name="media.ytdlpFormat"
        render={({ field }) => (
          <SettingsFormRow>
            <div className="space-y-1">
              <FormLabel>
                {t('settings.integration.media.ytdlp.format')}
              </FormLabel>
              <FormDescription className="text-xs">
                {t('settings.integration.media.ytdlp.formatDesc')}
              </FormDescription>
            </div>
            <FormControl>
              <Input
                {...field}
                data-testid="ytdlp-format-input"
                placeholder="bv*+ba/b"
                className="h-8 w-40 min-w-0 px-2 font-mono text-xs md:text-xs"
              />
            </FormControl>
          </SettingsFormRow>
        )}
      />

      <FormField
        control={form.control}
        name="media.ytdlpAllUrls"
        render={({ field }) => (
          <SettingsFormRow>
            <div className="space-y-1">
              <FormLabel>
                {t('settings.integration.media.ytdlp.allUrls')}
              </FormLabel>
              <FormDescription className="text-xs">
                {t('settings.integration.media.ytdlp.allUrlsDesc')}
              </FormDescription>
            </div>
            <FormControl>
              <Switch
                checked={field.value}
                onCheckedChange={field.onChange}
                data-testid="ytdlp-all-urls-switch"
              />
            </FormControl>
          </SettingsFormRow>
        )}
      />

      <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen}>
        <CollapsibleTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={cn(
                '-ms-2 flex h-7 items-center gap-1.5 px-2 text-xs text-muted-foreground hover:bg-transparent hover:text-foreground dark:hover:bg-transparent'
              )}
            />
          }
        >
          {t('settings.integration.media.ytdlp.installHelp')}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mt-2 space-y-2 text-xs text-muted-foreground">
            <p>{t('settings.integration.media.ytdlp.installHelpBody')}</p>
            <Button
              render={
                <a
                  href={EXTERNAL_URLS.github.ytdlpReleases}
                  target="_blank"
                  rel="noopener noreferrer"
                  // biome-ignore lint/a11y/noRedundantRoles: Base UI Button applies button semantics unless this rendered anchor explicitly overrides them.
                  role="link"
                />
              }
              nativeButton={false}
              size="sm"
              variant="outline"
              className="h-7 text-xs"
            >
              {t('settings.integration.media.ytdlp.download')}
            </Button>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </section>
  )
}
