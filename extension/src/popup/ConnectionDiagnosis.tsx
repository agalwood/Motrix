import { Bug, ChevronRight } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { send } from '@/background/MessageBus'
import { Alert, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { CopyConnectionDiagnostics } from '@/popup/CopyConnectionDiagnostics'
import { buildConnectionDiagnostics } from '@/popup/connectionDiagnostics'
import type { PopupState } from '@/popup/usePopupState'
import { extensionBrowser } from '@/shared/browser'
import { BUILD_VARIANT } from '@/shared/buildFlags'
import {
  diagnosticDeadline,
  redactDiagnosticError,
} from '@/shared/connectionDiagnostics'
import { LINKS } from '@/shared/links'
import { hasNativeMessagingSupport } from '@/shared/platformCapabilities'

export function ConnectionDiagnosis({
  state,
  heading,
  description,
  variant = 'default',
  children,
}: {
  state: PopupState
  heading: string
  description?: string
  variant?: 'default' | 'destructive'
  children?: React.ReactNode
}): React.ReactElement {
  const { t, i18n } = useTranslation()
  const [running, setRunning] = useState(false)
  const [report, setReport] = useState<string | null>(null)
  const scrollArea = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (report !== null && scrollArea.current) scrollArea.current.scrollTop = 0
  }, [report])
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const run = async (): Promise<void> => {
    if (running) return
    setRunning(true)
    setReport(null)
    let extensionVersion = 'unknown'
    try {
      extensionVersion =
        extensionBrowser.runtime.getManifest?.().version ?? 'unknown'
    } catch {
      // An extension reload can invalidate this popup's browser API context.
    }
    // Capture the failure before the async checks; state may be polled again.
    const snapshot = buildConnectionDiagnostics(state, {
      capturedAt: new Date().toISOString(),
      extensionId: extensionBrowser.runtime.id,
      extensionVersion,
      build: BUILD_VARIANT,
      userAgent: navigator.userAgent,
      language: i18n.resolvedLanguage ?? i18n.language,
      nativeMessagingApi: hasNativeMessagingSupport(),
    })
    let text: string
    try {
      const result = await diagnosticDeadline(
        send('bg.runConnectionDiagnostics', {
          endpointId: state.endpoint?.activeEndpointId ?? null,
        }),
        15000
      )
      if (!result || !Array.isArray(result.checks))
        throw new Error('Invalid diagnostic response')
      const findings = result.checks
        .slice()
        .sort(
          (a, b) =>
            ({ fail: 0, warn: 1, pass: 2, skip: 3 })[a.status] -
            { fail: 0, warn: 1, pass: 2, skip: 3 }[b.status]
        )
        .map(
          (check) =>
            `[${check.status.toUpperCase()}] ${check.id} (${check.durationMs} ms)\n${check.detail}`
        )
        .join('\n\n')
      text = `Diagnostic checks — ${result.backend}, ${result.durationMs} ms\n${findings}\n\n${snapshot}`
    } catch (error) {
      text = `[FAIL] background-diagnostics\n${redactDiagnosticError(error instanceof Error ? error.message : 'Background unavailable')}\nChecks could not finish; debug logging may not be enabled. Inspect the extension background console, reload the extension and retry.\n\n${snapshot}`
    }
    if (alive.current) {
      setReport(text)
      setRunning(false)
    }
  }
  return (
    <Alert
      variant={variant}
      title={state.lastError ?? undefined}
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-0 overflow-hidden p-0"
    >
      <div className="shrink-0 space-y-2 px-4 pt-3 pb-2">
        <div className="flex items-start justify-between gap-2">
          <AlertTitle className="min-w-0 flex-1 py-1 leading-5 text-wrap">
            {heading}
          </AlertTitle>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="h-auto min-h-7 max-w-[50%] whitespace-normal text-foreground"
            disabled={running}
            onClick={() => void run()}
          >
            {running ? (
              <Spinner data-icon="inline-start" aria-hidden="true" />
            ) : (
              <Bug data-icon="inline-start" aria-hidden="true" />
            )}
            {t(
              running
                ? 'popup.diagnostics.running'
                : report
                  ? 'popup.diagnostics.rerun'
                  : 'popup.diagnostics.run'
            )}
          </Button>
        </div>
        {report !== null && (
          <div className="flex items-center justify-between gap-2 border-t border-border pt-1 text-foreground">
            <span className="text-xs font-medium">
              {t('popup.diagnostics.title')}
            </span>
            <CopyConnectionDiagnostics key={report} text={report} />
          </div>
        )}
      </div>
      <div
        ref={scrollArea}
        className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 pb-3 text-xs leading-relaxed text-wrap text-muted-foreground"
      >
        {running ? (
          <p role="status">{t('popup.diagnostics.runningHelp')}</p>
        ) : report !== null ? (
          <section
            aria-label={t('popup.diagnostics.title')}
            className="min-w-0 text-foreground"
          >
            <pre className="m-0 whitespace-pre-wrap font-mono text-[11px] leading-relaxed [overflow-wrap:anywhere]">
              {report}
            </pre>
          </section>
        ) : (
          <>
            {description && <p>{description}</p>}
            {state.endpoint?.activeEndpointId === 'local' && (
              <>
                {state.lastErrorReason === 'backendUpgradeRequired' && (
                  <p>
                    <a
                      href={LINKS.appReleases}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-foreground underline underline-offset-2"
                    >
                      {t('popup.diagnostics.appReleases')}
                    </a>
                  </p>
                )}
                <details className="group/advanced">
                  <summary className="flex min-h-7 cursor-pointer list-none items-center gap-1 rounded-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                    <ChevronRight
                      aria-hidden="true"
                      className="size-3.5 shrink-0 group-open/advanced:rotate-90"
                    />
                    {t('popup.diagnostics.advanced')}
                  </summary>
                  <p>{t('popup.diagnostics.firstLaunchHint')}</p>
                  <p>
                    {t('popup.diagnostics.latestVersionHint')}{' '}
                    <a
                      href={LINKS.appReleases}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-foreground underline underline-offset-2"
                    >
                      {t('popup.diagnostics.appReleases')}
                    </a>
                  </p>
                  <p className="pt-1">{t('popup.diagnostics.allowlistHint')}</p>
                </details>
              </>
            )}
          </>
        )}
        {children}
      </div>
    </Alert>
  )
}
