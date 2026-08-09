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
import { cn } from '@renderer/lib/utils'
import type { ConsentPayloadFfmpegRuntime } from '@shared/types/plugin-install'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { InlineConsentPanel } from './components/inline-consent-panel'
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
  fixedSource?: InstallSource
}

export function PluginInstallDialog({
  open,
  onOpenChange,
  fixedSource,
}: Props) {
  const { t } = useTranslation()
  const install = usePluginInstall()
  const clearUpdate = usePluginsStore((s) => s.clearUpdate)
  const [grants, setGrants] = useState<GrantsMap>({})
  const startedRef = useRef(false)

  // biome-ignore lint/correctness/useExhaustiveDependencies: startedRef gates re-entry; install fns are unstable by construction
  useEffect(() => {
    if (!open) {
      startedRef.current = false
      return
    }
    if (!fixedSource || startedRef.current) return
    startedRef.current = true
    setGrants({})
    void install.startInstall(fixedSource)
  }, [open, fixedSource])

  function close() {
    setGrants({})
    onOpenChange(false)
  }

  async function onCancel() {
    await install.cancel()
    close()
  }

  async function onInstall() {
    if (!install.consent) return
    await install.confirm(grants)
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
    close()
  }

  async function onCheck(args: CheckArgs) {
    // Picking a new file mid-review must drop the previous staging dir and
    // its grants — otherwise plugin A's grants would carry into plugin B's
    // consent UI.
    if (install.stagingId) {
      await install.cancel()
    }
    setGrants({})
    await install.startInstall(args)
  }

  const ffmpegBlocking =
    install.consent?.ffmpegRuntime.requiredByPlugin === 'required' &&
    (install.consent.ffmpegRuntime.available === false ||
      install.consent.ffmpegRuntime.satisfiesRange === false)

  return (
    <Dialog open={open} onOpenChange={(v) => !v && close()}>
      <DialogContent className="flex max-h-[min(760px,calc(100vh-2rem))] max-w-[760px] grid-rows-none flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 px-4 pt-4 pb-2">
          <DialogTitle className="text-base">
            {t('plugins.install.title')}
          </DialogTitle>
          <DialogDescription className="text-sm leading-6">
            {t('plugins.install.lead')}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 space-y-4">
          {install.error && (
            <Alert variant="destructive" className="mb-4 shadow-none border">
              <span className="text-xs">{install.error}</span>
            </Alert>
          )}

          {!fixedSource && (
            <PluginInputGroup onCheck={onCheck} checking={install.pending} />
          )}

          {install.consent && (
            <>
              <FfmpegRuntimeBlock rt={install.consent.ffmpegRuntime} />
              <InlineConsentPanel
                consent={install.consent}
                grants={grants}
                onGrantsChange={setGrants}
              />
            </>
          )}
        </div>

        <DialogFooter className="shrink-0 border-t bg-background px-4 py-3">
          <Button variant="outline" size="sm" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button
            size="sm"
            onClick={onInstall}
            data-testid="install-commit-btn"
            disabled={!install.consent || install.pending || ffmpegBlocking}
          >
            {t('plugins.install.install')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
