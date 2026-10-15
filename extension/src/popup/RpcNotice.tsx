import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { CopyConnectionDiagnostics } from '@/popup/CopyConnectionDiagnostics'
import { buildConnectionDiagnostics } from '@/popup/connectionDiagnostics'
import type { PopupState } from '@/popup/usePopupState'
import { extensionBrowser } from '@/shared/browser'
import { BUILD_VARIANT } from '@/shared/buildFlags'
import { hasNativeMessagingSupport } from '@/shared/platformCapabilities'

export function RpcNotice({
  state,
  onReconnect,
}: {
  state: PopupState
  onReconnect(): void
}): React.ReactElement | null {
  const { t, i18n } = useTranslation()
  const rpc = state.rpc
  if (!rpc || (rpc.health === 'healthy' && !rpc.lastError)) return null
  const checking = rpc.health === 'checking'
  const report = buildConnectionDiagnostics(state, {
    capturedAt: new Date().toISOString(),
    extensionId: extensionBrowser.runtime.id,
    extensionVersion: extensionBrowser.runtime.getManifest().version,
    build: BUILD_VARIANT,
    userAgent: navigator.userAgent,
    language: i18n.resolvedLanguage ?? i18n.language,
    nativeMessagingApi: hasNativeMessagingSupport(),
  })
  return (
    <div
      className="mt-2 flex shrink-0 items-center gap-2 text-xs"
      role="status"
    >
      <span className="min-w-0 flex-1 text-amber-600 dark:text-amber-400">
        {t(checking ? 'popup.rpc.checking' : 'popup.rpc.failed')}{' '}
        {t('popup.rpc.stale')}
      </span>
      {!checking && (
        <Button size="xs" variant="ghost" onClick={onReconnect}>
          {t('popup.reconnect')}
        </Button>
      )}
      <CopyConnectionDiagnostics text={report} />
    </div>
  )
}
