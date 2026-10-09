import { Alert } from '@renderer/components/ui/alert'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import {
  ScrollArea,
  ScrollAreaContent,
  ScrollAreaViewport,
  ScrollBar,
} from '@renderer/components/ui/scroll-area'
import { Spinner } from '@renderer/components/ui/spinner'
import { cn } from '@renderer/lib/utils'
import type { ConsentPayloadFfmpegRuntime } from '@shared/types/plugin-install'
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'
import { InlineConsentPanel } from './components/inline-consent-panel'
import { PluginAvatar } from './components/plugin-avatar'
import {
  type CheckArgs,
  PluginInputGroup,
} from './components/plugin-input-group'
import {
  type InstallSource,
  usePluginInstall,
} from './hooks/use-plugin-install'
import type { GrantsMap } from './lib/audience'
import { usePluginsStore } from './store'

function FfmpegRuntimeBlock({ rt }: { rt: ConsentPayloadFfmpegRuntime }) {
  const { t } = useTranslation()
  if (rt.requiredByPlugin === 'none') return null
  const hasProblem = !rt.available || rt.satisfiesRange === false
  if (!hasProblem) return null
  const blocking = rt.requiredByPlugin === 'required'
  return (
    <div
      data-testid="ffmpeg-runtime-block"
      className={cn(
        'mb-4 rounded-md border p-3 text-xs',
        blocking
          ? 'border-destructive bg-destructive/10 text-destructive'
          : 'border-amber-300 bg-amber-100 text-amber-900'
      )}
    >
      <div className="font-semibold">{t('plugin.install.ffmpeg.title')}</div>
      <div>
        {rt.available
          ? t('plugin.install.ffmpeg.versionMismatch', { version: rt.version })
          : t('plugin.install.ffmpeg.notInstalled')}
      </div>
      <div>
        {blocking
          ? t('plugin.install.ffmpeg.requiredByPlugin')
          : t('plugin.install.ffmpeg.optionalDegraded')}
      </div>
    </div>
  )
}

interface Props {
  open: boolean
  onOpenChange: (v: boolean) => void
  /**
   * Registry mode: the source is fixed (no picker) and staging starts as
   * soon as the dialog opens. Provided by RegistryDetailPanel (install)
   * and PluginDetailPage (update) — both funnel into the same consent UI.
   */
  fixedSource?: Extract<InstallSource, { sourceType: 'registry' }>
  /** A fixed-source action keeps staging feedback beside its trigger. */
  renderTrigger?: (state: {
    preparing: boolean
    error: string | null
    cancel: () => void
    retry: () => void
  }) => ReactNode
  inlineErrors?: boolean
  returnFocusRef?: RefObject<HTMLButtonElement | null>
  onInstalled?: () => void
}

export function PluginInstallDialog(props: Props) {
  return (
    <PluginInstallSession
      key={props.fixedSource?.pluginId ?? 'manual'}
      {...props}
    />
  )
}

