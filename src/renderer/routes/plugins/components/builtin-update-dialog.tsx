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
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { usePluginsStore } from '../store'

interface Props {
  pluginId: string
  open: boolean
  onOpenChange: (v: boolean) => void
}

type Phase =
  | { kind: 'working' }
  | { kind: 'consent'; stagingId: string; added: string[]; newVersion: string }
  | { kind: 'done'; restartRequired: boolean }
  | { kind: 'error'; message: string }

export function BuiltinUpdateDialog({ pluginId, open, onOpenChange }: Props) {
  const { t } = useTranslation()
  const [phase, setPhase] = useState<Phase>({ kind: 'working' })
  const startedRef = useRef(false)
  const clearUpdate = usePluginsStore((s) => s.clearUpdate)

  useEffect(() => {
    if (!open) {
      startedRef.current = false
      setPhase({ kind: 'working' })
      return
    }
    if (startedRef.current) return
    startedRef.current = true
    void transport
      .invoke(Commands.InstallBuiltinUpdate, { pluginId })
      .then((resp) => {
        const r = resp as {
          needsConsent?: boolean
          stagingId?: string
          added?: string[]
          newVersion?: string
          restartRequired?: boolean
        }
        if (r.needsConsent && r.stagingId) {
          setPhase({
            kind: 'consent',
            stagingId: r.stagingId,
            added: r.added ?? [],
            newVersion: r.newVersion ?? '',
          })
        } else {
          // The overlay commit already happened server-side (main auto-
          // commits when trust didn't change) — the registry version IS
          // installed, so drop the "Update to vX" affordance now rather
          // than waiting for the next CheckPluginUpdates poll to re-offer
          // a version that's already current.
          clearUpdate(pluginId)
          setPhase({ kind: 'done', restartRequired: !!r.restartRequired })
        }
      })
      .catch((e) => {
        setPhase({
          kind: 'error',
          message: e instanceof Error ? e.message : String(e),
        })
      })
  }, [open, pluginId, clearUpdate])

  async function confirm() {
    if (phase.kind !== 'consent') return
    try {
      const resp = (await transport.invoke(Commands.ConfirmBuiltinUpdate, {
        stagingId: phase.stagingId,
      })) as { restartRequired?: boolean }
      clearUpdate(pluginId)
      setPhase({ kind: 'done', restartRequired: !!resp.restartRequired })
    } catch (e) {
      setPhase({
        kind: 'error',
        message: e instanceof Error ? e.message : String(e),
      })
    }
  }

  async function cancel() {
    if (phase.kind === 'consent') {
      try {
        await transport.invoke(Commands.CancelBuiltinUpdate, {
          stagingId: phase.stagingId,
        })
      } catch (e) {
        setPhase({
          kind: 'error',
          message: e instanceof Error ? e.message : String(e),
        })
        return
      }
    }
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && void cancel()}>
      <DialogContent className="max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{t('plugins.registry.builtinUpdateTitle')}</DialogTitle>
          {phase.kind === 'consent' && (
            <DialogDescription>
              {t('plugins.registry.builtinConsentLead')}
            </DialogDescription>
          )}
        </DialogHeader>

        {phase.kind === 'error' && (
          <Alert variant="destructive">
            <span className="text-xs">{phase.message}</span>
          </Alert>
        )}
        {phase.kind === 'consent' && (
          <ul className="list-disc pl-5 font-mono text-xs">
            {phase.added.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        )}
        {phase.kind === 'done' && (
          <p className="text-sm text-muted-foreground">
            {phase.restartRequired
              ? t('plugins.registry.restartRequired')
              : t('plugins.registry.updateInstalled')}
          </p>
        )}

        <DialogFooter>
          {phase.kind === 'consent' ? (
            <>
              <Button variant="outline" size="sm" onClick={() => void cancel()}>
                {t('common.cancel')}
              </Button>
              <Button
                size="sm"
                onClick={() => void confirm()}
                data-testid="builtin-update-confirm"
              >
                {t('plugins.registry.install')}
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={() => onOpenChange(false)}>
              {t('common.close')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
