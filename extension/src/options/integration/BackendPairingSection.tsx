import {
  KeyRoundIcon,
  RefreshCwIcon,
  ServerIcon,
  ShieldCheckIcon,
  Trash2Icon,
} from 'lucide-react'
import type * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { SettingSection } from '@/options/components/SettingSection'

interface BackendPairingSectionProps {
  selectedEndpointName: string
  localBackendUnavailable: boolean
  isRemote: boolean
  pairingLoading: boolean
  paired: boolean
  ready: boolean
  busy: boolean
  onPair: () => void
  onReconnect: () => Promise<void>
  onForget: () => Promise<void>
  children: React.ReactNode
}

export function BackendPairingSection({
  selectedEndpointName,
  localBackendUnavailable,
  isRemote,
  pairingLoading,
  paired,
  ready,
  busy,
  onPair,
  onReconnect,
  onForget,
  children,
}: BackendPairingSectionProps): React.ReactElement {
  const { t } = useTranslation()
  return (
    <SettingSection
      title={t('options.pairing.backendTitle', {
        name: selectedEndpointName,
      })}
      description={t('options.pairing.scopedHelp')}
    >
      {localBackendUnavailable ? (
        <Alert className="gap-y-1">
          <ServerIcon />
          <AlertTitle>{t('options.pairing.serverRequiredTitle')}</AlertTitle>
          <AlertDescription>
            {t('options.pairing.serverRequiredHelp')}
          </AlertDescription>
        </Alert>
      ) : pairingLoading ? (
        <Alert className="gap-y-1">
          <Spinner />
          <AlertTitle>{t('options.pairing.loading')}</AlertTitle>
          <AlertDescription>{t('options.pairing.scopedHelp')}</AlertDescription>
        </Alert>
      ) : isRemote ? (
        <Alert className="gap-y-1">
          {paired ? <ShieldCheckIcon /> : <KeyRoundIcon />}
          <AlertTitle>
            {paired
              ? t('options.pairing.pairedTitle')
              : t('options.pairing.remoteTitle')}
          </AlertTitle>
          <AlertDescription>
            {paired
              ? t('options.pairing.pairedHelp')
              : t('options.pairing.remoteHelp')}
          </AlertDescription>
        </Alert>
      ) : (
        <Alert className="gap-y-1">
          {paired ? <ShieldCheckIcon /> : <KeyRoundIcon />}
          <AlertTitle>
            {paired
              ? t('options.pairing.pairedTitle')
              : t('options.pairing.localTitle')}
          </AlertTitle>
          <AlertDescription>
            {paired
              ? t('options.pairing.pairedHelp')
              : t('options.pairing.localHelp')}
          </AlertDescription>
        </Alert>
      )}
      {children}
      {!localBackendUnavailable && (
        <div className="flex flex-wrap gap-2">
          {!paired && (
            <Button type="button" disabled={!ready || busy} onClick={onPair}>
              <KeyRoundIcon data-icon="inline-start" />
              {t('options.pairing.pair')}
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            disabled={!ready || busy || !paired}
            onClick={() => void onReconnect()}
          >
            {busy && <Spinner data-icon="inline-start" />}
            {!busy && <RefreshCwIcon data-icon="inline-start" />}
            {t('options.pairing.reconnect')}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={!paired || busy}
            onClick={() => void onForget()}
          >
            <Trash2Icon data-icon="inline-start" />
            {t('options.pairing.forget')}
          </Button>
        </div>
      )}
    </SettingSection>
  )
}
