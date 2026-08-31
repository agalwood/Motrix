import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '@renderer/components/ui/alert'
import { Button } from '@renderer/components/ui/button'
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
} from '@renderer/components/ui/form'
import { Switch } from '@renderer/components/ui/switch'
import { browserDisplayName } from '@renderer/lib/browser-name'
import { cn } from '@renderer/lib/utils'
import type { PairedClientInfo } from '@shared/protocol/bridge'
import { TriangleAlertIcon } from 'lucide-react'
import { useFormContext } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import type { IntegrationFormValues } from './integration-dialog'
import { TrustedExtensionsSection } from './trusted-extensions-section'
import { useBridgeStatus, usePairedExtensions } from './use-bridge'

const IDENTITY_LABEL_KEYS = {
  official: 'settings.integration.browser.pairToast.identityLabel.official',
  'attested-non-official':
    'settings.integration.browser.pairToast.identityLabel.attested',
  unverified: 'settings.integration.browser.pairToast.identityLabel.unverified',
} as const

export function BrowserExtensionsSection() {
  const { t } = useTranslation()
  const form = useFormContext<IntegrationFormValues>()
  const { items: paired, revoke } = usePairedExtensions()
  const status = useBridgeStatus()
  // This section lists browser extensions only; cli/agent clients (device-code
  // paired) are a separate principal kind.
  const pairedExtensions = paired.filter(
    (p): p is Extract<PairedClientInfo, { kind: 'extension' }> =>
      p.kind === 'extension'
  )
  const enabled = form.watch('app.browserBridgeEnabled')

  return (
    <div className="space-y-4">
      <FormField
        control={form.control}
        name="app.browserBridgeEnabled"
        render={({ field }) => (
          <FormItem className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <FormLabel>
                {t('settings.integration.browser.masterSwitch')}
              </FormLabel>
              <FormDescription className="text-xs">
                {t('settings.integration.browser.masterSwitchDesc')}
              </FormDescription>
            </div>
            <FormControl>
              <Switch checked={field.value} onCheckedChange={field.onChange} />
            </FormControl>
          </FormItem>
        )}
      />

      {status?.degraded && (
        <Alert className="border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-4 text-amber-900 dark:text-amber-200">
          <TriangleAlertIcon />
          <AlertTitle>
            {t('settings.integration.browser.degradedPort.title')}
          </AlertTitle>
          <AlertDescription className="text-amber-900/80 dark:text-amber-200/80">
            {t('settings.integration.browser.degradedPort.description', {
              port: status.port,
            })}
          </AlertDescription>
        </Alert>
      )}

      {status?.extensionPairingHealth === 'degraded' && (
        <Alert className="border-destructive/30 bg-destructive/10 px-3 py-2 text-[11px] leading-4 text-destructive">
          <TriangleAlertIcon />
          <AlertTitle>
            {t('settings.integration.browser.pairingStateDegraded.title')}
          </AlertTitle>
          <AlertDescription className="text-destructive/80">
            {t('settings.integration.browser.pairingStateDegraded.description')}
          </AlertDescription>
        </Alert>
      )}

      <div
        className={cn(
          'space-y-2',
          !enabled && 'opacity-50 pointer-events-none'
        )}
      >
        <div className="text-xs font-medium text-foreground">
          {t('settings.integration.browser.pairedTitle')}{' '}
          <span className="text-muted-foreground">
            ({pairedExtensions.length})
          </span>
        </div>
        {pairedExtensions.length === 0 ? (
          <div className="rounded border border-dashed border-border px-3 py-3 text-center text-xs text-muted-foreground">
            {t('settings.integration.browser.pairedEmpty')}
          </div>
        ) : (
          pairedExtensions.map((it) => (
            <div
              key={`${it.browser}:${it.id}`}
              className="flex items-center justify-between rounded border border-border px-3 py-2 text-xs"
            >
              <div className="flex flex-col gap-0.5">
                <span className="font-mono">{it.name || it.id}</span>
                <span className="text-muted-foreground">
                  {browserDisplayName(it.browser)}
                  {` · ${t(IDENTITY_LABEL_KEYS[it.identityTrust])}`}
                  {it.lastActiveAt
                    ? ` · ${t('settings.integration.browser.lastActive')}: ${new Date(it.lastActiveAt).toLocaleString()}`
                    : ''}
                </span>
              </div>
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() =>
                  void revoke({
                    kind: 'extension',
                    browser: it.browser,
                    extensionId: it.id,
                  })
                }
                disabled={it.status === 'cleanup-pending'}
              >
                {t(
                  it.status === 'cleanup-pending'
                    ? 'settings.integration.browser.disconnecting'
                    : 'settings.integration.browser.revoke'
                )}
              </Button>
            </div>
          ))
        )}
      </div>

      <TrustedExtensionsSection disabled={!enabled} />
    </div>
  )
}
