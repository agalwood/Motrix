import { CircleAlertIcon } from 'lucide-react'
import type * as React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { PairCandidate } from '@/background/ConnectionManager'
import { send } from '@/background/MessageBus'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/spinner'
import { assertMessageSucceeded } from '@/options/integration/messages'
import { InstancePicker } from '@/popup/InstancePicker'
import { PairingCodePanel } from '@/popup/PairingCodePanel'
import { connectionErrorKey } from '@/shared/errorCopy'

interface PairingCodeState {
  run: number
  maxRuns: number
  attemptsRemaining: number | null
}

interface PairingDialogProps {
  open: boolean
  remote: boolean
  onOpenChange: (open: boolean) => void
  onPaired: () => void
}

/**
 * Discover → (auto-proceed on one candidate, or let the user choose) →
 * chooseCandidate → poll for the pairingCode prompt bg.getState surfaces →
 * submitPairingCode, repeating for each retry run until success or failure.
 *
 * Never renders "paired"/"connected" before `onPaired()` fires, and
 * `onPaired()` only fires once bg.getState reports `state === 'connected'`
 * — which is only true after a verified `confirmB`, never merely on
 * `pairAccept`.
 */
export function PairingDialog({
  open,
  remote,
  onOpenChange,
  onPaired,
}: PairingDialogProps): React.ReactElement {
  const { t } = useTranslation()
  const [candidates, setCandidates] = useState<PairCandidate[] | null>(null)
  const [scanning, setScanning] = useState(false)
  const [chosen, setChosen] = useState(false)
  const [pairingCode, setPairingCode] = useState<PairingCodeState | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [dialogError, setDialogError] = useState<string | null>(null)
  const remoteAttemptStarted = useRef(false)

  const rescan = useCallback(async (): Promise<void> => {
    setScanning(true)
    setDialogError(null)
    try {
      const response = await send('bg.listPairCandidates', undefined)
      assertMessageSucceeded(response)
      setCandidates(response.candidates)
    } catch {
      setDialogError(t('errors.connection.generic'))
    } finally {
      setScanning(false)
    }
  }, [t])

  useEffect(() => {
    if (!open) {
      remoteAttemptStarted.current = false
      setCandidates(null)
      setChosen(false)
      setPairingCode(null)
      setDialogError(null)
      return
    }
    if (remote) {
      if (remoteAttemptStarted.current) return
      remoteAttemptStarted.current = true
      setChosen(true)
      void send('bg.reconnect', undefined).then((response) => {
        try {
          assertMessageSucceeded(response)
        } catch {
          setDialogError(t('errors.connection.generic'))
        }
      })
      return
    }
    void rescan()
  }, [open, remote, rescan, t])

  const choose = useCallback(
    async (port: number): Promise<void> => {
      setChosen(true)
      setDialogError(null)
      try {
        const response = await send('bg.chooseCandidate', { port })
        assertMessageSucceeded(response)
        if (!response.ok) {
          setDialogError(t('errors.connection.generic'))
        }
      } catch {
        setDialogError(t('errors.connection.generic'))
      }
    },
    [t]
  )

  // A picker with exactly one row to click is friction, not a choice.
  useEffect(() => {
    if (!open || chosen || candidates === null || candidates.length !== 1) {
      return
    }
    const only = candidates[0]
    if (only !== undefined) void choose(only.port)
  }, [open, chosen, candidates, choose])

  // Poll for the pairingCode prompt (or completion/failure) once a
  // candidate has been chosen and the attempt is under way.
  useEffect(() => {
    if (!chosen) return
    let cancelled = false
    const tick = async (): Promise<void> => {
      try {
        const response = await send('bg.getState', undefined)
        assertMessageSucceeded(response)
        if (cancelled) return
        if (response.state === 'connected') {
          onPaired()
          onOpenChange(false)
          return
        }
        if (response.pairingCode) {
          // A live prompt and a failure banner are mutually exclusive: any
          // error still on display belongs to a superseded attempt.
          setDialogError(null)
        } else if (response.state === 'disconnected' && response.lastError) {
          // Locale copy keyed by the stable reason code — the raw
          // `lastError` sentence is developer-facing (same rule as the
          // popup's ConnectionStatusPanel).
          setDialogError(
            t(connectionErrorKey(response.lastErrorReason ?? null))
          )
        }
        setPairingCode(response.pairingCode ?? null)
      } catch {
        // Transient message-channel hiccups aren't worth surfacing on every
        // tick; the next successful poll clears whatever this one missed.
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), 1000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [chosen, onOpenChange, onPaired, t])

  // The MV3 heartbeat exists for exactly this window — while the popup (or,
  // here, this dialog) is showing the code-entry prompt — and must stop the
  // moment it isn't: a heartbeat that outlives its reason keeps the worker
  // alive for nothing. The response body is irrelevant; only the inbound
  // message matters.
  useEffect(() => {
    if (pairingCode === null) return
    const timer = setInterval(() => {
      void send('bg.pairHeartbeat', undefined)
    }, 20_000)
    return () => clearInterval(timer)
  }, [pairingCode])

  const submitCode = useCallback(
    async (code: string): Promise<void> => {
      setSubmitting(true)
      setDialogError(null)
      try {
        const response = await send('bg.submitPairingCode', { code })
        // ok:false is a business outcome (the pending prompt is gone —
        // expired or superseded), not a bus failure; check it BEFORE
        // assertMessageSucceeded, whose error-field duck test would
        // otherwise throw on the very same envelope and misfile it.
        if ((response as { ok?: boolean }).ok === false) {
          setDialogError(t('errors.connection.deadlineExceeded'))
          return
        }
        assertMessageSucceeded(response)
      } catch {
        setDialogError(t('errors.connection.generic'))
      } finally {
        setSubmitting(false)
      }
    },
    [t]
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('options.pairing.pairDialogTitle')}</DialogTitle>
        </DialogHeader>
        {dialogError !== null && (
          <Alert variant="destructive">
            <CircleAlertIcon />
            <AlertDescription>{dialogError}</AlertDescription>
          </Alert>
        )}
        {!remote && !chosen && (
          <InstancePicker
            candidates={candidates ?? []}
            onChoose={(port) => void choose(port)}
            onRescan={() => void rescan()}
            disabled={scanning}
            rescanning={scanning}
          />
        )}
        {chosen && pairingCode === null && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner />
            {t('options.pairing.loading')}
          </div>
        )}
        {chosen && pairingCode !== null && (
          <PairingCodePanel
            onSubmit={(code) => void submitCode(code)}
            size="lg"
            run={pairingCode.run}
            maxRuns={pairingCode.maxRuns}
            attemptsRemaining={pairingCode.attemptsRemaining}
            disabled={submitting}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
