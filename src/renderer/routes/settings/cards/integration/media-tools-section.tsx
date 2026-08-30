import { CopyButton } from '@renderer/components/desktop-kit/copy-button'
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
  FormItem,
  FormLabel,
} from '@renderer/components/ui/form'
import { Input } from '@renderer/components/ui/input'
import { transport } from '@renderer/lib/transport'
import { cn } from '@renderer/lib/utils'
import { EXTERNAL_URLS } from '@shared/external-urls'
import { Queries } from '@shared/protocol/queries'
import { DEFAULT_MEDIA_SETTINGS } from '@shared/schemas'
import {
  BadgeCheck,
  Check,
  ChevronRight,
  Download,
  Pencil,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { useFormContext } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import type { IntegrationFormValues } from './integration-dialog'

// Local mirror of the FfmpegDetectionResult shape from
// `src/core/plugin/capabilities/ffmpeg-detect.ts`. Renderer cannot import
// from @core, so the structural shape is duplicated here. Keep in sync when
// CandidateKind / CandidateState evolves.
type CandidateKindUI = 'manual' | 'userData' | 'env' | 'path'
type CandidateStateUI =
  | 'active'
  | 'available'
  | 'missing'
  | 'untrusted'
  | 'unconfigured'
  | 'version_mismatch'

interface FfmpegDetectionResultUI {
  active: { path: string; version: string } | null
  candidates: Array<{
    kind: CandidateKindUI
    path: string | null
    state: CandidateStateUI
    version?: string
  }>
}

function candidateStateVariant(state: CandidateStateUI) {
  if (state === 'active') return 'default'
  if (state === 'available') return 'secondary'
  if (state === 'version_mismatch' || state === 'untrusted') {
    return 'destructive'
  }
  return 'outline'
}

export function MediaToolsSection() {
  const { t } = useTranslation()
  const form = useFormContext<IntegrationFormValues>()
  const [detection, setDetection] = useState<FfmpegDetectionResultUI | null>(
    null
  )
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [customPathEditing, setCustomPathEditing] = useState(false)

  useEffect(() => {
    let cancelled = false
    transport
      .invoke(Queries.GetFfmpegDetection)
      .then((d) => {
        if (cancelled) return
        setDetection(d as FfmpegDetectionResultUI)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const refresh = async () => {
    const r = (await transport.invoke(
      Queries.GetFfmpegDetection
    )) as FfmpegDetectionResultUI
    setDetection(r)
  }

  const activeCandidate = detection?.candidates.find(
    (c) => c.state === 'active'
  )
  const activeSource = activeCandidate
    ? t(`settings.integration.media.candidateKind.${activeCandidate.kind}`)
    : null
  const hasUntrustedCandidate =
    !detection?.active &&
    detection?.candidates.some((candidate) => candidate.state === 'untrusted')
  const activeLabel = detection?.active
    ? t('settings.integration.media.detection.readyTitle', {
        version: detection.active.version,
      })
    : hasUntrustedCandidate
      ? t('settings.integration.media.detection.untrustedTitle')
      : t('settings.integration.media.detection.unavailableTitle')
  const activeDescription = detection?.active
    ? t('settings.integration.media.detection.usingSource', {
        source: activeSource,
      })
    : hasUntrustedCandidate
      ? t('settings.integration.media.detection.untrustedDesc')
      : t('settings.integration.media.detection.unavailableDesc')
  const candidateCount = detection?.candidates.length ?? 0

  return (
    <div className="space-y-4">
      <section
        data-testid="media-detection-card"
        className="space-y-3 rounded-lg border border-border bg-card p-3 pb-2"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-sm font-medium">{activeLabel}</div>
              {detection?.active && <BadgeCheck className="size-4" />}
              {hasUntrustedCandidate && (
                <ShieldAlert className="size-4 text-destructive" />
              )}
            </div>
            <div className="text-xs text-muted-foreground">
              {activeDescription}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              render={
                <a
                  href={EXTERNAL_URLS.github.ffmpegStaticReleases}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={t('settings.integration.media.download.action')}
                  title={t('settings.integration.media.download.action')}
                  // biome-ignore lint/a11y/noRedundantRoles: Base UI Button applies button semantics unless this rendered anchor explicitly overrides them.
                  role="link"
                />
              }
              nativeButton={false}
              size="icon-sm"
              variant="ghost"
            >
              <Download className="size-4 text-muted-foreground" aria-hidden />
            </Button>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={t('settings.integration.media.refresh')}
              onClick={refresh}
            >
              <RefreshCw className="size-4 text-muted-foreground" />
            </Button>
          </div>
        </div>

        <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen}>
          <div className="flex items-center justify-between gap-3 border-t border-border pt-2">
            <CollapsibleTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={t(
                    detailsOpen
                      ? 'settings.integration.media.detection.hideDetails'
                      : 'settings.integration.media.detection.showDetails'
                  )}
                  className="flex items-center justify-between flex-1 -ml-2 h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:bg-transparent dark:hover:bg-transparent hover:text-foreground"
                />
              }
            >
              <ChevronRight
                className={cn(
                  'size-3.5 transition-transform duration-150',
                  detailsOpen && 'rotate-90'
                )}
                aria-hidden="true"
              />
              <div className="text-xs text-muted-foreground">
                {t('settings.integration.media.detection.sourcesChecked', {
                  count: candidateCount,
                })}
              </div>
            </CollapsibleTrigger>
          </div>
          <CollapsibleContent className="mt-2">
            <div className="overflow-hidden rounded-md border border-border bg-background/70 text-xs mb-1">
              <div className="grid grid-cols-[10rem_minmax(0,1fr)_7rem] gap-2 border-b border-border px-3 py-2 font-medium text-muted-foreground">
                <span>{t('settings.integration.media.detection.source')}</span>
                <span>
                  {t('settings.integration.media.detection.location')}
                </span>
                <span className="text-right">
                  {t('settings.integration.media.detection.result')}
                </span>
              </div>
              {detection?.candidates.map((c) => (
                <div
                  key={c.kind}
                  data-testid={`candidate-row-${c.kind}`}
                  className="grid h-11 grid-cols-[10rem_minmax(0,1fr)_7rem] items-center gap-2 border-b border-border px-3 py-2 last:border-b-0"
                >
                  <span className="font-medium text-foreground">
                    {t(`settings.integration.media.candidateKind.${c.kind}`)}
                  </span>
                  {c.kind === 'manual' ? (
                    <FormField
                      control={form.control}
                      name="media.ffmpegBinaryPath"
                      render={({ field }) => (
                        <div className="grid h-7 min-w-0 grid-cols-[minmax(0,1fr)_1.5rem] items-center gap-1">
                          {customPathEditing ? (
                            <Input
                              {...field}
                              autoFocus
                              data-testid="media-binary-path-input"
                              aria-label={t(
                                'settings.integration.media.binaryPath'
                              )}
                              placeholder={t(
                                'settings.integration.media.detection.notConfigured'
                              )}
                              className="h-7 min-w-0 px-2 font-mono text-xs text-foreground placeholder:text-xs md:text-xs md:placeholder:text-xs"
                              onKeyDown={(event) => {
                                if (event.key === 'Enter') {
                                  event.preventDefault()
                                  setCustomPathEditing(false)
                                } else if (event.key === 'Escape') {
                                  setCustomPathEditing(false)
                                }
                              }}
                            />
                          ) : (
                            <span
                              className="min-w-0 flex-1 truncate font-mono text-muted-foreground"
                              title={field.value || undefined}
                            >
                              {field.value ||
                                t(
                                  'settings.integration.media.detection.notConfigured'
                                )}
                            </span>
                          )}
                          <Button
                            type="button"
                            size="icon-xs"
                            variant="ghost"
                            className="shrink-0 text-muted-foreground"
                            aria-label={t(
                              customPathEditing
                                ? 'settings.integration.media.detection.finishEditingCustomPath'
                                : 'settings.integration.media.detection.editCustomPath'
                            )}
                            title={t(
                              customPathEditing
                                ? 'settings.integration.media.detection.finishEditingCustomPath'
                                : 'settings.integration.media.detection.editCustomPath'
                            )}
                            onClick={() =>
                              setCustomPathEditing((editing) => !editing)
                            }
                          >
                            {customPathEditing ? (
                              <Check aria-hidden />
                            ) : (
                              <Pencil aria-hidden />
                            )}
                          </Button>
                        </div>
                      )}
                    />
                  ) : c.kind === 'userData' && c.path ? (
                    <div className="grid h-7 min-w-0 grid-cols-[minmax(0,1fr)_1.5rem] items-center gap-1">
                      <span
                        dir="ltr"
                        title={c.path}
                        className="min-w-0 truncate font-mono text-muted-foreground"
                      >
                        {c.path}
                      </span>
                      <CopyButton
                        content={c.path}
                        iconPosition="end"
                        variant="ghost"
                        size="icon-xs"
                        aria-label={t(
                          'settings.integration.media.detection.copyManagedPath'
                        )}
                        title={t(
                          'settings.integration.media.detection.copyManagedPath'
                        )}
                        className="shrink-0 text-muted-foreground hover:text-foreground"
                      />
                    </div>
                  ) : (
                    <span
                      className="truncate font-mono text-muted-foreground"
                      title={c.path ?? undefined}
                    >
                      {c.path ??
                        t('settings.integration.media.detection.notConfigured')}
                    </span>
                  )}
                  <Badge
                    variant={candidateStateVariant(c.state)}
                    className="justify-self-end rounded-md"
                  >
                    {t(`settings.integration.media.state.${c.state}`)}
                  </Badge>
                </div>
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      </section>

      <FormField
        control={form.control}
        name="media.ffmpegStagingMB"
        render={({ field }) => (
          <FormItem className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <FormLabel>{t('settings.integration.media.stagingMB')}</FormLabel>
              <FormDescription className="text-xs">
                {t('settings.integration.media.stagingMBDesc')}
              </FormDescription>
            </div>
            <FormControl>
              <Input
                type="number"
                min={256}
                max={65536}
                data-testid="media-staging-mb-input"
                className="w-30 h-8"
                value={field.value}
                onChange={(e) => {
                  const n = Number.parseInt(e.target.value, 10)
                  field.onChange(
                    Number.isFinite(n)
                      ? n
                      : DEFAULT_MEDIA_SETTINGS.ffmpegStagingMB
                  )
                }}
              />
            </FormControl>
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name="media.ffmpegOpTimeoutSec"
        render={({ field }) => (
          <FormItem className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <FormLabel>
                {t('settings.integration.media.opTimeoutSec')}
              </FormLabel>
              <FormDescription className="text-xs">
                {t('settings.integration.media.opTimeoutSecDesc')}
              </FormDescription>
            </div>
            <FormControl>
              <Input
                type="number"
                min={60}
                max={3600}
                data-testid="media-op-timeout-sec-input"
                className="w-30 h-8"
                value={field.value}
                onChange={(e) => {
                  const n = Number.parseInt(e.target.value, 10)
                  field.onChange(
                    Number.isFinite(n)
                      ? n
                      : DEFAULT_MEDIA_SETTINGS.ffmpegOpTimeoutSec
                  )
                }}
              />
            </FormControl>
          </FormItem>
        )}
      />
    </div>
  )
}