function PluginInstallSession({
  open,
  onOpenChange,
  fixedSource,
  renderTrigger,
  inlineErrors = false,
  returnFocusRef,
  onInstalled,
}: Props) {
  const { t } = useTranslation()
  const install = usePluginInstall()
  const clearUpdate = usePluginsStore((s) => s.clearUpdate)
  const [grants, setGrants] = useState<GrantsMap>({})
  const startedRef = useRef(false)
  const wasOpenRef = useRef(false)
  const cancelButtonRef = useRef<HTMLButtonElement>(null)

  const callbacksRef = useRef({ open, onOpenChange, onInstalled })
  callbacksRef.current = { open, onOpenChange, onInstalled }
  const pluginId = fixedSource?.pluginId
  const { startInstall, cancel, resetPresentation } = install
  useEffect(
    () => () => {
      startedRef.current = false
    },
    []
  )

  useEffect(() => {
    if (!open) {
      startedRef.current = false
      if (wasOpenRef.current) void cancel()
      wasOpenRef.current = false
      return
    }
    if (!wasOpenRef.current) {
      resetPresentation()
      setGrants({})
    }
    wasOpenRef.current = true
    if (!pluginId || startedRef.current) return
    startedRef.current = true
    setGrants({})
    void startInstall({ sourceType: 'registry', pluginId }).then(
      (committed) => {
        if (!committed) return
        clearUpdate(pluginId)
        callbacksRef.current.onInstalled?.()
        callbacksRef.current.onOpenChange(false)
      }
    )
  }, [open, pluginId, startInstall, cancel, clearUpdate, resetPresentation])

  function close() {
    onOpenChange(false)
  }

  async function onCancel() {
    if (install.pending && install.consent) return
    if ((await install.cancel()) === false) return
    close()
  }

  async function retry() {
    if (!fixedSource || install.pending) return
    setGrants({})
    if (await install.startInstall(fixedSource)) {
      if (fixedSource.sourceType === 'registry')
        clearUpdate(fixedSource.pluginId)
      onInstalled?.()
      close()
    }
  }

  async function onInstall() {
    if (!install.consent) return
    if (!(await install.confirm(grants))) return
    // A successful commit means the registry entry's version is now
    // installed — drop the "Update to vX" affordance immediately rather
    // than waiting for the next CheckPluginUpdates poll to re-offer a
    // version that's already current (this is a no-op for a fresh install,
    // where the id was never in the updates slice). Builtin updates clear
    // their own slice in BuiltinUpdateDialog; this only covers the
    // community/registry path routed through this dialog.
    if (fixedSource?.sourceType === 'registry') {
      clearUpdate(fixedSource.pluginId)
    }
    onInstalled?.()
    close()
  }

  async function onCheck(args: CheckArgs) {
    if (!callbacksRef.current.open) return
    // Picking a new file mid-review must drop the previous staging dir and
    // its grants — otherwise plugin A's grants would carry into plugin B's
    // consent UI.
    if (install.stagingId) {
      if ((await install.cancel()) === false) return
    }
    setGrants({})
    if (await install.startInstall(args)) close()
  }

  const ffmpegBlocking =
    install.consent?.ffmpegRuntime.requiredByPlugin === 'required' &&
    (install.consent.ffmpegRuntime.available === false ||
      install.consent.ffmpegRuntime.satisfiesRange === false)
  useEffect(() => {
    if (open && install.consent) cancelButtonRef.current?.focus()
  }, [open, install.consent])

  const preparing = open && !!fixedSource && !install.consent && !install.error
  const committing = install.pending && !!install.consent

  const dialogOpen =
    open &&
    (!renderTrigger || !!install.consent || (!inlineErrors && !!install.error))

  return (
    <>
      {renderTrigger?.({
        preparing,
        error: open && !install.consent ? install.error : null,
        cancel: () => void onCancel(),
        retry: () => void retry(),
      })}
      <Dialog
        open={dialogOpen}
        onOpenChange={(v) => !v && void onCancel()}
        onOpenChangeComplete={(next) => {
          if (!next && !callbacksRef.current.open) {
            resetPresentation()
            setGrants({})
          }
        }}
      >
        <DialogContent
          showCloseButton={!committing}
          initialFocus={install.consent ? cancelButtonRef : undefined}
          finalFocus={returnFocusRef}
          className="flex max-h-[min(800px,calc(100dvh-2rem))] w-[540px] max-w-[calc(100vw-2rem)] sm:max-w-[540px] flex-col gap-0 overflow-hidden p-0"
        >
          <DialogHeader className="shrink-0 px-6 pt-6 pb-5 pe-12">
            {install.consent ? (
              <div className="flex items-center gap-3">
                <PluginAvatar plugin={install.consent.manifest} size={48} />
                <DialogTitle className="min-w-0 break-words text-base font-semibold leading-6">
                  {t(
                    install.consent.diff
                      ? 'plugins.consent.upgradeTitle'
                      : 'plugins.consent.installTitle',
                    {
                      name: install.consent.manifest.name,
                      version: install.consent.manifest.version,
                    }
                  )}
                </DialogTitle>
              </div>
            ) : (
              <DialogTitle className="text-base font-semibold">
                {t(
                  fixedSource
                    ? 'plugins.install.install'
                    : 'plugins.install.title'
                )}
              </DialogTitle>
            )}
            <DialogDescription className="mt-1 text-sm leading-6">
              {t(
                fixedSource || install.consent
                  ? 'plugins.install.reviewLead'
                  : 'plugins.install.lead'
              )}
            </DialogDescription>
          </DialogHeader>

          <ScrollArea className="flex min-h-0 min-w-0 flex-1 flex-col">
            <ScrollAreaViewport
              tabIndex={-1}
              className="min-h-0 flex-1 overscroll-contain"
            >
              <ScrollAreaContent
                className="space-y-4 px-6 pb-5"
                style={{ minWidth: '100%' }}
              >
                {install.error && (
                  <Alert
                    variant="destructive"
                    className="mb-4 shadow-none border"
                  >
                    <span className="text-xs">{install.error}</span>
                  </Alert>
                )}

                {preparing && !renderTrigger && (
                  <div
                    role="status"
                    className="flex items-center gap-3 py-6 text-sm text-muted-foreground"
                  >
                    <Spinner aria-hidden="true" />
                    <span>{t('plugins.install.preparing')}</span>
                  </div>
                )}

                {open && !fixedSource && !install.consent && (
                  <PluginInputGroup
                    onCheck={onCheck}
                    checking={install.pending}
                  />
                )}

                {install.consent && (
                  <>
                    <FfmpegRuntimeBlock rt={install.consent.ffmpegRuntime} />
                    <InlineConsentPanel
                      consent={install.consent}
                      grants={grants}
                      onGrantsChange={setGrants}
                      disabled={install.pending}
                    />
                  </>
                )}
              </ScrollAreaContent>
            </ScrollAreaViewport>
            <ScrollBar />
          </ScrollArea>

          <DialogFooter className="shrink-0 flex-row justify-end border-t bg-muted/20 px-6 py-4">
            <Button
              ref={cancelButtonRef}
              variant="outline"
              size="sm"
              onClick={onCancel}
              disabled={committing}
            >
              {t('common.cancel')}
            </Button>
            {fixedSource && install.error && !install.consent && (
              <Button size="sm" onClick={retry} disabled={install.pending}>
                {t('common.retry')}
              </Button>
            )}
            {install.consent && (
              <Button
                size="sm"
                onClick={onInstall}
                data-testid="install-commit-btn"
                disabled={!install.consent || install.pending || ffmpegBlocking}
              >
                {committing && <Spinner aria-hidden="true" />}
                {t('plugins.consent.confirm')}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
