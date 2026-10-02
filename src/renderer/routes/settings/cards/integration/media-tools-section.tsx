import { CopyButton } from '@renderer/components/desktop-kit/copy-button'
import { MiddleEllipsis } from '@renderer/components/desktop-kit/middle-ellipsis'
import {
  CheckIcon,
  ChevronRightIcon,
  EditIcon,
  HelpIcon,
  InstallIcon,
  RefreshIcon,
  SecurityWarningIcon,
  VerifiedToolIcon,
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
  FormItem,
  FormLabel,
  FormMessage,
} from '@renderer/components/ui/form'
import { Input } from '@renderer/components/ui/input'
import { Progress } from '@renderer/components/ui/progress'
import { Spinner } from '@renderer/components/ui/spinner'
import { useFfmpegInstall } from '@renderer/hooks/use-ffmpeg-install'
import { formatProgressPercent } from '@renderer/lib/format'
import { transport } from '@renderer/lib/transport'
import { cn } from '@renderer/lib/utils'
import { EXTERNAL_URLS, getFfmpegManualUrl } from '@shared/external-urls'
import { Queries } from '@shared/protocol/queries'
import { useEffect, useId, useState } from 'react'
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
  const { t, i18n } = useTranslation()
  const form = useFormContext<IntegrationFormValues>()
  const [detection, setDetection] = useState<FfmpegDetectionResultUI | null>(
    null
  )
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [customPathEditing, setCustomPathEditing] = useState(false)
  const [installPrompt, setInstallPrompt] = useState(false)
  const downloadProgressId = useId()
  const {
    status: installStatus,
    installing,
    install: installFfmpeg,
  } = useFfmpegInstall()
  const [installResult, setInstallResult] = useState<
    'installed' | 'failed' | null
  >(null)
  const [installError, setInstallError] = useState<string | null>(null)
  const [detectionRefreshFailed, setDetectionRefreshFailed] = useState(false)
  const canInstall = ['darwin', 'linux', 'win32'].includes(transport.platform)
  const visibleResult =
    installResult ?? (installStatus?.phase === 'failed' ? 'failed' : null)
  const visibleError = installError ?? installStatus?.error
  const pathError = form.formState.errors.media?.ffmpegBinaryPath
  const editingPath = customPathEditing || Boolean(pathError)
  const installPhase =
    installing &&
    installStatus &&
    !['idle', 'installed', 'failed'].includes(installStatus.phase)
      ? installStatus.phase
      : null
  const downloadProgress =
    installPhase === 'downloading' && installStatus?.percent != null
      ? formatProgressPercent(installStatus.percent)
      : undefined
  const installLabel = installing
    ? t(
        installPhase
          ? `settings.integration.media.download.phases.${installPhase}`
          : 'settings.integration.media.download.installing'
      )
    : t('settings.integration.media.download.verifyInstall')

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
    try {
      const r = (await transport.invoke(
        Queries.GetFfmpegDetection
      )) as FfmpegDetectionResultUI
      setDetection(r)
      setDetectionRefreshFailed(false)
    } catch {
      // Detection is independent of the already committed installation result.
      setDetectionRefreshFailed(true)
    }
  }

  const install = async () => {
    setInstallResult(null)
    setInstallError(null)
    try {
      const result = await installFfmpeg()
      if (!result) return
      setInstallResult(result.ok ? 'installed' : 'failed')
      if (!result.ok) setInstallError(result.error)
      if (result.ok) await refresh()
    } catch {
      setInstallResult('failed')
      setInstallError('download')
    }
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
      ? t(
          transport.platform === 'win32'
            ? 'settings.integration.media.download.failed'
            : 'settings.integration.media.detection.untrustedTitle'
        )
      : t('settings.integration.media.detection.unavailableTitle')
  const activeDescription = detection?.active
    ? t('settings.integration.media.detection.usingSource', {
        source: activeSource,
      })
    : hasUntrustedCandidate
      ? t(
          transport.platform === 'win32'
            ? 'settings.integration.media.download.disclosure'
            : 'settings.integration.media.detection.untrustedDesc'
        )
      : t('settings.integration.media.detection.unavailableDesc')
  const candidates = detection?.candidates ?? []
  const editableCandidates: FfmpegDetectionResultUI['candidates'] =
    candidates.some((candidate) => candidate.kind === 'manual')
      ? candidates
      : [{ kind: 'manual', path: null, state: 'unconfigured' }, ...candidates]
  const candidateCount = candidates.length
  const showInstallControls =
    canInstall && Boolean(installPrompt || installing || visibleResult)
  const showInstallAction = showInstallControls && visibleResult !== 'installed'
  const directoryLabel = installStatus?.directory
    ? t('settings.integration.media.download.directory', { path: '\0' }).split(
        '\0'
      )
    : null

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
              {detection?.active && <VerifiedToolIcon className="size-4" />}
              {hasUntrustedCandidate && (
                <SecurityWarningIcon className="size-4 text-destructive" />
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
                  href={getFfmpegManualUrl(i18n.language)}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={t('settings.integration.media.download.manual')}
                  title={t('settings.integration.media.download.manual')}
                  // biome-ignore lint/a11y/noRedundantRoles: Base UI Button applies button semantics unless this rendered anchor explicitly overrides them.
                  role="link"
                />
              }
              nativeButton={false}
              size="icon-sm"
              variant="ghost"
            >
              <HelpIcon className="size-4 text-muted-foreground" aria-hidden />
            </Button>
            {canInstall ? (
              !showInstallAction && (
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  disabled={installing}
                  aria-label={t('settings.integration.media.download.action')}
                  onClick={() => {
                    setInstallPrompt(true)
                    setInstallResult(null)
                    setInstallError(null)
                  }}
                >
                  <InstallIcon
                    className="size-4 text-muted-foreground"
                    aria-hidden
                  />
                </Button>
              )
            ) : (
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
                <InstallIcon
                  className="size-4 text-muted-foreground"
                  aria-hidden
                />
              </Button>
            )}
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={t('settings.integration.media.refresh')}
              onClick={refresh}
            >
              <RefreshIcon className="size-4 text-muted-foreground" />
            </Button>
          </div>
        </div>

        {showInstallControls && (
          <div className="space-y-2 border-t border-border pt-2 text-xs text-muted-foreground">
            {!installing && visibleResult !== 'installed' && (
              <p className="leading-normal">
                {t('settings.integration.media.download.projectDisclosure')}
                {transport.platform === 'win32' && (
                  <> {t('settings.integration.media.download.disclosure')}</>
                )}
                {transport.platform === 'darwin' && (
                  <> {t('settings.integration.media.download.macDisclosure')}</>
                )}
              </p>
            )}
            {showInstallAction && (
              <Button
                data-testid="ffmpeg-install-action"
                type="button"
                size="sm"
                className={cn(
                  'relative min-h-7 h-auto! max-w-full overflow-hidden rounded-md! px-2 py-1 text-xs shadow-none transition-colors motion-reduce:transition-none',
                  installing && 'disabled:opacity-100'
                )}
                aria-label={
                  downloadProgress === undefined
                    ? installLabel
                    : `${installLabel} ${downloadProgress}%`
                }
                aria-busy={installing || undefined}
                title={
                  installPhase === 'downloading' &&
                  installStatus &&
                  installStatus.bytesTotal > 0
                    ? t('settings.integration.media.download.bytes', {
                        received: installStatus.bytesReceived.toLocaleString(),
                        total: installStatus.bytesTotal.toLocaleString(),
                      })
                    : undefined
                }
                aria-describedby={
                  installPhase === 'downloading'
                    ? downloadProgressId
                    : undefined
                }
                disabled={installing}
                onClick={install}
              >
                {downloadProgress !== undefined && (
                  <span
                    data-slot="ffmpeg-download-fill"
                    className="pointer-events-none absolute inset-0 origin-left bg-primary-foreground/20 transition-transform duration-200 ease-linear motion-reduce:transition-none"
                    style={{ transform: `scaleX(${downloadProgress / 100})` }}
                    aria-hidden="true"
                  />
                )}
                <span className="relative inline-flex items-center justify-center gap-1.5">
                  {installing && downloadProgress === undefined ? (
                    <Spinner
                      className="size-3.5 motion-reduce:animate-none"
                      aria-hidden="true"
                    />
                  ) : (
                    <InstallIcon className="size-3.5" aria-hidden="true" />
                  )}
                  <span className="whitespace-normal tabular-nums">
                    {downloadProgress === undefined
                      ? installLabel
                      : `${downloadProgress}%`}
                  </span>
                </span>
              </Button>
            )}
            {installing && (
              <p className="sr-only" role="status">
                {installLabel}
              </p>
            )}
            {installPhase === 'downloading' && installStatus && (
              <Progress
                id={downloadProgressId}
                className="sr-only absolute! h-px w-px"
                value={downloadProgress}
                aria-label={t('settings.integration.media.download.progress')}
              />
            )}
            {visibleResult && (
              <p role="status">
                {t(`settings.integration.media.download.${visibleResult}`)}
                {visibleError && (
                  <span>
                    {' '}
                    {t(
                      `settings.integration.media.download.errors.${visibleError}`
                    )}
                  </span>
                )}
                {visibleResult === 'installed' && (
                  <span>
                    {' '}
                    {t('settings.integration.media.download.restartPluginHint')}
                  </span>
                )}
              </p>
            )}
            {installStatus?.directory && (
              <div
                data-testid="ffmpeg-installed-directory"
                className="flex min-w-0 items-center gap-1.5"
              >
                <span className="shrink-0">{directoryLabel?.[0]}</span>
                <MiddleEllipsis
                  text={installStatus.directory}
                  className="flex-1"
                />
                {directoryLabel?.[1] && (
                  <span className="shrink-0">{directoryLabel[1]}</span>
                )}
                <CopyButton
                  content={installStatus.directory}
                  iconPosition="end"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t(
                    'settings.integration.media.detection.copyManagedPath'
                  )}
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                />
              </div>
            )}
            {detectionRefreshFailed && (
              <p role="alert">
                {t(
                  'settings.integration.media.download.detectionRefreshFailed'
                )}
              </p>
            )}
          </div>
        )}

        {transport.platform !== 'web' &&
          (detailsOpen || Boolean(pathError)) && (
            <p className="text-xs text-muted-foreground">
              {t('settings.integration.media.applyHint')}
            </p>
          )}

        <Collapsible
          open={detailsOpen || Boolean(pathError)}
          onOpenChange={setDetailsOpen}
        >
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
                  className="flex items-center justify-between flex-1 -ms-2 h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:bg-transparent dark:hover:bg-transparent hover:text-foreground"
                />
              }
            >
              <ChevronRightIcon
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
              <div className="grid grid-cols-[9rem_minmax(0,1fr)_5rem] gap-3 border-b border-border px-3 py-2 font-medium text-muted-foreground">
                <span>{t('settings.integration.media.detection.source')}</span>
                <span>
                  {t('settings.integration.media.detection.location')}
                </span>
                <span className="text-end">
                  {t('settings.integration.media.detection.result')}
                </span>
              </div>
              {editableCandidates.map((c) => (
                <div
                  key={c.kind}
                  data-testid={`candidate-row-${c.kind}`}
                  className="grid min-h-11 grid-cols-[9rem_minmax(0,1fr)_5rem] items-center gap-3 border-b border-border px-3 py-2 last:border-b-0"
                >
                  <span className="min-w-0 break-all font-medium text-foreground">
                    {t(`settings.integration.media.candidateKind.${c.kind}`)}
                  </span>
                  {c.kind === 'manual' ? (
                    <FormField
                      control={form.control}
                      name="media.ffmpegBinaryPath"
                      render={({ field }) => (
                        <FormItem className="grid min-h-7 min-w-0 grid-cols-[minmax(0,1fr)_1.5rem] items-center gap-1">
                          {editingPath ? (
                            <FormControl>
                              <Input
                                {...field}
                                autoFocus
                                data-testid="media-binary-path-input"
                                title={field.value || undefined}
                                aria-label={t(
                                  'settings.integration.media.binaryPath'
                                )}
                                placeholder={t(
                                  'settings.integration.media.detection.notConfigured'
                                )}
                                className="h-7 min-w-0 px-2 font-mono text-xs text-foreground placeholder:text-xs md:text-xs md:placeholder:text-xs"
                                onKeyDown={async (event) => {
                                  if (event.key === 'Enter') {
                                    event.preventDefault()
                                    if (
                                      await form.trigger(
                                        'media.ffmpegBinaryPath'
                                      )
                                    )
                                      setCustomPathEditing(false)
                                  } else if (event.key === 'Escape') {
                                    setCustomPathEditing(false)
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
                            <span className="text-muted-foreground">
                              {t(
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
                              editingPath
                                ? 'settings.integration.media.detection.finishEditingCustomPath'
                                : 'settings.integration.media.detection.editCustomPath'
                            )}
                            title={t(
                              editingPath
                                ? 'settings.integration.media.detection.finishEditingCustomPath'
                                : 'settings.integration.media.detection.editCustomPath'
                            )}
                            onClick={async () => {
                              if (!editingPath) setCustomPathEditing(true)
                              else if (
                                await form.trigger('media.ffmpegBinaryPath')
                              )
                                setCustomPathEditing(false)
                            }}
                          >
                            {editingPath ? (
                              <CheckIcon aria-hidden />
                            ) : (
                              <EditIcon aria-hidden />
                            )}
                          </Button>
                          <FormMessage className="col-span-full text-xs" />
                        </FormItem>
                      )}
                    />
                  ) : c.kind === 'userData' && c.path ? (
                    <div className="grid h-7 min-w-0 grid-cols-[minmax(0,1fr)_1.5rem] items-center gap-1">
                      <MiddleEllipsis
                        text={c.path}
                        className="text-muted-foreground"
                      />
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
                    <div className="min-w-0">
                      {c.path ? (
                        <MiddleEllipsis
                          text={c.path}
                          className="text-muted-foreground"
                        />
                      ) : (
                        <span className="text-muted-foreground">
                          {t(
                            'settings.integration.media.detection.notConfigured'
                          )}
                        </span>
                      )}
                    </div>
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
          <SettingsFormRow>
            <div className="space-y-1">
              <FormLabel>{t('settings.integration.media.stagingMB')}</FormLabel>
              <FormDescription className="text-xs">
                {t('settings.integration.media.stagingMBDesc')}
              </FormDescription>
            </div>
            <FormControl>
              <Input
                {...field}
                type="number"
                min={256}
                max={65536}
                data-testid="media-staging-mb-input"
                className="w-30 h-8"
                value={Number.isFinite(field.value) ? field.value : ''}
                onChange={(event) => field.onChange(event.target.valueAsNumber)}
              />
            </FormControl>
          </SettingsFormRow>
        )}
      />

      <FormField
        control={form.control}
        name="media.ffmpegOpTimeoutSec"
        render={({ field }) => (
          <SettingsFormRow>
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
                {...field}
                type="number"
                min={60}
                max={3600}
                data-testid="media-op-timeout-sec-input"
                className="w-30 h-8"
                value={Number.isFinite(field.value) ? field.value : ''}
                onChange={(event) => field.onChange(event.target.valueAsNumber)}
              />
            </FormControl>
          </SettingsFormRow>
        )}
      />
    </div>
  )
}
