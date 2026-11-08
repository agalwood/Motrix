import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '@renderer/components/ui/alert'
import { Button } from '@renderer/components/ui/button'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { formatPluginNetworkFailure } from '../lib/network-error'
import { usePluginsStore } from '../store'

export function RegistryNetworkNotice({
  retry,
  pending,
}: {
  retry(): Promise<void>
  pending: boolean
}) {
  const { t } = useTranslation()
  const status = usePluginsStore((state) => state.registryStatus)
  if (!status?.error) return null
  return (
    <Alert>
      <AlertTitle>
        {t(
          status.cached
            ? 'plugins.network.cached'
            : 'plugins.network.unavailable'
        )}
      </AlertTitle>
      <AlertDescription>
        {formatPluginNetworkFailure(t, status.error)}
      </AlertDescription>
      <div className="mt-2 flex gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => void retry()}
        >
          {t('common.retry')}
        </Button>
        <Button size="sm" variant="outline" render={<Link to="/settings" />}>
          {t('nav.settings')}
        </Button>
      </div>
    </Alert>
  )
}
